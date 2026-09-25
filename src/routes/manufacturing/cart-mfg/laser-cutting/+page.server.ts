/**
 * Laser cutting — batch log only (2026-09-25).
 *
 * Laser-cut sheet inventory is stale and no longer tracked: thermoseal is one
 * roll-counted part (THERMOSEAL_PART, PT-CT-101) that moves ONLY when the
 * bucket board pulls a roll at the press. This page records batches for the
 * record and moves no inventory — not PT-CT-111, not PT-CT-112, not the legacy
 * ManufacturingMaterial "laser cut substrates" counter.
 */
import { redirect, fail } from '@sveltejs/kit';
import { connectDB, LaserCutBatch, ManufacturingSettings, AuditLog, generateId } from '$lib/server/db';
import { requirePermission } from '$lib/server/permissions';
import { nanoid } from 'nanoid';
import type { PageServerLoad, Actions } from './$types';

export const load: PageServerLoad = async ({ locals }) => {
	if (!locals.user) redirect(302, '/login');
	requirePermission(locals.user, 'manufacturing:read');
	await connectDB();

	const [batches, settingsDoc] = await Promise.all([
		LaserCutBatch.find().sort({ createdAt: -1 }).limit(50).lean(),
		ManufacturingSettings.findById('default').lean()
	]);

	const general = (settingsDoc as any)?.general ?? {};

	// Stats rollup
	const totalBatches = batches.length;
	const totalInput = batches.reduce((s: number, b: any) => s + (b.inputSheetCount ?? 0), 0);
	const totalOutput = batches.reduce((s: number, b: any) => s + (b.outputSheetCount ?? 0), 0);
	const totalFailures = batches.reduce((s: number, b: any) => s + (b.failureCount ?? 0), 0);
	const failureRate = totalInput > 0 ? totalFailures / totalInput : 0;

	return {
		batches: (batches as any[]).map((b: any) => ({
			batchId: b._id,
			inputSheetCount: b.inputSheetCount ?? 0,
			outputSheetCount: b.outputSheetCount ?? 0,
			failureCount: b.failureCount ?? 0,
			failureNotes: b.failureNotes ?? null,
			cuttingProgramLink: b.cuttingProgramLink ?? null,
			toolsUsed: b.toolsUsed ?? null,
			operatorId: b.operatorId ?? null,
			operatorName: b.operatorId ?? null,
			inputLotId: b.inputLotId ?? null,
			outputLotId: b.outputLotId ?? null,
			operator: b.operator ?? null,
			createdAt: b.createdAt instanceof Date ? b.createdAt.toISOString() : String(b.createdAt ?? '')
		})),
		stats: { totalBatches, totalInput, totalOutput, totalFailures, failureRate },
		defaults: {
			defaultLaserTools: general.defaultLaserTools ?? null,
			defaultCuttingProgramLink: general.defaultCuttingProgramLink ?? null
		}
	};
};

export const actions: Actions = {
	/** Record a completed laser-cut batch (no inventory movement — see header) */
	recordBatch: async ({ request, locals }) => {
		if (!locals.user) redirect(302, '/login');
		requirePermission(locals.user, 'manufacturing:write');
		await connectDB();

		const data = await request.formData();
		const inputSheetCount = Number(data.get('inputSheetCount') || 0);
		const failureCount = Number(data.get('failureCount') || 0);
		const outputSheetCount = Math.max(0, inputSheetCount - failureCount);
		const failureNotes = (data.get('failureNotes') as string) || undefined;
		const cuttingProgramLink = (data.get('cuttingProgramLink') as string) || undefined;
		const toolsUsed = (data.get('toolsUsed') as string) || undefined;
		const inputLotId = (data.get('inputLotId') as string) || undefined;

		if (inputSheetCount <= 0) return fail(400, { error: 'Input sheet count must be > 0' });

		// FIX-01: Find linked parts from ManufacturingSettings (optional)
		const settingsDoc = await ManufacturingSettings.findById('default').lean() as any;
		const general = settingsDoc?.general ?? {};

		// Generate output lot number: LOT-YYYYMMDD-XXXX
		const now2 = new Date();
		const dateStr = `${now2.getFullYear()}${String(now2.getMonth() + 1).padStart(2, '0')}${String(now2.getDate()).padStart(2, '0')}`;
		const outputLotId = `LOT-${dateStr}-${nanoid(4).toUpperCase()}`;

		// Create the batch record
		await LaserCutBatch.create({
			_id: generateId(),
			inputSheetCount,
			outputSheetCount,
			failureCount,
			failureNotes,
			cuttingProgramLink: cuttingProgramLink || general.defaultCuttingProgramLink || undefined,
			toolsUsed: toolsUsed || general.defaultLaserTools || undefined,
			operatorId: locals.user._id,
			inputLotId,
			outputLotId,
			operator: { _id: locals.user._id, username: locals.user.username }
		});

		// No inventory movement (2026-09-25). Laser-cut sheets are not tracked
		// inventory any more; thermoseal is one roll-counted part moved only by the
		// bucket board's roll pull. The LaserCutBatch above is the record.

		// Audit log for batch record creation
		const batchRecord = await LaserCutBatch.findOne({ operatorId: locals.user._id, outputLotId }).lean() as any;
		await AuditLog.create({
			_id: generateId(),
			tableName: 'laser_cut_batches',
			recordId: batchRecord?._id ?? outputLotId,
			action: 'INSERT',
			changedBy: locals.user?.username,
			changedAt: new Date()
		});

		return { success: true };
	},

	/** Save default settings to ManufacturingSettings */
	saveDefaults: async ({ request, locals }) => {
		if (!locals.user) redirect(302, '/login');
		requirePermission(locals.user, 'manufacturing:write');
		await connectDB();

		const data = await request.formData();
		const defaultLaserTools = (data.get('defaultLaserTools') as string) || undefined;
		const defaultCuttingProgramLink = (data.get('defaultCuttingProgramLink') as string) || undefined;

		await ManufacturingSettings.findByIdAndUpdate(
			'default',
			{
				$set: {
					'general.defaultLaserTools': defaultLaserTools,
					'general.defaultCuttingProgramLink': defaultCuttingProgramLink
				}
			},
			{ upsert: true }
		);

		return { success: true, defaultsSaved: true };
	}
};

export const config = { maxDuration: 60 };
