import { fail, error } from '@sveltejs/kit';
import {
	connectDB,
	ReagentLot,
	ReagentProtocolTemplate,
	AuditLog,
	generateId
} from '$lib/server/db';
import { requirePermission } from '$lib/server/permissions';
import type { PageServerLoad, Actions } from './$types';

export const load: PageServerLoad = async ({ params, locals }) => {
	requirePermission(locals.user, 'manufacturing:read');
	await connectDB();

	const lot = await ReagentLot.findById(params.lotId).lean();
	if (!lot) throw error(404, 'Lot not found');

	const template = await ReagentProtocolTemplate.findById((lot as any).templateId).lean();
	if (!template) throw error(404, 'Protocol template not found for this lot');

	return {
		lot: JSON.parse(JSON.stringify(lot)),
		template: JSON.parse(JSON.stringify(template))
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
			qcReadings: readings.map((r: any) => ({
				...r,
				enteredBy: operator,
				enteredAt: r.enteredAt ? new Date(r.enteredAt) : now
			})),
			observations: observations.map((o: any) => ({
				_id: o._id ?? generateId(),
				promptKey: o.promptKey,
				body: o.body,
				enteredBy: operator,
				enteredAt: o.enteredAt ? new Date(o.enteredAt) : now,
				updatedAt: now
			})),
			note,
			flagged
		};

		// Rebuild step entries: replace existing entry or append.
		const next = (lot.stepEntries ?? []).filter((s: any) => s.stepKey !== stepKey);
		next.push(stepEntry);
		next.sort((a: any, b: any) => (a.stepNumber ?? 0) - (b.stepNumber ?? 0));
		lot.stepEntries = next;

		// Rebuild flags list — drop existing flags from this step, re-add from current readings.
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
		lot.flags = [...otherFlags, ...newFlags];

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

	/** Finalize the lot — sacred middleware locks further mutations. */
	finalize: async ({ params, locals }) => {
		requirePermission(locals.user, 'manufacturing:write');
		await connectDB();
		const lot = await ensureLot(params.lotId!);
		if (lot.status === 'finalized') return { success: true, alreadyFinal: true };
		if (lot.status === 'voided') return fail(400, { error: 'Cannot finalize a voided lot.' });

		const now = new Date();
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
			newData: { status: 'finalized' }
		});

		return { success: true };
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
