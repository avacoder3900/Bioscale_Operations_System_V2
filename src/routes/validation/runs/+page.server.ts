import { fail, redirect } from '@sveltejs/kit';
import { requirePermission } from '$lib/server/permissions';
import {
	connectDB, Spu, ValidationRun, GeneratedBarcode, AuditLog, generateId,
	VALIDATION_RUN_STEPS
} from '$lib/server/db';
import type { Actions, PageServerLoad } from './$types';

// Any SPU is selectable for a run (same scope as the thermocouple page's
// SPU dropdown); only voided/retired units are excluded.
const ROSTER_QUERY = {
	status: { $nin: ['voided', 'retired'] }
};

function activeMembers(run: any): any[] {
	return (run.spus ?? []).filter((m: any) => !m.removedAt);
}

function runProgress(run: any): { passed: number; total: number } {
	const members = activeMembers(run);
	const stepKeys: string[] = run.steps ?? [];
	let passed = 0;
	for (const m of members) {
		for (const key of stepKeys) {
			if (m.steps?.[key]?.status === 'passed') passed++;
		}
	}
	return { passed, total: members.length * stepKeys.length };
}

// Per-step rollup across a run's active members, for the at-a-glance status
// chips on the run list (e.g. Mag: 2 passed / 1 failed).
function stepSummary(run: any): Record<string, { passed: number; failed: number; uploaded: number; total: number }> {
	const members = activeMembers(run);
	const out: Record<string, { passed: number; failed: number; uploaded: number; total: number }> = {};
	for (const key of run.steps ?? []) {
		const s = { passed: 0, failed: 0, uploaded: 0, total: members.length };
		for (const m of members) {
			const st = m.steps?.[key]?.status;
			if (st === 'passed') s.passed++;
			else if (st === 'failed') s.failed++;
			else if (st === 'uploaded') s.uploaded++;
		}
		out[key] = s;
	}
	return out;
}

export const load: PageServerLoad = async ({ locals }) => {
	requirePermission(locals.user, 'spu:read');
	await connectDB();

	const spus = await Spu.find(ROSTER_QUERY)
		.select('udi barcode status batch.batchNumber createdAt validation.status validation.magnetometer.status validation.thermocouple.status')
		.sort({ udi: 1 })
		.lean() as any[];

	const runs = await ValidationRun.find()
		.sort({ startedAt: -1 })
		.limit(50)
		.lean() as any[];

	// Map spuId -> active run (Decision 3: at most one in-progress run per UDI)
	const activeRunBySpu = new Map<string, { runId: string; runNumber: string }>();
	for (const run of runs) {
		if (run.status !== 'in_progress') continue;
		for (const m of activeMembers(run)) {
			activeRunBySpu.set(m.spuId, { runId: run._id, runNumber: run.runNumber });
		}
	}

	return {
		spus: spus.map(s => ({
			id: s._id,
			udi: s.udi,
			batchNumber: s.batch?.batchNumber ?? null,
			status: s.status,
			validationStatus: s.validation?.status ?? 'pending',
			magStatus: s.validation?.magnetometer?.status ?? 'pending',
			thermoStatus: s.validation?.thermocouple?.status ?? 'pending',
			activeRun: activeRunBySpu.get(s._id) ?? null,
			createdAt: s.createdAt?.toISOString?.() ?? null
		})),
		runs: runs.map(r => {
			const progress = runProgress(r);
			return {
				id: r._id,
				runNumber: r.runNumber,
				name: r.name ?? null,
				status: r.status,
				spuCount: activeMembers(r).length,
				progress,
				steps: r.steps ?? [],
				stepSummary: stepSummary(r),
				startedAt: r.startedAt?.toISOString?.() ?? null,
				completedAt: r.completedAt?.toISOString?.() ?? null,
				createdBy: r.createdBy?.username ?? null
			};
		})
	};
};

export const actions: Actions = {
	startRun: async ({ request, locals }) => {
		requirePermission(locals.user, 'spu:write');
		await connectDB();

		const form = await request.formData();
		const spuIds = [...new Set(form.getAll('spuIds').map(v => v.toString()).filter(Boolean))];
		const name = form.get('name')?.toString().trim() || null;

		if (spuIds.length === 0) return fail(400, { error: 'Select at least one SPU to start a run' });

		const spus = await Spu.find({ _id: { $in: spuIds } })
			.select('udi status finalizedAt')
			.lean() as any[];
		if (spus.length !== spuIds.length) {
			return fail(400, { error: 'One or more selected SPUs no longer exist' });
		}
		const finalized = spus.filter(s => s.finalizedAt);
		if (finalized.length > 0) {
			return fail(400, { error: `Finalized SPUs cannot join a run: ${finalized.map(s => s.udi).join(', ')}` });
		}

		// Decision 3: a UDI may be in at most one in-progress run.
		const conflictRuns = await ValidationRun.find({
			status: 'in_progress',
			spus: { $elemMatch: { spuId: { $in: spuIds }, removedAt: null } }
		}).select('runNumber spus.spuId spus.udi spus.removedAt').lean() as any[];
		if (conflictRuns.length > 0) {
			const conflictUdis = new Set<string>();
			for (const run of conflictRuns) {
				for (const m of run.spus ?? []) {
					if (!m.removedAt && spuIds.includes(m.spuId)) conflictUdis.add(m.udi);
				}
			}
			return fail(400, { error: `Already in an active run: ${[...conflictUdis].join(', ')}` });
		}

		// Mint VALRUN-000001 style run number. The counter doc MUST get a
		// placeholder barcode on insert: generated_barcodes has a non-sparse
		// unique index on barcode, and a null-barcode doc already exists in
		// prod (the OPT- counter) — upserting without one throws E11000.
		const barcodeDoc = await GeneratedBarcode.findOneAndUpdate(
			{ prefix: 'VALRUN', type: 'sequence_counter' },
			{ $inc: { sequence: 1 }, $setOnInsert: { barcode: 'VALRUN-COUNTER' } },
			{ upsert: true, new: true, setDefaultsOnInsert: true }
		);
		const seq = (barcodeDoc as any).sequence ?? 1;
		const runNumber = `VALRUN-${String(seq).padStart(6, '0')}`;
		await GeneratedBarcode.create({
			_id: generateId(),
			prefix: 'VALRUN',
			sequence: seq,
			barcode: runNumber,
			type: 'validation_run'
		});

		const emptySteps = Object.fromEntries(VALIDATION_RUN_STEPS.map(k => [k, { status: 'not_started' }]));
		const runId = generateId();
		await ValidationRun.create({
			_id: runId,
			runNumber,
			name,
			status: 'in_progress',
			steps: [...VALIDATION_RUN_STEPS],
			spus: spus.map(s => ({
				spuId: s._id,
				udi: s.udi,
				addedAt: new Date(),
				steps: structuredClone(emptySteps)
			})),
			createdBy: { _id: locals.user!._id, username: locals.user!.username },
			startedAt: new Date()
		});

		await AuditLog.create({
			_id: generateId(),
			tableName: 'validation_runs',
			recordId: runId,
			action: 'validation_run_created',
			newData: { runNumber, name, spuUdis: spus.map(s => s.udi) },
			changedAt: new Date(),
			changedBy: locals.user!.username
		});

		throw redirect(303, `/validation/runs/${runId}`);
	}
};
