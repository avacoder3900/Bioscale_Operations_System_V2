import { redirect, fail } from '@sveltejs/kit';
import { connectDB, BomItem, AuditLog, generateId } from '$lib/server/db';
import type { PageServerLoad, Actions } from './$types';

export const load: PageServerLoad = async ({ locals }) => {
	if (!locals.user) redirect(302, '/login');
	await connectDB();

	const parts = await BomItem.find({ bomType: 'cartridge' })
		.sort({ name: 1 })
		.lean();

	const serialized = (parts as any[]).map((p: any) => ({
		id: String(p._id),
		type: 'deck' as const,
		status: p.isActive === false ? 'retired' : 'active',
		barcode: p.partNumber ?? null,
		// Repurposed fields for parts display
		initialVolumeUl: null,
		remainingVolumeUl: null,
		totalCartridgesFilled: 0,
		totalRunsUsed: 0,
		firstUsedAt: null,
		lastUsedAt: null,
		registeredBy: null,
		initialLengthFt: null,
		remainingLengthFt: null,
		// Show part name in the Robot column, inventory count in Last Used
		currentRobotId: p.name ?? null,
		lastUsed: p.inventoryCount != null ? `Stock: ${p.inventoryCount}` : null,
		assignedRunId: null,
		recentUsage: ((p.versionHistory ?? []) as any[]).slice(-10).reverse().map((v: any) => ({
			usageType: v.changeType ?? 'update',
			runId: null,
			quantityChanged: null,
			volumeChangedUl: null,
			operatorUsername: v.changedBy ?? null,
			notes: v.changeReason ?? null,
			createdAt: v.changedAt
		})),
		createdAt: p.createdAt
	}));

	const grouped = {
		deck: serialized,
		cooling_tray: [] as typeof serialized,
		incubator_tube: [] as typeof serialized,
		top_seal_roll: [] as typeof serialized
	};

	return { consumables: JSON.parse(JSON.stringify(grouped)) };
};

export const actions: Actions = {
	/** Create a new BOM item (cartridge consumable) */
	create: async ({ request, locals }) => {
		if (!locals.user) redirect(302, '/login');
		await connectDB();

		const data = await request.formData();
		const barcode = (data.get('barcode') as string) || undefined;

		const bomData: Record<string, unknown> = {
			_id: generateId(),
			bomType: 'cartridge',
			partNumber: barcode,
			name: barcode ?? 'New Part',
			isActive: true,
			inventoryCount: 0,
			createdBy: locals.user._id
		};

		const item = await BomItem.create(bomData);

		await AuditLog.create({
			_id: generateId(),
			action: 'create',
			resourceType: 'bom_item',
			resourceId: item._id,
			userId: locals.user._id,
			username: locals.user.username,
			timestamp: new Date(),
			details: { partNumber: barcode, bomType: 'cartridge' }
		});

		return { success: true, consumableId: String(item._id) };
	},

	/** Update BOM item active status */
	updateStatus: async ({ request, locals }) => {
		if (!locals.user) redirect(302, '/login');
		await connectDB();

		const data = await request.formData();
		const consumableId = data.get('consumableId') as string;
		const status = data.get('status') as string;

		if (!consumableId) return fail(400, { error: 'Item ID required' });

		const isActive = status !== 'retired' && status !== 'depleted';

		await BomItem.findByIdAndUpdate(consumableId, {
			$set: { isActive },
			$push: {
				versionHistory: {
					version: Date.now(),
					changeType: 'update',
					newValues: { isActive },
					changedBy: locals.user.username,
					changedAt: new Date(),
					changeReason: `Status changed to ${status}`
				}
			}
		});

		return { success: true };
	},

	/** Log manual usage (no-op for BOM items, kept for form compatibility) */
	logUsage: async ({ locals }) => {
		if (!locals.user) redirect(302, '/login');
		return { success: true };
	}
};
