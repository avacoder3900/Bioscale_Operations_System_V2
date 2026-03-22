import { redirect } from '@sveltejs/kit';
import { connectDB, FirmwareDevice, FirmwareCartridge, DeviceEvent } from '$lib/server/db';
import { requirePermission } from '$lib/server/permissions';
import type { PageServerLoad, Actions } from './$types';

export const load: PageServerLoad = async ({ locals, url }) => {
	if (!locals.user) redirect(302, '/login');
	requirePermission(locals.user, 'device:read');

	await connectDB();

	const tab = url.searchParams.get('tab') || 'devices';
	const page = parseInt(url.searchParams.get('page') || '1');
	const limit = 50;

	const [devices, devicesTotal, fwCartridges, fwCartridgesTotal, recentEvents] = await Promise.all([
		FirmwareDevice.find().sort({ lastSeen: -1 }).skip((page - 1) * limit).limit(limit).lean(),
		FirmwareDevice.countDocuments(),
		FirmwareCartridge.find().sort({ createdAt: -1 }).skip((page - 1) * limit).limit(limit).lean(),
		FirmwareCartridge.countDocuments(),
		DeviceEvent.find().sort({ createdAt: -1 }).limit(100).lean()
	]);

	return {
		tab,
		devices: devices.map((d: any) => ({
			id: d._id,
			deviceId: d.deviceId,
			apiKey: d.apiKey ? '***' : null,
			firmwareVersion: d.firmwareVersion,
			dataFormatVersion: d.dataFormatVersion,
			lastSeen: d.lastSeen,
			metadata: d.metadata,
			createdAt: d.createdAt
		})),
		firmwareCartridges: fwCartridges.map((c: any) => ({
			id: c._id,
			cartridgeUuid: c.cartridgeUuid,
			assayId: c.assayId,
			status: c.status,
			lotNumber: c.lotNumber,
			expirationDate: c.expirationDate,
			serialNumber: c.serialNumber,
			siteId: c.siteId,
			program: c.program,
			experiment: c.experiment,
			arm: c.arm,
			quantity: c.quantity,
			testResultId: c.testResultId,
			createdAt: c.createdAt
		})),
		events: recentEvents.map((e: any) => ({
			id: e._id,
			deviceId: e.deviceId,
			eventType: e.eventType,
			cartridgeUuid: e.cartridgeUuid,
			success: e.success,
			errorMessage: e.errorMessage,
			createdAt: e.createdAt
		})),
		pagination: {
			page, limit,
			devicesTotal,
			fwCartridgesTotal,
			hasNext: tab === 'devices' ? page * limit < devicesTotal : page * limit < fwCartridgesTotal,
			hasPrev: page > 1
		}
	};
};

export const actions: Actions = {
	createDevice: async ({ request, locals }) => {
		if (!locals.user) redirect(302, '/login');
		requirePermission(locals.user, 'device:write');
		await connectDB();

		const data = await request.formData();
		await FirmwareDevice.create({
			deviceId: data.get('deviceId') as string,
			apiKey: data.get('apiKey') as string || undefined,
			firmwareVersion: data.get('firmwareVersion') as string || undefined,
			dataFormatVersion: data.get('dataFormatVersion') as string || undefined,
			lastSeen: new Date(),
			metadata: {}
		});

		return { success: true };
	},

	updateDevice: async ({ request, locals }) => {
		if (!locals.user) redirect(302, '/login');
		requirePermission(locals.user, 'device:write');
		await connectDB();

		const data = await request.formData();
		const id = data.get('id') as string;
		const update: any = {};
		const fw = data.get('firmwareVersion') as string;
		const dfv = data.get('dataFormatVersion') as string;
		if (fw) update.firmwareVersion = fw;
		if (dfv) update.dataFormatVersion = dfv;

		await FirmwareDevice.findByIdAndUpdate(id, update);
		return { success: true };
	}
};

export const config = { maxDuration: 60 };
