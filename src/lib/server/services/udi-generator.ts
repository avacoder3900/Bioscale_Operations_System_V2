import { connectDB } from '$lib/server/db/connection';
import { GeneratedBarcode, Spu, AuditLog, generateId } from '$lib/server/db';

const PREFIX_KEY = 'SPU_BT_M01';
const TYPE = 'spu';
const PAD = 4;
const FAMILY_PREFIX = 'BT-M01';
const UDI_RE = /^BT-M01-(\d{4})-(\d{4})$/;
const MAX_PROBE = 1000;

function formatUdi(group3: string, seq: number): string {
	return `${FAMILY_PREFIX}-${group3}-${String(seq).padStart(PAD, '0')}`;
}

async function highestExistingUdi(): Promise<{ group3: string; seq: number } | null> {
	const candidates: any[] = await Spu.find(
		{ udi: { $regex: '^BT-M01-\\d{4}-\\d{4}$' } },
		{ udi: 1 }
	)
		.lean()
		.limit(0);
	let best: { group3: string; seq: number } | null = null;
	for (const c of candidates) {
		const m = (c.udi as string).match(UDI_RE);
		if (!m) continue;
		const seq = parseInt(m[2], 10);
		if (!Number.isFinite(seq)) continue;
		if (!best || seq > best.seq) best = { group3: m[1], seq };
	}
	return best;
}

export async function generateNextSpuUdi(actor?: { _id: string; username: string }): Promise<string> {
	await connectDB();

	const highest = await highestExistingUdi();
	const group3 = highest?.group3 ?? '0000';
	const startFloor = highest?.seq ?? 0;

	await GeneratedBarcode.updateOne(
		{ prefix: PREFIX_KEY, sequence: { $lt: startFloor } },
		{ $set: { sequence: startFloor } },
		{ upsert: false }
	);

	const counter = (await GeneratedBarcode.findOneAndUpdate(
		{ prefix: PREFIX_KEY },
		{ $inc: { sequence: 1 } },
		{ upsert: true, new: true, setDefaultsOnInsert: true }
	)) as any;

	let seq: number = counter.sequence ?? 1;
	if (seq <= startFloor) {
		const bumped = (await GeneratedBarcode.findByIdAndUpdate(
			counter._id,
			{ $set: { sequence: startFloor + 1 } },
			{ new: true }
		)) as any;
		seq = bumped.sequence;
	}

	let udi = formatUdi(group3, seq);
	let probes = 0;
	while (probes < MAX_PROBE) {
		const collision = await Spu.exists({ udi });
		if (!collision) break;
		probes++;
		const next = (await GeneratedBarcode.findOneAndUpdate(
			{ prefix: PREFIX_KEY },
			{ $inc: { sequence: 1 } },
			{ new: true }
		)) as any;
		seq = next.sequence;
		udi = formatUdi(group3, seq);
	}
	if (probes >= MAX_PROBE) throw new Error('Unable to allocate unique SPU UDI after probing');

	await GeneratedBarcode.findByIdAndUpdate(counter._id, {
		$set: { barcode: udi, type: TYPE }
	});

	await AuditLog.create({
		_id: generateId(),
		tableName: 'generated_barcodes',
		recordId: counter._id,
		action: 'INSERT',
		changedBy: actor?.username ?? actor?._id ?? 'system',
		changedAt: new Date(),
		newData: { allocated: udi, kind: 'spu_udi', group3, seq, probes }
	});

	return udi;
}
