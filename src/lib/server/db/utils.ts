import { nanoid } from 'nanoid';

export function generateId(size = 21): string {
	return nanoid(size);
}

/**
 * Generate a lot number in the format LOT-YYYYMMDD-XXXX.
 * Sequence resets daily. Requires the ReceivingLot model to determine
 * the next sequence number for today.
 */
export async function generateLotNumber(ReceivingLotModel: any): Promise<string> {
	const now = new Date();
	const yyyy = now.getFullYear();
	const mm = String(now.getMonth() + 1).padStart(2, '0');
	const dd = String(now.getDate()).padStart(2, '0');
	const dateStr = `${yyyy}${mm}${dd}`;
	const prefix = `LOT-${dateStr}-`;

	// Find the highest sequence number for today
	const latestLot = await ReceivingLotModel.findOne(
		{ lotNumber: { $regex: `^${prefix}` } },
		{ lotNumber: 1 },
		{ sort: { lotNumber: -1 } }
	).lean();

	let seq = 1;
	if (latestLot?.lotNumber) {
		const lastSeq = parseInt(latestLot.lotNumber.slice(-4), 10);
		if (!isNaN(lastSeq)) seq = lastSeq + 1;
	}

	return `${prefix}${String(seq).padStart(4, '0')}`;
}
