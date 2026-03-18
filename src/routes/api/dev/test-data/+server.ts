import { json } from '@sveltejs/kit';
import { connectDB, Consumable, CartridgeRecord, LotRecord } from '$lib/server/db';
import type { RequestHandler } from './$types';

export const GET: RequestHandler = async ({ url }) => {
	await connectDB();
	const type = url.searchParams.get('type');

	switch (type) {
		case 'oven-lot': {
			const lot = await LotRecord.findOne({ status: 'oven-ready' }).lean();
			if (!lot) return json({ error: 'No oven-ready lots found' }, { status: 404 });
			return json({ lotId: (lot as any).qrCodeRef || (lot as any)._id });
		}
		case 'deck': {
			const deck = await Consumable.findOne({ type: 'deck', status: 'available' }).lean();
			if (!deck) return json({ error: 'No available decks found' }, { status: 404 });
			return json({ deckId: (deck as any)._id });
		}
		case 'reagent-cartridge':
		case 'cartridge': {
			// Get a random cartridge — check both currentPhase and currentStage (seed uses currentStage)
			const exclude = url.searchParams.get('exclude')?.split(',').filter(Boolean) ?? [];
			const filter: Record<string, any> = {
				$or: [
					{ currentPhase: { $in: ['wax_stored', 'wax_filled', 'reagent_filling', 'backing'] } },
					{ currentStage: { $in: ['wax_filling', 'reagent_filling', 'backing'] } },
					{ currentPhase: { $exists: false }, currentStage: { $exists: true } }
				]
			};
			if (exclude.length > 0) filter._id = { $nin: exclude };
			// Use aggregate $sample for speed instead of count+skip
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
		default:
			return json({ error: 'type param required: oven-lot|deck|reagent-cartridge|tube' }, { status: 400 });
	}
};
