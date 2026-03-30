import { connectDB } from '$lib/server/db/connection';
import { GeneratedBarcode } from '$lib/server/db/models';
import { generateId } from '$lib/server/db/models';

const PART_PREFIX = 'PRT';

/**
 * Generate a unique part barcode using atomic $inc on the GeneratedBarcode collection.
 * Format: PRT-000001, PRT-000002, etc.
 */
export async function generatePartBarcode(): Promise<string> {
	await connectDB();

	const doc = await GeneratedBarcode.findOneAndUpdate(
		{ type: 'part_barcode', prefix: PART_PREFIX },
		{ $inc: { sequence: 1 } },
		{ upsert: true, new: true, setDefaultsOnInsert: true }
	);

	const seq = (doc as any).sequence ?? 1;
	const barcode = `${PART_PREFIX}-${String(seq).padStart(6, '0')}`;

	await GeneratedBarcode.create({
		_id: generateId(),
		prefix: PART_PREFIX,
		sequence: seq,
		barcode,
		type: 'part',
		createdAt: new Date()
	});

	return barcode;
}
