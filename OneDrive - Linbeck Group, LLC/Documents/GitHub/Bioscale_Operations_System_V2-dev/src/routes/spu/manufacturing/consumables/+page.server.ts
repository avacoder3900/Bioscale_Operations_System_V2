import { redirect, fail } from '@sveltejs/kit';
import { connectDB, Consumable, AuditLog, generateId } from '$lib/server/db';
import { requirePermission } from '$lib/server/permissions';
import type { PageServerLoad, Actions } from './$types';

export const load: PageServerLoad = async ({ locals }) => {
	if (!locals.user) redirect(302, '/login');
	requirePermission(locals.user, 'manufacturing:read');
	await connectDB();

	const consumables = await Consumable.find().sort({ type: 1, createdAt: -1 }).lean();

	const serialized = (consumables as any[]).map((c: any) => ({
		id: c._id,
		type: c.type,
		status: c.status ?? 'active',
		barcode: c.barcode ?? null,
		// Incubator tube fields
		initialVolumeUl: c.initialVolumeUl ?? null,
		remainingVolumeUl: c.remainingVolumeUl ?? null,
		totalCartridgesFilled: c.totalCartridgesFilled ?? 0,
		totalRunsUsed: c.totalRunsUsed ?? 0,
		firstUsedAt: c.firstUsedAt ?? null,
		lastUsedAt: c.lastUsedAt ?? null,
		registeredBy: c.registeredBy ?? null,
		// Top seal roll fields
		initialLengthFt: c.initialLengthFt ?? null,
		remainingLengthFt: c.remainingLengthFt ?? null,
		// Deck fields
		currentRobotId: c.currentRobotId ?? null,
		lastUsed: c.lastUsed ?? null,
		// Cooling tray
		assignedRunId: c.assignedRunId ?? null,
		// Usage log (last 10)
		recentUsage: ((c.usageLog ?? []) as any[]).slice(-10).reverse().map((u: any) => ({
			usageType: u.usageType,
			runId: u.runId ?? null,
			quantityChanged: u.quantityChanged ?? null,
			volumeChangedUl: u.volumeChangedUl ?? null,
			operatorUsername: u.operator?.username ?? null,
			notes: u.notes ?? null,
			createdAt: u.createdAt
		})),
		createdAt: c.createdAt
	}));

	// Group by type
	const grouped = {
		deck: serialized.filter(c => c.type === 'deck'),
		cooling_tray: serialized.filter(c => c.type === 'cooling_tray'),
		incubator_tube: serialized.filter(c => c.type === 'incubator_tube'),
		top_seal_roll: serialized.filter(c => c.type === 'top_seal_roll')
	};

	return { consumables: JSON.parse(JSON.stringify(grouped)) };
};

export const actions: Actions = {
	/** Create a new consumable of any type */
	create: async ({ request, locals }) => {
		if (!locals.user) redirect(302, '/login');
		requirePermission(locals.user, 'manufacturing:write');
		await connectDB();

		const data = await request.formData();
		const type = data.get('type') as string;
		const barcode = (data.get('barcode') as string) || undefined;
		const status = (data.get('status') as string) || 'active';

		const validTypes = ['deck', 'cooling_tray', 'incubator_tube', 'top_seal_roll'];
		if (!validTypes.includes(type)) return fail(400, { error: 'Invalid consumable type' });

		const consumableData: Record<string, unknown> = {
			_id: generateId(),
			type,
			status,
			barcode,
			usageLog: []
		};

		// Type-specific fields
		if (type === 'incubator_tube') {
			const initialVolumeUl = Number(data.get('initialVolumeUl') || 0);
			consumableData.initialVolumeUl = initialVolumeUl;
			consumableData.remainingVolumeUl = initialVolumeUl;
			consumableData.totalCartridgesFilled = 0;
			consumableData.totalRunsUsed = 0;
			consumableData.registeredBy = locals.user._id;
		} else if (type === 'top_seal_roll') {
			const initialLengthFt = Number(data.get('initialLengthFt') || 0);
			consumableData.initialLengthFt = initialLengthFt;
			consumableData.remainingLengthFt = initialLengthFt;
		} else if (type === 'deck') {
			consumableData.currentRobotId = (data.get('currentRobotId') as string) || undefined;
		}

		const consumable = await Consumable.create(consumableData);

		await AuditLog.create({
			_id: generateId(),
			action: 'create',
			resourceType: 'consumable',
			resourceId: consumable._id,
			userId: locals.user._id,
			username: locals.user.username,
			timestamp: new Date(),
			details: { type, barcode, status }
		});

		return { success: true, consumableId: consumable._id };
	},

	/** Update consumable status */
	updateStatus: async ({ request, locals }) => {
		if (!locals.user) redirect(302, '/login');
		requirePermission(locals.user, 'manufacturing:write');
		await connectDB();

		const data = await request.formData();
		const consumableId = data.get('consumableId') as string;
		const status = data.get('status') as string;
		const notes = (data.get('notes') as string) || undefined;

		if (!consumableId) return fail(400, { error: 'Consumable ID required' });

		const now = new Date();
		await Consumable.findByIdAndUpdate(consumableId, {
			$set: { status },
			$push: {
				usageLog: {
					_id: generateId(),
					usageType: 'status_change',
					operator: { _id: locals.user._id, username: locals.user.username },
					notes: notes ?? `Status changed to ${status}`,
					createdAt: now
				}
			}
		});

		return { success: true };
	},

	/** Log manual usage against a consumable */
	logUsage: async ({ request, locals }) => {
		if (!locals.user) redirect(302, '/login');
		requirePermission(locals.user, 'manufacturing:write');
		await connectDB();

		const data = await request.formData();
		const consumableId = data.get('consumableId') as string;
		const usageType = data.get('usageType') as string;
		const notes = (data.get('notes') as string) || undefined;
		const volumeChangedUl = data.get('volumeChangedUl') ? Number(data.get('volumeChangedUl')) : undefined;
		const quantityChanged = data.get('quantityChanged') ? Number(data.get('quantityChanged')) : undefined;

		if (!consumableId) return fail(400, { error: 'Consumable ID required' });

		const now = new Date();
		const logEntry: Record<string, unknown> = {
			_id: generateId(),
			usageType,
			operator: { _id: locals.user._id, username: locals.user.username },
			notes,
			createdAt: now
		};
		if (volumeChangedUl !== undefined) {
			logEntry.volumeChangedUl = volumeChangedUl;
		}
		if (quantityChanged !== undefined) {
			logEntry.quantityChanged = quantityChanged;
		}

		const update: Record<string, unknown> = {
			$push: { usageLog: logEntry },
			$set: { lastUsedAt: now }
		};

		// For tubes, decrement remaining volume
		if (volumeChangedUl !== undefined) {
			(update.$inc as Record<string, number>) = { remainingVolumeUl: -Math.abs(volumeChangedUl) };
		}

		await Consumable.findByIdAndUpdate(consumableId, update);

		return { success: true };
	}
};
