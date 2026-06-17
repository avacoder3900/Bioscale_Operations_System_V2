import { json, error } from '@sveltejs/kit';
import { connectDB, ReceivingLot, ManufacturingSettings, AuditLog, generateId } from '$lib/server/db';
import type { RequestHandler } from './$types';

const WAX_TUBE_PART_NUMBER = 'PT-CT-114';
const DEFAULT_MELT_DURATION_MIN = 30;

/**
 * Start the melt timer on a wax tube ReceivingLot. Sets waxMelt.startedAt
 * and computes readyAt from ManufacturingSettings.waxFilling.meltDurationMin.
 * Operators call this when they pull wax out of the fridge.
 */
export const POST: RequestHandler = async ({ params, locals }) => {
	if (!locals.user) throw error(401, 'Unauthorized');
	await connectDB();

	const lotId = params.lotId;
	if (!lotId) return json({ error: 'lotId param is required' }, { status: 400 });

	const lot = await ReceivingLot.findOne({
		$or: [{ _id: lotId }, { lotId }, { lotNumber: lotId }, { bagBarcode: lotId }]
	}).lean() as any;

	if (!lot) return json({ error: `Lot "${lotId}" not found.` }, { status: 404 });
	if (lot.part?.partNumber !== WAX_TUBE_PART_NUMBER) {
		return json({
			error: `Lot "${lotId}" is not a wax tube lot (${WAX_TUBE_PART_NUMBER}).`
		}, { status: 400 });
	}

	const settingsDoc = await ManufacturingSettings.findById('default').lean() as any;
	const meltDurationMin: number = settingsDoc?.waxFilling?.meltDurationMin ?? DEFAULT_MELT_DURATION_MIN;

	const now = new Date();
	const readyAt = new Date(now.getTime() + meltDurationMin * 60 * 1000);

	await ReceivingLot.updateOne(
		{ _id: lot._id },
		{
			$set: {
				'waxMelt.startedAt': now,
				'waxMelt.startedBy': { _id: locals.user._id, username: locals.user.username },
				'waxMelt.readyAt': readyAt
			},
			$unset: { 'waxMelt.confirmedMeltedAt': '', 'waxMelt.confirmedBy': '' }
		}
	);

	await AuditLog.create({
		_id: generateId(),
		tableName: 'receiving_lots',
		recordId: String(lot._id),
		action: 'UPDATE',
		changedBy: locals.user.username,
		changedAt: now,
		newData: {
			waxMeltStarted: true,
			meltDurationMin,
			readyAt: readyAt.toISOString(),
			lotNumber: lot.lotNumber ?? lot.lotId
		}
	});

	return json({
		success: true,
		lotId: String(lot._id),
		lotNumber: lot.lotNumber ?? lot.lotId,
		startedAt: now.toISOString(),
		readyAt: readyAt.toISOString(),
		meltDurationMin
	});
};
