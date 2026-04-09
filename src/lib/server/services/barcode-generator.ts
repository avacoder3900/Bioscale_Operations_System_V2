import { connectDB } from '$lib/server/db/connection';
import { GeneratedBarcode } from '$lib/server/db/models';
import mongoose from 'mongoose';

/**
 * Generate a sequential barcode for a given prefix.
 * Uses atomic findOneAndUpdate to guarantee uniqueness.
 * Pattern: PREFIX-000001, PREFIX-000002, etc.
 *
 * Uses a separate counter collection to avoid the null barcode unique index issue.
 */
export async function generateBarcode(prefix: string, type: string): Promise<string> {
	await connectDB();
	const db = mongoose.connection.db!;

	// Atomic counter — separate from the generated_barcodes collection
	const counter = await db.collection('barcode_counters').findOneAndUpdate(
		{ _id: prefix },
		{ $inc: { seq: 1 } },
		{ upsert: true, returnDocument: 'after' }
	);

	const seq = counter?.seq ?? 1;
	const barcode = `${prefix}-${String(seq).padStart(6, '0')}`;

	// Store the generated barcode (ignore duplicate if re-run)
	try {
		await GeneratedBarcode.create({ barcode, prefix, type });
	} catch (err: any) {
		// If duplicate key on barcode, it's fine — barcode already exists
		if (err?.code !== 11000) throw err;
	}

	return barcode;
}

/**
 * Generate a part barcode: PART-000001, PART-000002, etc.
 */
export async function generatePartBarcode(): Promise<string> {
	return generateBarcode('PART', 'part');
}
