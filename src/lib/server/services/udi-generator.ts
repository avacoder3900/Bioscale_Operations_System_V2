import { connectDB } from '$lib/server/db/connection';
import { GeneratedBarcode, AuditLog, generateId } from '$lib/server/db';

const PREFIX = 'SPU';
const TYPE = 'spu';
const PAD = 6;

export async function generateNextSpuUdi(actor?: { _id: string; username: string }): Promise<string> {
	await connectDB();

	const doc = (await GeneratedBarcode.findOneAndUpdate(
		{ prefix: PREFIX },
		{ $inc: { sequence: 1 } },
		{ upsert: true, new: true, setDefaultsOnInsert: true }
	)) as any;

	const seq = doc.sequence ?? 1;
	const udi = `${PREFIX}-${String(seq).padStart(PAD, '0')}`;

	await GeneratedBarcode.findByIdAndUpdate(doc._id, {
		$set: { barcode: udi, type: TYPE }
	});

	await AuditLog.create({
		_id: generateId(),
		tableName: 'generated_barcodes',
		recordId: doc._id,
		action: 'INSERT',
		changedBy: actor?.username ?? actor?._id ?? 'system',
		changedAt: new Date(),
		details: { allocated: udi, kind: 'spu_udi' }
	});

	return udi;
}
