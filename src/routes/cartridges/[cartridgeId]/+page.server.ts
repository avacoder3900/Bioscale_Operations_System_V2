import { error, fail, redirect } from '@sveltejs/kit';
import { requirePermission } from '$lib/server/permissions';
import {
	connectDB, LabCartridge, CartridgeGroup, FirmwareCartridge, AssayDefinition,
	DeviceEvent
} from '$lib/server/db';
import type { PageServerLoad, Actions } from './$types';

export const load: PageServerLoad = async ({ locals, params }) => {
	if (!locals.user) redirect(302, '/login');
	requirePermission(locals.user, 'cartridge:read');
	await connectDB();

	const raw = await LabCartridge.findById(params.cartridgeId).lean();
	if (!raw) throw error(404, 'Cartridge not found');
	const c = raw as any;

	const [groups, firmwareRecord, assayTypes] = await Promise.all([
		CartridgeGroup.find({}).lean(),
		FirmwareCartridge.findOne({ cartridgeUuid: c.barcode }).lean() as any,
		AssayDefinition.find({ isActive: true }, { _id: 1, name: 1, skuCode: 1 }).lean()
	]);

	// Firmware events for this cartridge's barcode
	const firmwareEvents = firmwareRecord?.cartridgeUuid
		? await DeviceEvent.find({ cartridgeUuid: firmwareRecord.cartridgeUuid })
				.sort({ createdAt: -1 })
				.limit(50)
				.lean()
		: [];

	// Group lookup
	const groupsMap = new Map((groups as any[]).map((g: any) => [g._id, g]));
	const group = c.groupId ? groupsMap.get(c.groupId) : null;

	const canWrite = !!(locals.user as any)?.roles?.some((role: any) =>
		role.permissions?.includes('cartridge:write') || role.roleName === 'admin'
	);
	const canDelete = !!(locals.user as any)?.roles?.some((role: any) =>
		role.roleName === 'admin'
	);

	// Firmware status
	const firmwareStatus = firmwareRecord
		? {
				exists: true,
				status: firmwareRecord.status ?? null,
				assayId: firmwareRecord.assayId ?? null,
				assayName: firmwareRecord.assayId
					? (assayTypes as any[]).find((a: any) => a._id === firmwareRecord.assayId)?.name ?? null
					: null,
				validationCount: firmwareRecord.validationCount ?? 0,
				lastValidatedAt: firmwareRecord.lastValidatedAt ?? null,
				testResultId: firmwareRecord.testResultId ?? null
			}
		: {
				exists: false,
				status: null,
				assayId: null,
				assayName: null,
				validationCount: 0,
				lastValidatedAt: null,
				testResultId: null
			};

	return {
		cartridge: {
			id: c._id,
			barcode: c.barcode ?? '',
			serialNumber: c.serialNumber ?? null,
			lotNumber: c.lotNumber ?? '',
			cartridgeType: c.cartridgeType ?? null,
			status: c.status ?? 'available',
			groupId: c.groupId ?? null,
			group: group ? { id: (group as any)._id, name: (group as any).name ?? '' } : null,
			manufacturer: c.manufacturer ?? null,
			expirationDate: c.expirationDate ?? null,
			receivedDate: c.receivedDate ?? null,
			openedDate: c.openedDate ?? null,
			usesRemaining: c.usesRemaining ?? null,
			totalUses: c.totalUses ?? null,
			storageLocation: c.storageLocation ?? null,
			storageConditions: c.storageConditions ?? null,
			notes: c.notes ?? null,
			isActive: c.isActive ?? true,
			createdAt: c.createdAt
		},
		usageLog: (c.usageLog ?? []).map((log: any) => ({
			id: log._id,
			action: log.action ?? '',
			previousValue: log.previousValue ?? null,
			newValue: log.newValue ?? null,
			spuId: log.spuId ?? null,
			validationSessionId: log.validationSessionId ?? null,
			notes: log.notes ?? null,
			performedBy: log.performedBy?.username ?? null,
			performedAt: log.performedAt ?? null
		})).reverse(),
		firmwareStatus,
		firmwareEvents: (firmwareEvents as any[]).map((e: any) => ({
			id: e._id,
			eventType: e.eventType ?? '',
			success: e.success ?? null,
			errorMessage: e.errorMessage ?? null,
			eventData: e.eventData ?? null,
			createdAt: e.createdAt
		})),
		groups: (groups as any[]).map((g: any) => ({ id: g._id, name: g.name ?? '' })),
		activeAssays: (assayTypes as any[]).map((a: any) => ({
			assayId: a._id,
			name: a.name,
			skuCode: a.skuCode ?? null
		})),
		canWrite,
		canDelete,
		canAssignAssay: canWrite
	};
};

export const actions: Actions = {
	update: async ({ request, locals, params }) => {
		requirePermission(locals.user, 'cartridge:write');
		await connectDB();
		const form = await request.formData();
		const updates: Record<string, any> = {};
		const fields = ['serialNumber', 'manufacturer', 'storageLocation', 'storageConditions', 'notes'];
		for (const f of fields) {
			const val = form.get(f)?.toString().trim();
			if (val !== undefined) updates[f] = val || null;
		}
		if (form.get('usesRemaining')) updates.usesRemaining = Number(form.get('usesRemaining'));
		if (form.get('status')) updates.status = form.get('status')!.toString();
		if (form.get('groupId') !== null) updates.groupId = form.get('groupId')?.toString() || null;

		await LabCartridge.updateOne({ _id: params.cartridgeId }, { $set: updates });
		return { success: true };
	},

	delete: async ({ request, locals, params }) => {
		requirePermission(locals.user, 'cartridge:write');
		await connectDB();
		const form = await request.formData();
		const reason = form.get('reason')?.toString();
		if (!reason) return fail(400, { error: 'Deletion reason required' });

		await LabCartridge.updateOne({ _id: params.cartridgeId }, {
			$set: { status: 'disposed', isActive: false },
			$push: {
				usageLog: {
					action: 'deleted',
					notes: reason,
					performedBy: { _id: locals.user!._id, username: locals.user!.username },
					performedAt: new Date()
				}
			}
		});
		return { success: true };
	},

	assignAssay: async ({ request, locals, params }) => {
		requirePermission(locals.user, 'cartridge:write');
		await connectDB();
		const form = await request.formData();
		const assayId = form.get('assayId')?.toString();
		if (!assayId) return fail(400, { error: 'Assay ID required' });

		await FirmwareCartridge.updateOne(
			{ cartridgeUuid: params.cartridgeId },
			{ $set: { assayId } },
			{ upsert: true }
		);
		return { success: true };
	}
};
