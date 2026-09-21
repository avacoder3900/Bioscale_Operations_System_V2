import { redirect, fail } from '@sveltejs/kit';
import { connectDB, ManufacturingSettings, generateId } from '$lib/server/db';
import { requirePermission } from '$lib/server/permissions';
import type { PageServerLoad, Actions } from './$types';

export const config = { maxDuration: 60 };

export const load: PageServerLoad = async ({ locals }) => {
	if (!locals.user) redirect(302, '/login');
	requirePermission(locals.user, 'manufacturing:admin');

	// Pruned 2026-08-28: cooling/QC/lockout timers, temperatures and per-deck
	// volumes belonged to retired workflow stages and gated nothing — only the
	// fields the live wax flow actually reads remain.
	const defaultSettings = {
		minOvenTimeMin: 60, runDurationMin: 45, removeDeckWarningMin: 5,
		waxPerCartridgeUl: 19.2,
		waxFillDeadVolumeUl: 80 // added on top of waxPerCartridgeUl × count for the 2ml tube fill (WAX-FLOW-3)
	};

	try {
		await connectDB();
		const settingsDoc = await ManufacturingSettings.findById('default').lean();
		const wax = (settingsDoc as any)?.waxFilling ?? {};

		const rejectionReasons = ((settingsDoc as any)?.rejectionReasonCodes ?? [])
			.filter((r: any) => !r.processType || r.processType === 'wax')
			.map((r: any, i: number) => ({
				id: r._id ? String(r._id) : String(i),
				code: r.code ?? '',
				label: r.label ?? '',
				sortOrder: r.sortOrder ?? i
			}));

		return {
			settings: {
				minOvenTimeMin: wax.minOvenTimeMin ?? defaultSettings.minOvenTimeMin,
				runDurationMin: wax.runDurationMin ?? defaultSettings.runDurationMin,
				removeDeckWarningMin: wax.removeDeckWarningMin ?? defaultSettings.removeDeckWarningMin,
				waxPerCartridgeUl: wax.waxPerCartridgeUl ?? defaultSettings.waxPerCartridgeUl,
				waxFillDeadVolumeUl: wax.waxFillDeadVolumeUl ?? defaultSettings.waxFillDeadVolumeUl
			},
			rejectionReasons
		};
	} catch (err) {
		console.error('[WAX-FILLING SETTINGS] Load error:', err instanceof Error ? err.message : err);
		return { settings: defaultSettings, rejectionReasons: [] };
	}
};

export const actions: Actions = {
	/** Update numeric settings */
	update: async ({ request, locals }) => {
		if (!locals.user) redirect(302, '/login');
		requirePermission(locals.user, 'manufacturing:admin');
		await connectDB();

		const data = await request.formData();
		const errors: Record<string, string> = {};
		const update: Record<string, any> = {};

		const fields: { key: string; min: number; max: number }[] = [
			{ key: 'minOvenTimeMin', min: 1, max: 1440 },
			{ key: 'runDurationMin', min: 1, max: 120 },
			{ key: 'removeDeckWarningMin', min: 1, max: 60 },
			{ key: 'waxPerCartridgeUl', min: 1, max: 1000 },
			{ key: 'waxFillDeadVolumeUl', min: 0, max: 2000 }
		];

		for (const f of fields) {
			const val = data.get(f.key);
			if (val !== null && val !== '') {
				const num = Number(val);
				if (isNaN(num) || num < f.min || num > f.max) {
					errors[f.key] = `Must be between ${f.min} and ${f.max}`;
				} else {
					update[`waxFilling.${f.key}`] = num;
				}
			}
		}

		if (Object.keys(errors).length > 0) {
			return fail(400, { error: 'Validation failed', errors });
		}

		await ManufacturingSettings.findByIdAndUpdate(
			'default',
			{ $set: { ...update, updatedAt: new Date() } },
			{ upsert: true }
		);

		return { success: true };
	},

	/** Create a new rejection reason */
	createReason: async ({ request, locals }) => {
		if (!locals.user) redirect(302, '/login');
		requirePermission(locals.user, 'manufacturing:admin');
		await connectDB();

		const data = await request.formData();
		const code = (data.get('code') as string)?.trim();
		const label = (data.get('label') as string)?.trim();
		const sortOrder = Number(data.get('sortOrder') ?? 0);

		if (!code || !label) return fail(400, { error: 'Code and label are required' });

		await ManufacturingSettings.findByIdAndUpdate(
			'default',
			{
				$push: {
					rejectionReasonCodes: {
						_id: generateId(), code, label, processType: 'wax', sortOrder
					}
				}
			},
			{ upsert: true }
		);

		return { success: true };
	},

	/** Update an existing rejection reason */
	updateReason: async ({ request, locals }) => {
		if (!locals.user) redirect(302, '/login');
		requirePermission(locals.user, 'manufacturing:admin');
		await connectDB();

		const data = await request.formData();
		const codeId = data.get('codeId') as string;
		const label = (data.get('label') as string)?.trim();
		const sortOrder = Number(data.get('sortOrder') ?? 0);

		if (!codeId || !label) return fail(400, { error: 'Code ID and label are required' });

		await ManufacturingSettings.findOneAndUpdate(
			{ 'rejectionReasonCodes._id': codeId },
			{
				$set: {
					'rejectionReasonCodes.$.label': label,
					'rejectionReasonCodes.$.sortOrder': sortOrder
				}
			}
		);

		return { success: true };
	},

	/** Delete a rejection reason */
	deleteReason: async ({ request, locals }) => {
		if (!locals.user) redirect(302, '/login');
		requirePermission(locals.user, 'manufacturing:admin');
		await connectDB();

		const data = await request.formData();
		const codeId = data.get('codeId') as string;

		if (!codeId) return fail(400, { error: 'Code ID required' });

		await ManufacturingSettings.findByIdAndUpdate(
			'default',
			{ $pull: { rejectionReasonCodes: { _id: codeId } } }
		);

		return { success: true };
	}
};
