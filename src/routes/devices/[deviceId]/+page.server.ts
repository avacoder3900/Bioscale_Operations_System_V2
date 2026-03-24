import { error, redirect } from '@sveltejs/kit';
import { connectDB, FirmwareDevice, DeviceEvent } from '$lib/server/db';
import { requirePermission } from '$lib/server/permissions';
import type { PageServerLoad } from './$types';

export const load: PageServerLoad = async ({ locals, params }) => {
	if (!locals.user) redirect(302, '/login');
	requirePermission(locals.user, 'device:read');
	await connectDB();

	const device = await FirmwareDevice.findById(params.deviceId).lean() as any;
	if (!device) throw error(404, 'Device not found');

	// Get all events for this device
	const events = await DeviceEvent.find({ deviceId: device.deviceId })
		.sort({ createdAt: -1 })
		.limit(200)
		.lean();

	// Count tests and cartridges validated
	const testCount = await DeviceEvent.countDocuments({
		deviceId: device.deviceId,
		eventType: 'validate'
	});
	const cartridgesValidatedCount = await DeviceEvent.countDocuments({
		deviceId: device.deviceId,
		eventType: 'validate',
		success: true
	});

	const isOnline = device.lastSeen
		? Date.now() - new Date(device.lastSeen).getTime() < 5 * 60 * 1000
		: false;

	return {
		device: {
			id: device._id,
			deviceId: device.deviceId,
			isOnline,
			lastSeen: device.lastSeen,
			firmwareVersion: device.firmwareVersion ?? null,
			dataFormatVersion: device.dataFormatVersion ?? null,
			testCount,
			cartridgesValidatedCount,
			createdAt: device.createdAt,
			metadata: device.metadata ?? null
		},
		events: events.map((e: any) => ({
			id: e._id,
			deviceId: e.deviceId,
			eventType: e.eventType,
			eventData: e.eventData ?? null,
			cartridgeUuid: e.cartridgeUuid ?? null,
			success: e.success,
			errorMessage: e.errorMessage ?? null,
			createdAt: e.createdAt
		}))
	};
};

export const config = { maxDuration: 60 };
