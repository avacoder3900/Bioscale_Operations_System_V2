import { fail } from '@sveltejs/kit';
import { requirePermission } from '$lib/server/permissions';
import { connectDB, CartridgeRecord, AuditLog, generateId } from '$lib/server/db';
import type { PageServerLoad, Actions } from './$types';

type StageKey = 'wax' | 'reagent' | 'postmortem';

const STAGE_TO_PHASE: Record<StageKey, string> = {
	wax: 'wax_filled',
	reagent: 'reagent_filled',
	postmortem: 'completed'
};

const STAGE_LABELS: Record<StageKey, string> = {
	wax: 'Wax photos',
	reagent: 'Reagent photos',
	postmortem: 'Post-mortem photos'
};

export const load: PageServerLoad = async ({ locals }) => {
	requirePermission(locals.user, 'cartridge:read');
	await connectDB();
	return {};
};

export const actions: Actions = {
	stage: async ({ request, locals }) => {
		requirePermission(locals.user, 'cartridge:write');
		await connectDB();

		const form = await request.formData();
		const stage = form.get('stage')?.toString() as StageKey | undefined;
		const rawBarcodes = form.get('barcodes')?.toString() ?? '';

		if (!stage || !(stage in STAGE_TO_PHASE)) {
			return fail(400, { error: 'Please select a valid photo session.' });
		}

		// Split on newlines or commas, trim, drop empties, dedupe.
		const barcodes = Array.from(
			new Set(
				rawBarcodes
					.split(/[\r\n,]+/)
					.map((b) => b.trim())
					.filter(Boolean)
			)
		);

		if (barcodes.length === 0) {
			return fail(400, { error: 'Scan or paste at least one cartridge barcode.' });
		}

		const targetPhase = STAGE_TO_PHASE[stage];
		const now = new Date();

		// Force currentPhase on existing docs AND create stubs for unknown barcodes.
		// currentPhase is in $set (always overwrite); stub fields in $setOnInsert (create only).
		const ops = barcodes.map((cid: string) => ({
			updateOne: {
				filter: { _id: cid },
				update: {
					$set: { currentPhase: targetPhase },
					$setOnInsert: { _id: cid, 'backing.recordedAt': now }
				},
				upsert: true
			}
		}));

		await CartridgeRecord.bulkWrite(ops);

		await AuditLog.create({
			_id: generateId(),
			tableName: 'cartridge_records',
			recordId: 'batch',
			action: 'PHASE_ADVANCE',
			newData: {
				event: 'photo_stage',
				resourceType: 'cartridge',
				stage,
				mappedPhase: targetPhase,
				count: barcodes.length,
				barcodes
			},
			reason: `Photo-staging: forced ${barcodes.length} cartridge(s) to ${targetPhase} (${STAGE_LABELS[stage]})`,
			changedAt: now,
			changedBy: locals.user?.username ?? 'system'
		});

		return { success: true, staged: barcodes.length, stage };
	}
};
