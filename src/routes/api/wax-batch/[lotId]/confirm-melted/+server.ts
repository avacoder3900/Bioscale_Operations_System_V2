import { json, error } from '@sveltejs/kit';
import { connectDB, ReceivingLot, AuditLog, generateId } from '$lib/server/db';
import type { RequestHandler } from './$types';

const WAX_TUBE_PART_NUMBER = 'PT-CT-114';

/**
 * Manually confirm a wax tube ReceivingLot is melted, overriding the
 * timer-based readyAt gate. Used when an operator visually verifies melt
 * before the timer expires, or to unblock a lot whose startedAt was not
 * recorded.
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

	const now = new Date();

	await ReceivingLot.updateOne(
		{ _id: lot._id },
		{
			$set: {
				'waxMelt.confirmedMeltedAt': now,
				'waxMelt.confirmedBy': { _id: locals.user._id, username: locals.user.username }
			}
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
			waxMeltConfirmed: true,
			lotNumber: lot.lotNumber ?? lot.lotId
		}
	});

	return json({
		success: true,
		lotId: String(lot._id),
		lotNumber: lot.lotNumber ?? lot.lotId,
		confirmedMeltedAt: now.toISOString()
	});
};
