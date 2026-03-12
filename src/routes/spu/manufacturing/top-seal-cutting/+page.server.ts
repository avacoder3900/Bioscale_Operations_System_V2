import { redirect, fail } from '@sveltejs/kit';
import { connectDB, Consumable, ManufacturingSettings, generateId } from '$lib/server/db';
import type { PageServerLoad, Actions } from './$types';

export const load: PageServerLoad = async ({ locals }) => {
	if (!locals.user) redirect(302, '/login');
	await connectDB();

	const [rollsRaw, settingsDoc] = await Promise.all([
		Consumable.find({ type: 'top_seal_roll' }).sort({ createdAt: -1 }).lean(),
		ManufacturingSettings.findById('default').lean()
	]);

	const lengthPerCutFt: number = (settingsDoc as any)?.general?.topSealLengthPerCutFt ?? 0.5;

	const rolls = (rollsRaw as any[]).map((r) => {
		const remaining = r.remainingLengthFt ?? r.initialLengthFt ?? 0;
		const initial = r.initialLengthFt ?? 0;
		let status = r.status ?? 'active';
		// Normalize status to PascalCase for display
		if (status === 'active') status = 'Active';
		else if (status === 'retired' || status === 'Retired') status = 'Retired';
		else if (remaining <= 0) status = 'Depleted';

		return {
			rollId: String(r._id),
			barcode: r.barcode ?? null,
			initialLengthFt: initial,
			remainingLengthFt: remaining,
			status,
			createdBy: r.registeredBy ? String(r.registeredBy) : '',
			createdAt: r.createdAt ? new Date(r.createdAt).toISOString() : '',
			updatedAt: r.updatedAt ? new Date(r.updatedAt).toISOString() : ''
		};
	});

	// Build recentCuts from usageLogs across all rolls
	const recentCuts: {
		id: string; rollId: string; quantityCut: number;
		lengthPerCutFt: number; totalLengthUsedFt: number;
		operatorId: string; notes: string | null; createdAt: string;
	}[] = [];

	for (const r of rollsRaw as any[]) {
		for (const u of r.usageLog ?? []) {
			if (u.usageType === 'cut') {
				const quantityCut = Math.abs(u.quantityChanged ?? 0);
				// Compute total length from remaining before/after, fall back to qty × rate
				const totalLengthUsedFt = u.remainingBefore != null && u.remainingAfter != null
					? Math.abs(u.remainingBefore - u.remainingAfter)
					: quantityCut * lengthPerCutFt;
				recentCuts.push({
					id: u._id ? String(u._id) : generateId(),
					rollId: String(r._id),
					quantityCut,
					lengthPerCutFt,
					totalLengthUsedFt,
					operatorId: u.operator?._id ? String(u.operator._id) : '',
					notes: u.notes ?? null,
					createdAt: u.createdAt ? new Date(u.createdAt).toISOString() : ''
				});
			}
		}
	}

	// Sort cuts newest first, take most recent 50
	recentCuts.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
	const topCuts = recentCuts.slice(0, 50);

	return { rolls, recentCuts: topCuts };
};

export const actions: Actions = {
	/** Register a new top seal roll */
	registerRoll: async ({ request, locals }) => {
		if (!locals.user) redirect(302, '/login');
		await connectDB();

		const data = await request.formData();
		const barcode = (data.get('barcode') as string) || undefined;
		const settingsDoc = await ManufacturingSettings.findById('default').lean() as any;
		const defaultLength = settingsDoc?.general?.defaultRollLengthFt ?? 100;

		await Consumable.create({
			_id: generateId(),
			type: 'top_seal_roll',
			barcode: barcode || undefined,
			initialLengthFt: defaultLength,
			remainingLengthFt: defaultLength,
			status: 'active',
			registeredBy: locals.user._id,
			usageLog: []
		});

		return { success: true };
	},

	/** Record a cut — consumes strips from the active roll */
	recordCut: async ({ request, locals }) => {
		if (!locals.user) redirect(302, '/login');
		await connectDB();

		const data = await request.formData();
		const rollId = data.get('rollId') as string;
		const quantityCut = Number(data.get('quantity') || 0);
		const notes = (data.get('notes') as string) || undefined;

		if (!rollId) return fail(400, { error: 'Roll ID required' });
		if (quantityCut <= 0) return fail(400, { error: 'Quantity must be greater than 0' });

		const roll = await Consumable.findById(rollId).lean() as any;
		if (!roll) return fail(404, { error: 'Roll not found' });
		if (roll.status === 'retired' || roll.status === 'Retired') {
			return fail(400, { error: 'Cannot cut from a retired roll' });
		}

		const settingsDoc = await ManufacturingSettings.findById('default').lean() as any;
		const lengthPerCutFt: number = settingsDoc?.general?.topSealLengthPerCutFt ?? 0.5;
		const totalLengthUsed = quantityCut * lengthPerCutFt;
		const remainingBefore = roll.remainingLengthFt ?? roll.initialLengthFt ?? 0;
		const remainingAfter = Math.max(0, remainingBefore - totalLengthUsed);
		const now = new Date();

		await Consumable.findByIdAndUpdate(rollId, {
			$set: { remainingLengthFt: remainingAfter, updatedAt: now },
			$push: {
				usageLog: {
					_id: generateId(),
					usageType: 'cut',
					quantityChanged: quantityCut,
					totalLengthUsedFt: totalLengthUsed,
					remainingBefore,
					remainingAfter,
					operator: { _id: locals.user._id, username: locals.user.username },
					notes,
					createdAt: now
				}
			}
		});

		return { success: true };
	},

	/** Retire a roll (mark as no longer in use) */
	retireRoll: async ({ request, locals }) => {
		if (!locals.user) redirect(302, '/login');
		await connectDB();

		const data = await request.formData();
		const rollId = data.get('rollId') as string;

		if (!rollId) return fail(400, { error: 'Roll ID required' });

		const now = new Date();
		await Consumable.findByIdAndUpdate(rollId, {
			$set: { status: 'retired', updatedAt: now },
			$push: {
				usageLog: {
					_id: generateId(),
					usageType: 'retired',
					operator: { _id: locals.user._id, username: locals.user.username },
					notes: 'Roll retired',
					createdAt: now
				}
			}
		});

		return { success: true };
	}
};
