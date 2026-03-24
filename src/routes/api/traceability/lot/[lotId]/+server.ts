import { json } from '@sveltejs/kit';
import { connectDB, ReceivingLot, InventoryTransaction, CartridgeRecord } from '$lib/server/db';
import type { RequestHandler } from './$types';

export const GET: RequestHandler = async ({ locals, params }) => {
	if (!locals.user) return json({ error: 'Unauthorized' }, { status: 401 });
	await connectDB();

	// Find lot by _id or lotId (barcode)
	const lot = await ReceivingLot.findOne({
		$or: [{ _id: params.lotId }, { lotId: params.lotId }]
	}).lean() as any;
	if (!lot) return json({ error: 'Lot not found' }, { status: 404 });

	const lotIdentifiers = [lot._id, lot.lotId].filter(Boolean);

	const [transactions, linkedCartridges] = await Promise.all([
		InventoryTransaction.find({ lotId: { $in: lotIdentifiers } })
			.sort({ performedAt: -1 })
			.limit(500)
			.lean(),
		CartridgeRecord.find({
			$or: [
				{ 'backing.lotId': { $in: lotIdentifiers } },
				{ 'waxFilling.waxSourceLot': { $in: lotIdentifiers } },
				{ 'topSeal.topSealLotId': { $in: lotIdentifiers } }
			]
		})
			.select('_id currentPhase backing.lotId waxFilling.waxSourceLot topSeal.topSealLotId reagentFilling.assayType.name createdAt')
			.sort({ createdAt: -1 })
			.limit(200)
			.lean()
	]);

	// Group by manufacturing step
	const transactionsByStep: Record<string, any[]> = {};
	for (const tx of transactions as any[]) {
		const step = tx.manufacturingStep ?? 'other';
		if (!transactionsByStep[step]) transactionsByStep[step] = [];
		transactionsByStep[step].push(tx);
	}

	return json({
		success: true,
		lot: JSON.parse(JSON.stringify({
			_id: lot._id,
			lotId: lot.lotId,
			lotNumber: lot.lotNumber,
			part: lot.part,
			quantity: lot.quantity,
			status: lot.status,
			dispositionType: lot.dispositionType,
			disposedAt: lot.disposedAt
		})),
		transactionsByStep: JSON.parse(JSON.stringify(transactionsByStep)),
		linkedCartridges: JSON.parse(JSON.stringify((linkedCartridges as any[]).map((c: any) => ({
			cartridgeId: c._id,
			currentPhase: c.currentPhase ?? 'unknown',
			createdAt: c.createdAt
		})))),
		summary: {
			totalTransactions: (transactions as any[]).length,
			totalConsumed: (transactions as any[]).filter((t: any) => t.transactionType === 'consumption').reduce((s: number, t: any) => s + Math.abs(t.quantity ?? 0), 0),
			totalCreated: (transactions as any[]).filter((t: any) => t.transactionType === 'creation').reduce((s: number, t: any) => s + Math.abs(t.quantity ?? 0), 0),
			totalScrapped: (transactions as any[]).filter((t: any) => t.transactionType === 'scrap').reduce((s: number, t: any) => s + Math.abs(t.quantity ?? 0), 0),
			linkedCartridgeCount: (linkedCartridges as any[]).length
		}
	});
};
