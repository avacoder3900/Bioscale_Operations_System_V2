import { fail } from '@sveltejs/kit';
import { requirePermission } from '$lib/server/permissions';
import {
	connectDB,
	AssayDefinition,
	CartridgeRecord,
	CartridgeGroup,
	AuditLog,
	generateId
} from '$lib/server/db';
import { analyzeCartridge } from '$lib/server/optical-analysis';
import {
	OPTICAL_ASSAY_ID,
	OPTICAL_CARTRIDGE_FILTER,
	isGroupColorKey,
	nextGroupColor
} from '$lib/server/optical-constants';
import type { Actions, PageServerLoad } from './$types';

/** Split a comma/whitespace-separated id list from a form field. */
function parseIds(raw: FormDataEntryValue | null): string[] {
	const s = raw?.toString().trim();
	if (!s) return [];
	return [...new Set(s.split(/[\s,]+/).map((x) => x.trim()).filter(Boolean))];
}

/**
 * Confirm every id really is an optical cartridge before it joins a group — keeps a
 * mistyped or pasted barcode from silently landing in an analysis cohort.
 */
async function validateOpticalIds(
	ids: string[]
): Promise<{ ok: true; ids: string[] } | { ok: false; unknown: string[] }> {
	const found = await CartridgeRecord.find({
		_id: { $in: ids },
		...OPTICAL_CARTRIDGE_FILTER
	})
		.select('_id')
		.lean();
	const valid = new Set(found.map((f: any) => f._id as string));
	const unknown = ids.filter((id) => !valid.has(id));
	if (unknown.length > 0) return { ok: false, unknown };
	return { ok: true, ids };
}

export const load: PageServerLoad = async ({ locals }) => {
	requirePermission(locals.user, 'cartridge:read');
	await connectDB();

	// Only the one optical assay we run.
	const assays = await AssayDefinition.find({ _id: OPTICAL_ASSAY_ID })
		.select('name skuCode duration BCODE.code')
		.lean();

	// Optical test cartridge log — read run status from cartridge_records (where the
	// device/brevitest-cloud writes the run lifecycle: linked -> underway -> completed).
	// See OPTICAL_CARTRIDGE_FILTER for why comparators are merged in.
	// Read-only: nothing is written back to tag or reclassify these records.
	const cartridges = await CartridgeRecord.find(OPTICAL_CARTRIDGE_FILTER)
		.select(
			'serialNumber assayId assayName assayCategory status statusUpdatedOn checkpoints createdAt analysis rawData device'
		)
		.sort({ createdAt: -1 })
		.limit(200)
		.lean();

	// Analysis cohorts. `?? []` because .lean() does NOT apply schema defaults, so
	// groups created before cartridgeIds existed come back with the field missing.
	const groupDocs = await CartridgeGroup.find({
		purpose: 'optical_analysis',
		archivedAt: null
	})
		.select('_id name description color cartridgeIds')
		.sort({ createdAt: 1 })
		.lean();

	const groups = groupDocs.map((g: any) => ({
		id: g._id,
		name: g.name ?? '(unnamed)',
		description: g.description ?? null,
		color: isGroupColorKey(g.color) ? g.color : 'cyan',
		cartridgeIds: (g.cartridgeIds ?? []) as string[],
		count: (g.cartridgeIds ?? []).length
	}));

	// cartridgeId -> its group, for the Group column. One group per cartridge is
	// enforced in saveGroup, so a plain Map is sufficient.
	const groupByCartridge = new Map<string, { id: string; name: string; color: string }>();
	for (const g of groups) {
		for (const cid of g.cartridgeIds) {
			groupByCartridge.set(cid, { id: g.id, name: g.name, color: g.color });
		}
	}

	return {
		assays: assays.map((a: any) => ({
			id: a._id,
			name: a.name,
			skuCode: a.skuCode ?? a._id,
			duration: a.duration ?? null,
			bcodeSteps: Array.isArray(a.BCODE?.code) ? a.BCODE.code.length : 0
		})),
		groups: groups.map((g) => ({
			id: g.id,
			name: g.name,
			description: g.description,
			color: g.color,
			count: g.count
		})),
		cartridges: cartridges.map((c: any) => {
			// Derive-on-read F7/F3 analysis (non-destructive; never written to the DB).
			const analysis = analyzeCartridge(c.rawData?.readings ?? []);
			return {
				// Trimmed analysis for the list view (full analysis lives on the detail page).
				analysis: analysis
					? {
							ratioByChannel: analysis.ratioByChannel,
							warning: analysis.warning,
							crossWellCv: analysis.crossWellCv
						}
					: null,
				id: c._id,
				barcode: c._id, // cartridge_records _id IS the scanned barcode
				assayName: c.assayName ?? c.assayId ?? null,
				// true = formally assigned as a validation cartridge via this page;
				// false = same-assay run pulled in as a comparator.
				assigned: c.assayCategory === 'optical_test',
				status: c.status ?? 'linked',
				ran: !!(c.checkpoints?.completed || c.checkpoints?.underway || c.status === 'completed'),
				// The run writes a `device` block — its name is the SPU/reader it ran on.
				spuUdi: c.device?.name ?? null,
				spuDeviceId: c.device?.id ?? null,
				group: groupByCartridge.get(c._id) ?? null,
				assignedAt: c.createdAt?.toISOString?.() ?? null,
				underwayAt: c.checkpoints?.underway?.when ?? null,
				completedAt: c.checkpoints?.completed?.when ?? null,
				result: c.analysis
					? {
							profileName: c.analysis.profileName ?? null,
							computedAt: c.analysis.computedAt ?? null
						}
					: null
			};
		})
	};
};

export const actions: Actions = {
	// Assign an assay as N optical-confirmation validation cartridges. Delegates to
	// the canonical API so the page and any device/scanner share one code path.
	assign: async ({ request, locals, fetch }) => {
		requirePermission(locals.user, 'cartridge:write');
		await connectDB();

		const form = await request.formData();
		const assayId = form.get('assayId')?.toString().trim();
		const countRaw = form.get('count')?.toString().trim();
		const barcodesRaw = form.get('barcodes')?.toString().trim();
		const groupName = form.get('groupName')?.toString().trim() || undefined;

		if (!assayId) return fail(400, { error: 'Select an assay' });

		const barcodes = barcodesRaw
			? barcodesRaw.split(/[\s,]+/).map((b) => b.trim()).filter(Boolean)
			: undefined;
		const count = !barcodes && countRaw ? Number(countRaw) : undefined;

		if (!barcodes && (!count || count < 1)) {
			return fail(400, { error: 'Enter a count or scan/paste barcodes' });
		}

		const res = await fetch('/api/validation/optical-confirmation/assign', {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({ assayId, count, barcodes, groupName })
		});
		const data = await res.json();
		if (!res.ok || !data.success)
			return fail(res.status === 200 ? 400 : res.status, {
				error: data.error ?? 'Assign failed'
			});

		return {
			success: true,
			createdCount: data.createdCount,
			skipped: data.skipped ?? [],
			bcodeSteps: data.bcodeSteps,
			assayName: data.assay?.name ?? assayId
		};
	},

	/**
	 * Save the checked selection as a named analysis group, or append it to an
	 * existing one (mode=append + groupId).
	 *
	 * A cartridge belongs to exactly one group: counting the same cartridge in two
	 * groups would corrupt the between-group medians. Adding therefore removes it
	 * from any other group, and the response reports what moved.
	 *
	 * Never touches cartridge_records.
	 */
	saveGroup: async ({ request, locals }) => {
		requirePermission(locals.user, 'cartridge:write');
		await connectDB();

		const form = await request.formData();
		const name = form.get('name')?.toString().trim() ?? '';
		const description = form.get('description')?.toString().trim() || undefined;
		const colorRaw = form.get('color')?.toString().trim();
		const mode = form.get('mode')?.toString().trim();
		const groupId = form.get('groupId')?.toString().trim();
		const ids = parseIds(form.get('cartridgeIds'));

		if (ids.length === 0) {
			return fail(400, { groupError: 'Select at least one cartridge first.' });
		}

		const checked = await validateOpticalIds(ids);
		if (!checked.ok) {
			return fail(400, {
				groupError: `Not optical cartridges: ${checked.unknown.slice(0, 5).join(', ')}${
					checked.unknown.length > 5 ? ` (+${checked.unknown.length - 5} more)` : ''
				}`
			});
		}

		let target: any;
		if (mode === 'append' && groupId) {
			target = await CartridgeGroup.findOne({
				_id: groupId,
				purpose: 'optical_analysis',
				archivedAt: null
			});
			if (!target) return fail(404, { groupError: 'That group no longer exists.' });
		} else {
			if (!name) return fail(400, { groupError: 'Group name is required.' });

			// Do NOT silently merge into a same-named group — two operators typing the
			// same name would pool their cartridges without either of them knowing.
			const existing = await CartridgeGroup.findOne({
				name,
				purpose: 'optical_analysis',
				archivedAt: null
			})
				.select('_id name cartridgeIds')
				.lean();
			if (existing) {
				return fail(409, {
					groupError: `A group named "${name}" already exists (${
						((existing as any).cartridgeIds ?? []).length
					} cartridges).`,
					existingGroupId: (existing as any)._id,
					existingGroupName: name
				});
			}

			const usedColors = (
				await CartridgeGroup.find({ purpose: 'optical_analysis', archivedAt: null })
					.select('color')
					.lean()
			).map((g: any) => g.color);

			target = await CartridgeGroup.create({
				_id: generateId(),
				name,
				description,
				color: isGroupColorKey(colorRaw) ? colorRaw : nextGroupColor(usedColors),
				purpose: 'optical_analysis',
				cartridgeIds: [],
				createdBy: locals.user!._id
			});
		}

		// One group per cartridge: take these out of whichever group held them.
		const others = await CartridgeGroup.find({
			purpose: 'optical_analysis',
			archivedAt: null,
			_id: { $ne: target._id },
			cartridgeIds: { $in: checked.ids }
		})
			.select('_id name cartridgeIds')
			.lean();

		const movedFrom = others.map((o: any) => ({
			name: o.name,
			count: (o.cartridgeIds ?? []).filter((id: string) => checked.ids.includes(id)).length
		}));

		if (others.length > 0) {
			await CartridgeGroup.updateMany(
				{ _id: { $in: others.map((o: any) => o._id) } },
				{ $pull: { cartridgeIds: { $in: checked.ids } } }
			);
		}

		const before: string[] = (target.cartridgeIds ?? []) as string[];
		await CartridgeGroup.updateOne(
			{ _id: target._id },
			{ $addToSet: { cartridgeIds: { $each: checked.ids } } }
		);
		const after = await CartridgeGroup.findById(target._id).select('cartridgeIds name').lean();
		const afterIds: string[] = ((after as any)?.cartridgeIds ?? []) as string[];

		await AuditLog.create({
			_id: generateId(),
			tableName: 'cartridge_groups',
			recordId: target._id,
			action: mode === 'append' && groupId ? 'UPDATE' : 'CREATE',
			oldData: { cartridgeIds: before },
			newData: { name: (after as any)?.name ?? name, cartridgeIds: afterIds },
			changedBy: locals.user!._id,
			changedAt: new Date(),
			reason:
				mode === 'append' && groupId
					? 'Add cartridges to optical analysis group'
					: 'Create optical analysis group'
		});

		return {
			groupSaved: true,
			groupId: target._id as string,
			groupName: ((after as any)?.name ?? name) as string,
			addedCount: afterIds.length - before.length,
			totalCount: afterIds.length,
			movedFrom
		};
	},

	renameGroup: async ({ request, locals }) => {
		requirePermission(locals.user, 'cartridge:write');
		await connectDB();

		const form = await request.formData();
		const groupId = form.get('groupId')?.toString().trim();
		const name = form.get('name')?.toString().trim();
		const description = form.get('description')?.toString().trim();
		const colorRaw = form.get('color')?.toString().trim();

		if (!groupId) return fail(400, { groupError: 'Missing group.' });
		if (!name) return fail(400, { groupError: 'Group name is required.' });

		const existing = await CartridgeGroup.findOne({
			_id: groupId,
			purpose: 'optical_analysis',
			archivedAt: null
		})
			.select('_id name description color')
			.lean();
		if (!existing) return fail(404, { groupError: 'That group no longer exists.' });

		const clash = await CartridgeGroup.findOne({
			name,
			purpose: 'optical_analysis',
			archivedAt: null,
			_id: { $ne: groupId }
		})
			.select('_id')
			.lean();
		if (clash) return fail(409, { groupError: `A group named "${name}" already exists.` });

		const update: Record<string, unknown> = { name };
		if (description !== undefined) update.description = description;
		if (isGroupColorKey(colorRaw)) update.color = colorRaw;

		await CartridgeGroup.updateOne({ _id: groupId }, { $set: update });

		await AuditLog.create({
			_id: generateId(),
			tableName: 'cartridge_groups',
			recordId: groupId,
			action: 'UPDATE',
			oldData: {
				name: (existing as any).name,
				description: (existing as any).description,
				color: (existing as any).color
			},
			newData: update,
			changedBy: locals.user!._id,
			changedAt: new Date(),
			reason: 'Rename optical analysis group'
		});

		return { groupSaved: true, groupId, groupName: name };
	},

	removeFromGroup: async ({ request, locals }) => {
		requirePermission(locals.user, 'cartridge:write');
		await connectDB();

		const form = await request.formData();
		const groupId = form.get('groupId')?.toString().trim();
		const ids = parseIds(form.get('cartridgeIds'));

		if (!groupId) return fail(400, { groupError: 'Missing group.' });
		if (ids.length === 0) return fail(400, { groupError: 'Select at least one cartridge.' });

		const existing = await CartridgeGroup.findOne({
			_id: groupId,
			purpose: 'optical_analysis',
			archivedAt: null
		})
			.select('_id name cartridgeIds')
			.lean();
		if (!existing) return fail(404, { groupError: 'That group no longer exists.' });

		const before: string[] = ((existing as any).cartridgeIds ?? []) as string[];
		await CartridgeGroup.updateOne({ _id: groupId }, { $pull: { cartridgeIds: { $in: ids } } });
		const after = before.filter((id) => !ids.includes(id));

		await AuditLog.create({
			_id: generateId(),
			tableName: 'cartridge_groups',
			recordId: groupId,
			action: 'UPDATE',
			oldData: { cartridgeIds: before },
			newData: { cartridgeIds: after },
			changedBy: locals.user!._id,
			changedAt: new Date(),
			reason: 'Remove cartridges from optical analysis group'
		});

		return {
			groupSaved: true,
			groupId,
			groupName: (existing as any).name,
			removedCount: before.length - after.length
		};
	},

	/** Soft delete. BIMS records are never hard-deleted. */
	archiveGroup: async ({ request, locals }) => {
		requirePermission(locals.user, 'cartridge:write');
		await connectDB();

		const form = await request.formData();
		const groupId = form.get('groupId')?.toString().trim();
		if (!groupId) return fail(400, { groupError: 'Missing group.' });

		const existing = await CartridgeGroup.findOne({
			_id: groupId,
			purpose: 'optical_analysis',
			archivedAt: null
		})
			.select('_id name cartridgeIds')
			.lean();
		if (!existing) return fail(404, { groupError: 'That group no longer exists.' });

		await CartridgeGroup.updateOne({ _id: groupId }, { $set: { archivedAt: new Date() } });

		await AuditLog.create({
			_id: generateId(),
			tableName: 'cartridge_groups',
			recordId: groupId,
			action: 'RETIRE',
			oldData: {
				name: (existing as any).name,
				cartridgeIds: (existing as any).cartridgeIds ?? []
			},
			newData: { archivedAt: new Date() },
			changedBy: locals.user!._id,
			changedAt: new Date(),
			reason: 'Archive optical analysis group'
		});

		return { groupArchived: true, groupName: (existing as any).name };
	}
};
