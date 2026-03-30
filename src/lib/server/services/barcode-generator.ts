import { connectDB } from '$lib/server/db/connection';
import { GeneratedBarcode } from '$lib/server/db/models';
import { generateId } from '$lib/server/db/utils';

/**
 * Generate a sequential barcode for a given prefix.
 * Uses atomic findOneAndUpdate to guarantee uniqueness.
 * Pattern: PREFIX-000001, PREFIX-000002, etc.
 */
export async function generateBarcode(prefix: string, type: string): Promise<string> {
	await connectDB();
	const doc = await GeneratedBarcode.findOneAndUpdate(
		{ prefix },
		{ $inc: { sequence: 1 } },
		{ upsert: true, new: true, setDefaultsOnInsert: true }
	) as any;
	const seq = doc.sequence ?? 1;
	const barcode = `${prefix}-${String(seq).padStart(6, '0')}`;

	// Store the generated barcode for lookup/uniqueness
	await GeneratedBarcode.findByIdAndUpdate(doc._id, {
		$set: { barcode, type }
	});

	return barcode;
}

/**
 * Generate a part barcode: PART-000001, PART-000002, etc.
 */
export async function generatePartBarcode(): Promise<string> {
	return generateBarcode('PART', 'part');
}
