import { fail, error, redirect } from '@sveltejs/kit';
import bcrypt from 'bcryptjs';
import {
	connectDB,
	ReagentLot,
	ReagentProtocolTemplate,
	ReagentInventory,
	AuditLog,
	User,
	generateId
} from '$lib/server/db';
import { requirePermission } from '$lib/server/permissions';
import type { PageServerLoad, Actions } from './$types';

/**
 * Recursive upstream-lot walk. Builds the lineage tree the detail page
 * renders. Capped at depth=4 and tracks seen ids to short-circuit cycles
 * (theoretical — shouldn't happen but cheap safety).
 *
 * Cross-mode traversal: when an input is of source 'reagent_inventory', we
 * fetch the inventory row and follow whichever parent backlink it has:
 *  - preparedFromReagentLotId → recurse into another ReagentLot (BIMS)
 *  - preparedFromExecutionId → render a leaf labelled with the research-v2
 *    execution id (we don't recurse into research-v2 executions from here
 *    because their structure differs; cross-app lineage UI can drill in
 *    via the traceability API).
 *  - Neither set → render as stock/manual leaf.
 *
 * Source 'stock' / 'receiving_lot' / 'manual' render as leaves with no recursion.
 */
type LineageNode = {
	_id: string;
	lotBarcode: string;
	templateName: string;
	templateSlug: string;
	operator: string;
	status: string;
	startedAt: string | null;
	finalizedAt: string | null;
	materialKey?: string;
	// For non-reagent_lot leaves: tag what kind of upstream this is so the UI
	// can render appropriately (e.g., "research-v2 execution", "stock vial").
	leafKind?: 'inventory_stock' | 'inventory_research_v2' | 'stock' | 'receiving_lot' | 'manual';
	leafLabel?: string;
	children: LineageNode[];
	depthCapped?: boolean;
};

async function buildLineage(lot: any, depth = 0, seen = new Set<string>()): Promise<LineageNode> {
	const node: LineageNode = {
		_id: String(lot._id),
		lotBarcode: lot.lotBarcode,
		templateName: lot.templateName,
		templateSlug: lot.templateSlug,
		operator: lot.operator?.username ?? '—',
		status: lot.status,
		startedAt: lot.startedAt ?? null,
		finalizedAt: lot.finalizedAt ?? null,
		children: []
	};
	if (depth >= 4) {
		node.depthCapped = true;
		return node;
	}
	seen.add(String(lot._id));
	for (const il of lot.inputLots ?? []) {
		if (!il.sourceId) continue;
		if (seen.has(il.sourceId)) continue;

		if (il.source === 'reagent_lot') {
			const parent = await ReagentLot.findById(il.sourceId).lean();
			if (!parent) continue;
			const child = await buildLineage(parent, depth + 1, seen);
			child.materialKey = il.materialKey;
			node.children.push(child);
			continue;
		}

		if (il.source === 'reagent_inventory') {
			const inv = (await ReagentInventory.findById(il.sourceId).lean()) as any;
			if (!inv) continue;
			seen.add(String(il.sourceId));

			// Prefer the BIMS-lot backlink; if present, recurse into that lot.
			if (inv.preparedFromReagentLotId) {
				if (seen.has(inv.preparedFromReagentLotId)) continue;
				const parent = await ReagentLot.findById(inv.preparedFromReagentLotId).lean();
				if (parent) {
					const child = await buildLineage(parent, depth + 1, seen);
					child.materialKey = il.materialKey;
					node.children.push(child);
					continue;
				}
			}

			// Research-v2 origin: render as a leaf with enough metadata to
			// link out via the traceability API. We don't recurse into
			// ProtocolExecution from here.
			if (inv.preparedFromExecutionId) {
				node.children.push({
					_id: String(il.sourceId),
					lotBarcode: String(il.sourceId),
					templateName: inv.catalogName ?? il.label ?? '(research-v2 prep)',
					templateSlug: '',
					operator: inv.preparedBy ?? '—',
					status: inv.status ?? 'active',
					startedAt: null,
					finalizedAt: null,
					materialKey: il.materialKey,
					leafKind: 'inventory_research_v2',
					leafLabel: `Prepared via research-v2 execution ${inv.preparedFromExecutionId}`,
					children: []
				});
				continue;
			}

			// Inventory row exists but has no upstream prep — treat as stock vial.
			node.children.push({
				_id: String(il.sourceId),
				lotBarcode: String(il.sourceId),
				templateName: inv.catalogName ?? il.label ?? '(stock vial)',
				templateSlug: '',
				operator: inv.enteredBy ?? '—',
				status: inv.status ?? 'active',
				startedAt: null,
				finalizedAt: null,
				materialKey: il.materialKey,
				leafKind: 'inventory_stock',
				leafLabel: inv.manufacturerLotId
					? `Stock vial (mfr lot ${inv.manufacturerLotId})`
					: 'Stock vial',
				children: []
			});
			continue;
		}

		// 'stock' / 'receiving_lot' / 'manual' — render as leaf with no recursion.
		node.children.push({
			_id: String(il.sourceId),
			lotBarcode: il.barcode ?? String(il.sourceId),
			templateName: il.label ?? il.source ?? '(input)',
			templateSlug: '',
			operator: '—',
			status: '',
			startedAt: null,
			finalizedAt: null,
			materialKey: il.materialKey,
			leafKind: il.source as 'stock' | 'receiving_lot' | 'manual',
			leafLabel: il.label ?? il.source ?? '',
			children: []
		});
	}
	return node;
}

export const load: PageServerLoad = async ({ params, locals }) => {
	requirePermission(locals.user, 'manufacturing:read');
	await connectDB();

	const lot = await ReagentLot.findById(params.lotId).lean();
	if (!lot) throw error(404, 'Lot not found');

	const template = await ReagentProtocolTemplate.findById((lot as any).templateId).lean();
	if (!template) throw error(404, 'Protocol template not found for this lot');

	const candidateLots = await ReagentLot.find({
		status: 'finalized',
		_id: { $ne: (lot as any)._id }
	})
		.select('_id lotBarcode templateName templateSlug')
		.sort({ finalizedAt: -1 })
		.limit(200)
		.lean();

	const lineage = await buildLineage(lot);

	// Output inventory tubes produced by this lot (finalize creates these).
	// Two-way lookup: outputs[] subdoc on the lot AND reverse-lookup against
	// reagent_inventory for completeness (covers aliquots added post-finalize).
	const outputTubes = await ReagentInventory.find({ preparedFromReagentLotId: (lot as any)._id })
		.select(
			'_id catalogId catalogName concentration concentrationUnit volume initialVolume status location preparedDate preparedBy source'
		)
		.sort({ createdAt: 1 })
		.lean();

	return {
		lot: JSON.parse(JSON.stringify(lot)),
		template: JSON.parse(JSON.stringify(template)),
		candidateLots: JSON.parse(JSON.stringify(candidateLots)),
		lineage: JSON.parse(JSON.stringify(lineage)),
		outputTubes: JSON.parse(JSON.stringify(outputTubes))
	};
};

function notEditable(lot: any) {
	if (lot.status === 'finalized') {
		return fail(400, { error: 'Lot is finalized. Edits go through corrections.' });
	}
	if (lot.status === 'voided') {
		return fail(400, { error: 'Lot is voided.' });
	}
	return null;
}

async function ensureLot(lotId: string) {
	const lot = await ReagentLot.findById(lotId);
	if (!lot) throw error(404, 'Lot not found');
	return lot;
}

export const actions: Actions = {
	/**
	 * Update lot-level setup: lot barcode, key parameters, input/stock lots.
	 * R&D flexibility — every field is editable while the lot is in_progress.
	 * Nothing is required; blanks are preserved. Sacred middleware locks
	 * mutations once `finalizedAt` is set.
	 */
	saveSetup: async ({ request, params, locals }) => {
		requirePermission(locals.user, 'manufacturing:write');
		await connectDB();
		const lot = await ensureLot(params.lotId!);
		const blocked = notEditable(lot);
		if (blocked) return blocked;

		const data = await request.formData();
		const lotBarcode = data.get('lotBarcode')?.toString().trim();
		const parameterValuesJson = data.get('parameterValues')?.toString() ?? '[]';
		const inputLotsJson = data.get('inputLots')?.toString() ?? '[]';

		if (lotBarcode && lotBarcode !== lot.lotBarcode) {
			const dup = await ReagentLot.findOne({ lotBarcode, _id: { $ne: lot._id } }).select('_id').lean();
			if (!dup) lot.lotBarcode = lotBarcode;
		}

		try {
			const params = JSON.parse(parameterValuesJson);
			const inputs = JSON.parse(inputLotsJson);
			lot.parameterValues = params;
			lot.inputLots = inputs.map((i: any) => ({ ...i, recordedAt: i.recordedAt ?? new Date() }));
		} catch {
			return fail(400, { error: 'Malformed setup payload.' });
		}

		await lot.save();

		await AuditLog.create({
			_id: generateId(),
			action: 'UPDATE',
			tableName: 'reagent_lots',
			recordId: lot._id,
			changedBy: locals.user!.username,
			changedAt: new Date(),
			newData: { setupUpdated: true }
		});

		return { success: true };
	},

	/** Upsert a step entry (qc readings, observations, note, completed flag). */
	saveStep: async ({ request, params, locals }) => {
		requirePermission(locals.user, 'manufacturing:write');
		await connectDB();
		const lot = await ensureLot(params.lotId!);
		const blocked = notEditable(lot);
		if (blocked) return blocked;

		const data = await request.formData();
		const stepKey = data.get('stepKey')?.toString();
		const stepNumber = Number(data.get('stepNumber') ?? 0);
		const stepTitle = data.get('stepTitle')?.toString() ?? '';
		const markCompleted = data.get('markCompleted') === 'on';
		const note = data.get('note')?.toString() ?? '';
		const readingsJson = data.get('readings')?.toString() ?? '[]';
		const observationsJson = data.get('observations')?.toString() ?? '[]';

		if (!stepKey) return fail(400, { error: 'stepKey is required' });

		let readings: any[] = [];
		let observations: any[] = [];
		try {
			readings = JSON.parse(readingsJson);
			observations = JSON.parse(observationsJson);
		} catch {
			return fail(400, { error: 'Malformed readings or observations payload' });
		}

		const now = new Date();
		const operator = { _id: locals.user!._id, username: locals.user!.username };

		// Read-then-rewrite so editing an existing step preserves startedAt etc.
		const existing = (lot.stepEntries ?? []).find((s: any) => s.stepKey === stepKey);
		const startedAt = existing?.startedAt ?? now;

		const flagged = readings.some((r: any) => r.flag === 'out-of-range');

		const stepEntry = {
			_id: existing?._id ?? generateId(),
			stepKey,
			stepNumber,
			stepTitle,
			startedAt,
			completedAt: markCompleted ? now : existing?.completedAt,
			completedBy: markCompleted ? operator : existing?.completedBy,
			qcReadings: readings.map((r: any) => ({
				...r,
				enteredBy: operator,
				enteredAt: r.enteredAt ? new Date(r.enteredAt) : now
			})),
			observations: observations.map((o: any) => ({
				_id: o._id ?? generateId(),
				promptKey: o.promptKey,
				body: o.body,
				concern: !!o.concern,
				enteredBy: operator,
				enteredAt: o.enteredAt ? new Date(o.enteredAt) : now,
				updatedAt: now
			})),
			note,
			flagged: flagged || observations.some((o: any) => o.concern && o.body?.trim())
		};

		// Rebuild step entries: replace existing entry or append.
		const next = (lot.stepEntries ?? []).filter((s: any) => s.stepKey !== stepKey);
		next.push(stepEntry);
		next.sort((a: any, b: any) => (a.stepNumber ?? 0) - (b.stepNumber ?? 0));
		lot.stepEntries = next;

		// Rebuild flags list — drop existing flags from this step, re-add from current readings
		// + any operator-flagged "concern" observations.
		const otherFlags = (lot.flags ?? []).filter((f: any) => f.stepKey !== stepKey);
		const newFlags = readings
			.filter((r: any) => r.flag === 'out-of-range')
			.map((r: any) => ({
				_id: generateId(),
				source: 'qc',
				stepKey,
				checkpointKey: r.checkpointKey,
				reason: `${r.label ?? r.checkpointKey} = ${r.value}${r.unit ?? ''} outside expected range`,
				createdAt: now
			}));
		const concernFlags = observations
			.filter((o: any) => o.concern && o.body?.trim())
			.map((o: any) => ({
				_id: generateId(),
				source: 'observation',
				stepKey,
				checkpointKey: o.promptKey,
				reason: `Operator-flagged concern${o.promptKey ? ` (${o.promptKey})` : ''}: ${o.body}`,
				createdAt: now
			}));
		lot.flags = [...otherFlags, ...newFlags, ...concernFlags];

		await lot.save();

		await AuditLog.create({
			_id: generateId(),
			action: 'UPDATE',
			tableName: 'reagent_lots',
			recordId: lot._id,
			changedBy: locals.user!.username,
			changedAt: now,
			newData: { stepKey, completed: markCompleted, flaggedReadings: newFlags.length }
		});

		return { success: true };
	},

	/** Add or update a lot-level note (editable until finalize). */
	saveLotNote: async ({ request, params, locals }) => {
		requirePermission(locals.user, 'manufacturing:write');
		await connectDB();
		const lot = await ensureLot(params.lotId!);
		const blocked = notEditable(lot);
		if (blocked) return blocked;

		const data = await request.formData();
		const noteId = data.get('noteId')?.toString();
		const body = data.get('body')?.toString() ?? '';
		const remove = data.get('remove') === 'on';

		const now = new Date();
		const author = { _id: locals.user!._id, username: locals.user!.username };

		if (remove && noteId) {
			lot.lotNotes = (lot.lotNotes ?? []).filter((n: any) => n._id !== noteId);
		} else if (noteId) {
			lot.lotNotes = (lot.lotNotes ?? []).map((n: any) =>
				n._id === noteId ? { ...n, body, updatedAt: now } : n
			);
		} else {
			lot.lotNotes = [...(lot.lotNotes ?? []), { _id: generateId(), body, author, createdAt: now, updatedAt: now }];
		}

		await lot.save();
		return { success: true };
	},

	/** Save final observations + outputs (single combined save). */
	saveFinal: async ({ request, params, locals }) => {
		requirePermission(locals.user, 'manufacturing:write');
		await connectDB();
		const lot = await ensureLot(params.lotId!);
		const blocked = notEditable(lot);
		if (blocked) return blocked;

		const data = await request.formData();
		const finalObservations = data.get('finalObservations')?.toString() ?? '';
		const concentration = data.get('concentration')?.toString();
		const concentrationUnit = data.get('concentrationUnit')?.toString();
		const volume = data.get('volume')?.toString();
		const volumeUnit = data.get('volumeUnit')?.toString();
		const outputNotes = data.get('outputNotes')?.toString() ?? '';

		lot.finalObservations = finalObservations;
		lot.finalOutputs = {
			concentration: concentration ? Number(concentration) : undefined,
			concentrationUnit,
			volume: volume ? Number(volume) : undefined,
			volumeUnit,
			notes: outputNotes
		};

		await lot.save();
		return { success: true };
	},

	/**
	 * Finalize the lot. Physical barcode flow:
	 *  - Operator has labelled 0+ output tubes with physical barcodes.
	 *  - Form submits `outputs` as a JSON array of
	 *    { barcode, outputSpecKey?, concentration?, concentrationUnit?,
	 *      volume?, volumeUnit?, notes? }.
	 *  - For each entry with a non-empty barcode, this action creates a
	 *    ReagentInventory row (`_id = barcode`, `type='prepared'`,
	 *    `preparedFromReagentLotId = lot._id`, `source='bims'`, catalog
	 *    resolved from template.outputSpec(s)).
	 *  - Empty outputs[] is valid (lot finalizes without producing any
	 *    tubes — e.g., a failed run that still needs to be locked).
	 *  - Then status flips to 'finalized', finalizedAt is set, and sacred
	 *    middleware locks subsequent mutations except via corrections[].
	 *
	 * Catalog resolution per output:
	 *   - If output.outputSpecKey is provided, match against
	 *     template.outputSpecs[].key for catalogId.
	 *   - Otherwise fall back to template.outputSpec.catalogId.
	 *   - If neither resolves, output is rejected (operator must finish
	 *     authoring the template before finalizing real lots against it).
	 */
	finalize: async ({ request, params, locals }) => {
		requirePermission(locals.user, 'manufacturing:write');
		await connectDB();
		const lot = await ensureLot(params.lotId!);
		if (lot.status === 'finalized') return { success: true, alreadyFinal: true };
		if (lot.status === 'voided') return fail(400, { error: 'Cannot finalize a voided lot.' });

		const data = await request.formData();
		const outputsJson = data.get('outputs')?.toString() ?? '[]';
		let outputs: Array<{
			barcode?: string;
			outputSpecKey?: string;
			concentration?: number;
			concentrationUnit?: string;
			volume?: number;
			volumeUnit?: string;
			notes?: string;
		}> = [];
		try {
			const parsed = JSON.parse(outputsJson);
			if (!Array.isArray(parsed)) throw new Error('outputs must be an array');
			outputs = parsed;
		} catch (e) {
			return fail(400, { error: `Malformed outputs payload: ${(e as Error).message}` });
		}

		// Filter to non-empty barcodes only — empties are dropped, not errors.
		const tubes = outputs
			.map((o) => ({ ...o, barcode: o.barcode?.trim() ?? '' }))
			.filter((o) => o.barcode.length > 0);

		// Validate uniqueness within the submission.
		const seen = new Set<string>();
		for (const t of tubes) {
			if (seen.has(t.barcode)) {
				return fail(400, { error: `Duplicate barcode in submission: ${t.barcode}` });
			}
			seen.add(t.barcode);
		}

		// Resolve catalog for each tube before any writes.
		const template = await ReagentProtocolTemplate.findById((lot as any).templateId).lean();
		if (!template) {
			return fail(400, { error: 'Template missing — cannot resolve output catalog.' });
		}
		const outputSpecs = ((template as any).outputSpecs ?? []) as Array<{
			key: string;
			catalogId?: string;
		}>;
		const fallbackCatalogId = (template as any).outputSpec?.catalogId ?? '';

		const resolved: Array<{ tube: (typeof tubes)[number]; catalogId: string }> = [];
		for (const tube of tubes) {
			let catalogId = '';
			if (tube.outputSpecKey) {
				const spec = outputSpecs.find((s) => s.key === tube.outputSpecKey);
				catalogId = spec?.catalogId ?? '';
			}
			if (!catalogId) catalogId = fallbackCatalogId;
			if (!catalogId) {
				return fail(400, {
					error: `Cannot resolve catalogId for output barcode ${tube.barcode}. Template's outputSpec(s) need a catalogId.`
				});
			}
			resolved.push({ tube, catalogId });
		}

		// Validate barcodes aren't already in inventory.
		if (resolved.length > 0) {
			const existing = await ReagentInventory.find({ _id: { $in: resolved.map((r) => r.tube.barcode) } })
				.select('_id')
				.lean();
			if (existing.length > 0) {
				const dupes = existing.map((e: any) => e._id).join(', ');
				return fail(400, { error: `Barcodes already exist in inventory: ${dupes}` });
			}
		}

		const now = new Date();
		const operatorRefDoc = { _id: locals.user!._id, username: locals.user!.username };

		// Create inventory rows BEFORE locking the lot. If any insert fails,
		// the lot stays in_progress and the operator can retry.
		for (const { tube, catalogId } of resolved) {
			await ReagentInventory.create({
				_id: tube.barcode,
				catalogId,
				catalogName: '', // backfill from catalog lookup is a follow-up; not blocking
				type: 'prepared',
				preparedFromReagentLotId: lot._id,
				preparedDate: now.toISOString().slice(0, 10),
				preparedBy: locals.user!.username,
				concentration: tube.concentration,
				concentrationUnit: tube.concentrationUnit ?? '',
				volume: tube.volume,
				initialVolume: tube.volume,
				status: 'active',
				source: 'bims',
				notes: tube.notes ?? '',
				enteredBy: locals.user!.username,
				enteredDate: now.toISOString().slice(0, 10)
			});
		}

		// Stamp outputs[] on the lot for self-contained record-keeping.
		lot.outputs = resolved.map(({ tube, catalogId }) => ({
			barcode: tube.barcode,
			outputSpecKey: tube.outputSpecKey ?? '',
			catalogId,
			concentration: tube.concentration,
			concentrationUnit: tube.concentrationUnit ?? '',
			volume: tube.volume,
			volumeUnit: tube.volumeUnit ?? '',
			notes: tube.notes ?? '',
			createdAt: now
		})) as any;

		lot.status = 'finalized';
		lot.finalizedAt = now;
		await lot.save();

		await AuditLog.create({
			_id: generateId(),
			action: 'UPDATE',
			tableName: 'reagent_lots',
			recordId: lot._id,
			changedBy: locals.user!.username,
			changedAt: now,
			newData: {
				status: 'finalized',
				outputCount: resolved.length,
				outputBarcodes: resolved.map((r) => r.tube.barcode)
			}
		});

		// One audit row per inventory row created — symmetrical to other
		// inventory write paths.
		for (const { tube } of resolved) {
			await AuditLog.create({
				_id: generateId(),
				action: 'CREATE',
				tableName: 'reagent_inventory',
				recordId: tube.barcode,
				changedBy: locals.user!.username,
				changedAt: now,
				newData: {
					preparedFromReagentLotId: lot._id,
					source: 'bims',
					trigger: 'lot_finalize'
				}
			});
		}

		return { success: true, outputsCreated: resolved.length };
	},

	/**
	 * Soft-delete a lot. Requires the operator to re-enter their own password
	 * (bcrypt-verified) to confirm. Sacred middleware blocks delete operations
	 * outright, so the soft-delete writes through the native MongoDB driver
	 * via `Model.collection.updateOne` — this is the intentional admin
	 * override path for finalized lots too. Status flips to 'deleted'; the
	 * record stays in Mongo so we have an audit trail.
	 */
	deleteLot: async ({ request, params, locals }) => {
		requirePermission(locals.user, 'manufacturing:write');
		await connectDB();

		const data = await request.formData();
		const adminPassword = data.get('adminPassword')?.toString() ?? '';
		const reason = data.get('reason')?.toString() ?? '';

		if (!adminPassword) {
			return fail(401, { error: 'Admin password is required to delete a lot.' });
		}

		// Re-fetch user with password hash (locals.user has it stripped).
		const fullUser = await User.findById(locals.user!._id).select('passwordHash username').lean();
		const hash = (fullUser as any)?.passwordHash;
		if (!hash) return fail(401, { error: 'Could not verify user — please log out and back in.' });

		const ok = await bcrypt.compare(adminPassword, hash);
		if (!ok) return fail(401, { error: 'Password did not match.' });

		const lot = await ReagentLot.findById(params.lotId!).select('_id status').lean();
		if (!lot) throw error(404, 'Lot not found');

		const now = new Date();
		// Native collection write — bypasses sacred middleware so the admin
		// override works even on finalized lots.
		await ReagentLot.collection.updateOne(
			{ _id: (lot as any)._id },
			{
				$set: {
					status: 'deleted',
					deletedAt: now,
					deletedBy: { _id: locals.user!._id, username: locals.user!.username },
					deleteReason: reason
				}
			}
		);

		await AuditLog.create({
			_id: generateId(),
			action: 'DELETE',
			tableName: 'reagent_lots',
			recordId: (lot as any)._id,
			changedBy: locals.user!.username,
			changedAt: now,
			newData: {
				status: 'deleted',
				reason,
				previousStatus: (lot as any).status,
				note: 'soft-delete via admin password'
			}
		});

		throw redirect(303, '/manufacturing/reagent-lots');
	},

	/** Void a lot. Sacred middleware does not block this because finalizedAt isn't set. */
	void: async ({ request, params, locals }) => {
		requirePermission(locals.user, 'manufacturing:write');
		await connectDB();
		const lot = await ensureLot(params.lotId!);
		if (lot.status !== 'in_progress') return fail(400, { error: 'Only in-progress lots can be voided.' });

		const data = await request.formData();
		const reason = data.get('reason')?.toString() ?? '';

		const now = new Date();
		lot.status = 'voided';
		lot.voidedAt = now;
		lot.voidReason = reason;
		await lot.save();

		await AuditLog.create({
			_id: generateId(),
			action: 'UPDATE',
			tableName: 'reagent_lots',
			recordId: lot._id,
			changedBy: locals.user!.username,
			changedAt: now,
			newData: { status: 'voided', voidReason: reason }
		});

		return { success: true };
	}
};
