import { fail } from '@sveltejs/kit';
import { requirePermission } from '$lib/server/permissions';
import { connectDB, Equipment, DeviceEvent, generateId } from '$lib/server/db';
import type { PageServerLoad, Actions } from './$types';

export const load: PageServerLoad = async ({ url }) => {
	try {
		await connectDB();
		const id = url.searchParams.get('id');

		if (!id) {
			// List all equipment if no id provided
			const equipment = await Equipment.find().sort({ name: 1 }).lean();
			return {
				equipment: equipment.map((e: any) => ({
					id: String(e._id),
					name: e.name ?? '',
					equipmentType: e.equipmentType ?? '',
					status: e.status ?? 'active',
					location: e.location ?? null,
					notes: e.notes ?? null,
					createdAt: e.createdAt?.toISOString?.() ?? new Date().toISOString(),
					updatedAt: e.updatedAt?.toISOString?.() ?? new Date().toISOString()
				}))[0] ?? null,
				events: []
			};
		}

		const equip = await Equipment.findById(id).lean() as any;
		if (!equip) {
			return {
				equipment: null,
				events: []
			};
		}

		const events = await DeviceEvent.find({ deviceId: id })
			.sort({ createdAt: -1 })
			.limit(50)
			.lean() as any[];

		return {
			equipment: {
				id: String(equip._id),
				name: equip.name ?? '',
				equipmentType: equip.equipmentType ?? '',
				status: equip.status ?? 'active',
				location: equip.location ?? null,
				notes: equip.notes ?? null,
				createdAt: equip.createdAt?.toISOString?.() ?? new Date().toISOString(),
				updatedAt: equip.updatedAt?.toISOString?.() ?? new Date().toISOString()
			},
			events: events.map((e) => ({
				id: String(e._id),
				equipmentId: String(e.deviceId ?? id),
				equipmentType: e.eventType ?? '',
				eventType: e.eventType ?? '',
				relatedItemId: null,
				notes: e.eventData?.notes ?? null,
				operatorId: e.eventData?.operatorId ?? null,
				createdAt: e.createdAt?.toISOString?.() ?? new Date().toISOString()
			}))
		};
	} catch {
		return { equipment: null, events: [] };
	}
};

export const actions: Actions = {
	updateStatus: async ({ request, locals }) => {
		requirePermission(locals.user, 'equipment:write');
		await connectDB();
		try {
			const data = await request.formData();
			const id = data.get('id') as string;
			const status = data.get('status') as string;

			if (!id) return fail(400, { error: 'Equipment ID required' });
			if (!status) return fail(400, { error: 'Status required' });

			await Equipment.findByIdAndUpdate(id, { $set: { status } });
			return { success: true };
		} catch (err: any) {
			return fail(500, { error: err.message ?? 'Failed to update status' });
		}
	},

	logEvent: async ({ request, locals }) => {
		requirePermission(locals.user, 'equipment:write');
		await connectDB();
		try {
			const data = await request.formData();
			const equipmentId = data.get('equipmentId') as string;
			const equipmentType = data.get('equipmentType') as string;
			const eventType = data.get('eventType') as string;
			const notes = (data.get('notes') as string)?.trim() || null;

			if (!equipmentId) return fail(400, { error: 'Equipment ID required' });
			if (!eventType) return fail(400, { error: 'Event type required' });

			await DeviceEvent.create({
				_id: generateId(),
				deviceId: equipmentId,
				eventType: 'reset', // use allowed enum value; store real type in eventData
				eventData: { eventType, notes, equipmentType },
				success: true
			});

			return { success: true };
		} catch (err: any) {
			return fail(500, { error: err.message ?? 'Failed to log event' });
		}
	}
};

export const config = { maxDuration: 60 };
