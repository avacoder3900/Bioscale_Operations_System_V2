import { connectDB } from '$lib/server/db/connection';
import { GeneratedBarcode, Spu, AuditLog, generateId } from '$lib/server/db';

const PREFIX = 'SPU';
const TYPE = 'spu';
const PAD = 6;
const MAX_PROBE = 1000;

async function highestExistingSpuSequence(): Promise<number> {
	const re = new RegExp(`^${PREFIX}-(\\d+)$`);
	const candidates: any[] = await Spu.find({ udi: { $regex: `^${PREFIX}-\\d+$` } }, { udi: 1 })
		.lean()
		.limit(0);
	let max = 0;
	for (const c of candidates) {
		const m = (c.udi as string).match(re);
		if (m) {
			const n = parseInt(m[1], 10);
			if (Number.isFinite(n) && n > max) max = n;
		}
	}
	return max;
}

async function bumpSequenceAtLeast(current: number, target: number): Promise<number> {
	if (current >= target) return current;
	const doc = (await GeneratedBarcode.findOneAndUpdate(
		{ prefix: PREFIX },
		{ $set: { sequence: target } },
		{ upsert: true, new: true, setDefaultsOnInsert: true }
	)) as any;
	return doc.sequence ?? target;
}

export async function generateNextSpuUdi(actor?: { _id: string; username: string }): Promise<string> {
	await connectDB();

	let doc = (await GeneratedBarcode.findOneAndUpdate(
		{ prefix: PREFIX },
		{ $inc: { sequence: 1 } },
		{ upsert: true, new: true, setDefaultsOnInsert: true }
	)) as any;
	let seq: number = doc.sequence ?? 1;

	if (seq <= 1) {
		const existingMax = await highestExistingSpuSequence();
		if (existingMax > 0) {
			seq = await bumpSequenceAtLeast(seq, existingMax + 1);
		}
	}

	let udi = `${PREFIX}-${String(seq).padStart(PAD, '0')}`;
	let probes = 0;
	while (probes < MAX_PROBE) {
		const collision = await Spu.exists({ udi });
		if (!collision) break;
		probes++;
		const next = (await GeneratedBarcode.findOneAndUpdate(
			{ prefix: PREFIX },
			{ $inc: { sequence: 1 } },
			{ new: true }
		)) as any;
		seq = next.sequence;
		udi = `${PREFIX}-${String(seq).padStart(PAD, '0')}`;
	}
	if (probes >= MAX_PROBE) throw new Error('Unable to allocate unique SPU UDI after probing');

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
		newData: { allocated: udi, kind: 'spu_udi', probes }
	});

	return udi;
}
