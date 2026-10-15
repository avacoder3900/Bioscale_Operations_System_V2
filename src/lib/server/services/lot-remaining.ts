/**
 * Per-lot remaining quantity from the inventory ledger — the one place this
 * math lives (perf, 2026-09-30). Before, the bucket board computed it for the
 * shell + label + thermoseal lots and thermoseal-service computed it again for
 * the thermoseal lots alone, on the same page load: two extra round trips that
 * each summed every consumption/scrap row those lots have ever had.
 *
 * remaining = lot quantity − |Σ consumption + scrap rows on that lotId|.
 * The aggregate rides the { lotId, transactionType, quantity } index, so it is
 * an index-only scan, but it still grows with every cartridge ever scanned in
 * — call it once per request and share the rows.
 */
import { connectDB, ReceivingLot, InventoryTransaction } from '$lib/server/db';

export interface LotRemaining {
	partNumber: string;
	lotId: string;
	quantity: number;
	remaining: number;
	createdAt: Date | null;
}

/** Accepted (not rejected/returned) lots of the given parts, with what is left on each. */
export async function lotRemaining(partNumbers: string[]): Promise<LotRemaining[]> {
	await connectDB();
	if (partNumbers.length === 0) return [];
	const lots = await ReceivingLot.find({
		'part.partNumber': { $in: partNumbers },
		status: { $nin: ['rejected', 'returned'] }
	}).select('lotId part.partNumber quantity createdAt').lean() as any[];
	if (lots.length === 0) return [];
	const agg = await InventoryTransaction.aggregate([
		{ $match: { lotId: { $in: lots.map(l => l.lotId) }, transactionType: { $in: ['consumption', 'scrap'] } } },
		{ $group: { _id: '$lotId', total: { $sum: '$quantity' } } }
	]) as any[];
	const consumed = new Map<string, number>(agg.map(r => [String(r._id), Math.abs(Number(r.total ?? 0))]));
	return lots
		.filter(l => typeof l.part?.partNumber === 'string' && typeof l.lotId === 'string')
		.map(l => ({
			partNumber: l.part.partNumber as string,
			lotId: l.lotId as string,
			quantity: Number(l.quantity ?? 0),
			remaining: Number(l.quantity ?? 0) - (consumed.get(l.lotId) ?? 0),
			createdAt: l.createdAt ? new Date(l.createdAt) : null
		}));
}

/** The oldest lot of `partNumber` that still has something left (FIFO), or null. */
export function fifoLot(rows: LotRemaining[], partNumber: string): { lotId: string; remaining: number } | null {
	const hit = rows
		.filter(r => r.partNumber === partNumber && r.remaining > 0)
		.sort((a, b) => (a.createdAt?.getTime() ?? 0) - (b.createdAt?.getTime() ?? 0))[0];
	return hit ? { lotId: hit.lotId, remaining: hit.remaining } : null;
}

/** Lots with stock, per part, largest remaining first — the shape the board's lot pickers use. */
export function lotsWithStock(rows: LotRemaining[], partNumbers: string[]): Record<string, { lotId: string; remaining: number }[]> {
	const out: Record<string, { lotId: string; remaining: number }[]> = Object.fromEntries(partNumbers.map(p => [p, []]));
	for (const r of rows) {
		if (!out[r.partNumber] || r.remaining <= 0) continue;
		out[r.partNumber].push({ lotId: r.lotId, remaining: r.remaining });
	}
	for (const pn of partNumbers) out[pn].sort((a, b) => b.remaining - a.remaining);
	return out;
}
