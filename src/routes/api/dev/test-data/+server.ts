import { json } from '@sveltejs/kit';
import { connectDB, Consumable, Equipment, CartridgeRecord, LotRecord, WaxBatch, ReceivingLot, PartDefinition, generateId } from '$lib/server/db';
import type { RequestHandler } from './$types';

export const GET: RequestHandler = async ({ url, locals }) => {
	if (!locals.user) return json({ error: 'Unauthorized' }, { status: 401 });
	await connectDB();
	const type = url.searchParams.get('type');

	switch (type) {
		case 'oven-lot': {
			const lot = await LotRecord.findOne({ status: 'oven-ready' }).lean();
			if (!lot) return json({ error: 'No oven-ready lots found' }, { status: 404 });
			return json({ lotId: (lot as any).qrCodeRef || (lot as any)._id });
		}
		case 'deck': {
			const deck = await Equipment.findOne({ equipmentType: 'deck', status: 'available' }).lean();
			if (!deck) return json({ error: 'No available decks found' }, { status: 404 });
			return json({ deckId: (deck as any)._id });
		}
		case 'reagent-cartridge':
		case 'cartridge': {
			// Get a random cartridge that has backing data (i.e. exists and is usable)
			const exclude = url.searchParams.get('exclude')?.split(',').filter(Boolean) ?? [];
			const filter: Record<string, any> = { 'backing.recordedAt': { $exists: true } };
			if (exclude.length > 0) filter._id = { $nin: exclude };
			const pipeline: any[] = [{ $match: filter }, { $sample: { size: 1 } }, { $project: { _id: 1 } }];
			const results = await CartridgeRecord.aggregate(pipeline);
			if (!results.length) return json({ error: 'No available cartridges found' }, { status: 404 });
			return json({ cartridgeId: results[0]._id });
		}
		case 'tube': {
			const tube = await Consumable.findOne({ type: 'incubator_tube', status: 'Active' }).lean();
			if (!tube) return json({ error: 'No active tubes found' }, { status: 404 });
			return json({ tubeId: (tube as any)._id });
		}
		case 'wax-batch': {
			// Return an existing WaxBatch with sufficient volume, or auto-create a test batch.
			let batch = await WaxBatch.findOne({ remainingVolumeUl: { $gte: 800 } })
				.sort({ createdAt: -1 }).lean() as any;
			if (!batch) {
				const lotBarcode = `TEST-WAX-${Date.now()}`;
				const year = new Date().getFullYear();
				const lotNumber = `WAX-${year}-TEST-${Math.floor(Math.random() * 10000)}`;
				const created = await WaxBatch.create({
					_id: generateId(),
					lotNumber,
					lotBarcode,
					initialVolumeUl: 60000,
					remainingVolumeUl: 60000,
					fullTubeCount: 5,
					partialTubeMl: 0,
					createdBy: { _id: locals.user._id, username: locals.user.username }
				});
				batch = created.toObject();
			}
			return json({ lotBarcode: batch.lotBarcode, lotNumber: batch.lotNumber, remainingVolumeUl: batch.remainingVolumeUl });
		}
		case 'receiving-lot': {
			// Return an existing ReceivingLot with quantity > 0, or auto-create one for a known part (PT-CT-something).
			const partNumber = url.searchParams.get('partNumber'); // optional filter
			const filter: any = { quantity: { $gt: 0 }, status: { $in: ['in_progress', 'accepted'] } };
			if (partNumber) filter['part.partNumber'] = partNumber;
			let lot = await ReceivingLot.findOne(filter).sort({ createdAt: -1 }).lean() as any;
			if (!lot) {
				// Auto-create using whatever the first active part is (or the requested partNumber)
				const part = partNumber
					? await PartDefinition.findOne({ partNumber }).lean() as any
					: await PartDefinition.findOne({ isActive: true }).lean() as any;
				if (!part) return json({ error: 'No part definitions to seed a test receiving lot' }, { status: 404 });
				const lotId = `TEST-LOT-${Date.now()}`;
				const created = await ReceivingLot.create({
					_id: generateId(),
					lotId,
					lotNumber: `LOT-${new Date().toISOString().slice(0, 10).replace(/-/g, '')}-TEST`,
					part: { _id: part._id, partNumber: part.partNumber, name: part.name },
					quantity: 100,
					operator: { _id: locals.user._id, username: locals.user.username },
					inspectionPathway: 'coc',
					status: 'accepted'
				});
				lot = created.toObject();
			}
			return json({
				lotId: lot.lotId,
				lotNumber: lot.lotNumber,
				partNumber: lot.part?.partNumber,
				partName: lot.part?.name,
				quantity: lot.quantity
			});
		}
		default:
			return json({ error: 'type param required: oven-lot|deck|reagent-cartridge|tube|wax-batch|receiving-lot' }, { status: 400 });
	}
};
