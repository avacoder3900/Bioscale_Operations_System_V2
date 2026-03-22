import { redirect, fail } from '@sveltejs/kit';
import { connectDB, LotRecord, BackingLot, EquipmentLocation, ManufacturingSettings, AuditLog, generateId } from '$lib/server/db';
import type { PageServerLoad, Actions } from './$types';

export const config = { maxDuration: 60 };

export const load: PageServerLoad = async ({ locals }) => {
	if (!locals.user) redirect(302, '/login');
	await connectDB();

	const todayStart = new Date();
	todayStart.setHours(0, 0, 0, 0);

	const [recentLots, todayLots, activeBakingLots, ovens, settingsDoc] = await Promise.all([
		LotRecord.find().sort({ createdAt: -1 }).limit(10).lean(),
		LotRecord.find({ createdAt: { $gte: todayStart } }).lean(),
		BackingLot.find({ status: { $in: ['in_oven', 'ready'] } }).sort({ ovenEntryTime: -1 }).lean(),
		EquipmentLocation.find({ locationType: 'oven', isActive: true }).lean(),
		ManufacturingSettings.findById('default').lean()
	]);

	// Build stats keyed by configId: { lotsToday, unitsToday }
	const stats: Record<string, { lotsToday: number; unitsToday: number }> = {};
	for (const lot of todayLots as any[]) {
		const configId = lot.processConfig?._id;
		if (!configId) continue;
		if (!stats[configId]) stats[configId] = { lotsToday: 0, unitsToday: 0 };
		stats[configId].lotsToday++;
		stats[configId].unitsToday += lot.quantityProduced ?? 0;
	}

	const minOvenTimeMin: number = (settingsDoc as any)?.waxFilling?.minOvenTimeMin ?? 60;
	const now = Date.now();

	// Enrich backing lots with readiness
	const bakingLots = (activeBakingLots as any[]).map((bl) => {
		const entryMs = bl.ovenEntryTime ? new Date(bl.ovenEntryTime).getTime() : 0;
		const elapsedMin = entryMs ? (now - entryMs) / 60000 : 0;
		const remainingMin = Math.max(0, minOvenTimeMin - elapsedMin);
		const isReady = elapsedMin >= minOvenTimeMin;
		return {
			lotId: String(bl._id),
			ovenEntryTime: bl.ovenEntryTime ? new Date(bl.ovenEntryTime).toISOString() : null,
			ovenLocationId: bl.ovenLocationId ?? null,
			ovenLocationName: bl.ovenLocationName ?? null,
			cartridgeCount: bl.cartridgeCount ?? 0,
			status: bl.status ?? 'in_oven',
			operatorUsername: bl.operator?.username ?? null,
			elapsedMin: Math.floor(elapsedMin),
			remainingMin: Math.ceil(remainingMin),
			isReady
		};
	});

	return {
		recentLots: recentLots.map((l: any) => ({
			lotId: l._id,
			qrCodeRef: l.qrCodeRef,
			configId: l.processConfig?._id ?? '',
			quantityProduced: l.quantityProduced ?? 0,
			startTime: l.startTime ?? null,
			finishTime: l.finishTime ?? null,
			cycleTime: l.cycleTime ?? null,
			status: l.status ?? 'unknown',
			username: l.operator?.username ?? null
		})),
		stats,
		bakingLots,
		ovens: (ovens as any[]).map((o: any) => ({
			id: String(o._id),
			displayName: o.displayName ?? o.barcode ?? String(o._id),
			barcode: o.barcode ?? ''
		})),
		minOvenTimeMin
	};
};

export const actions: Actions = {
	/** Register a backing lot — places it in the oven, starts the timer */
	registerBackingLot: async ({ request, locals }) => {
		if (!locals.user) redirect(302, '/login');
		await connectDB();

		const data = await request.formData();
		const lotBarcode = (data.get('lotBarcode') as string)?.trim();
		const ovenLocationId = (data.get('ovenLocationId') as string)?.trim() || undefined;
		const cartridgeCountRaw = data.get('cartridgeCount') as string;

		if (!lotBarcode) return fail(400, { error: 'Lot barcode is required', action: 'registerBackingLot' });
		if (!cartridgeCountRaw || isNaN(Number(cartridgeCountRaw)) || Number(cartridgeCountRaw) <= 0) {
			return fail(400, { error: 'Valid cartridge count is required', action: 'registerBackingLot' });
		}
		const cartridgeCount = Number(cartridgeCountRaw);

		// Check if lot already exists
		const existing = await BackingLot.findById(lotBarcode).lean();
		if (existing) {
			const bl = existing as any;
			if (bl.status === 'consumed') {
				// Allow re-register if consumed (edge case)
			} else {
				return fail(400, { error: `Lot "${lotBarcode}" is already registered (status: ${bl.status})`, action: 'registerBackingLot' });
			}
		}

		// Look up oven name
		let ovenLocationName: string | undefined;
		if (ovenLocationId) {
			const oven = await EquipmentLocation.findById(ovenLocationId, { displayName: 1, barcode: 1 }).lean() as any;
			ovenLocationName = oven?.displayName ?? oven?.barcode ?? ovenLocationId;
		}

		const now = new Date();
		await BackingLot.findByIdAndUpdate(
			lotBarcode,
			{
				$set: {
					_id: lotBarcode,
					lotType: 'backing',
					ovenEntryTime: now,
					ovenLocationId: ovenLocationId ?? null,
					ovenLocationName: ovenLocationName ?? null,
					operator: { _id: locals.user._id, username: locals.user.username },
					cartridgeCount,
					status: 'in_oven'
				}
			},
			{ upsert: true, new: true }
		);

		await AuditLog.create({
			_id: generateId(),
			tableName: 'backing_lots',
			recordId: lotBarcode,
			action: 'INSERT',
			changedBy: locals.user?.username,
			changedAt: now,
			newData: { lotBarcode, ovenLocationId, cartridgeCount, status: 'in_oven' }
		});

		return { success: true, lotBarcode, action: 'registerBackingLot' };
	}
};
