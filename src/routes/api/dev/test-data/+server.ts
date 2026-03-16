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
		case 'reagent-cartridge': {
			const cart = await CartridgeRecord.findOne({
				currentStage: 'reagent_filling',
				currentInventory: 'Wax Filled Cartridge'
			}).lean();
			if (!cart) return json({ error: 'No reagent-stage cartridges found' }, { status: 404 });
			return json({ cartridgeId: (cart as any)._id });
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
