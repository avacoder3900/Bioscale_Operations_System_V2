import { json } from '@sveltejs/kit';
import { connectDB, Consumable, LotRecord, CartridgeRecord } from '$lib/server/db';
import type { RequestHandler } from './$types';

export const GET: RequestHandler = async ({ url }) => {
	await connectDB();

	const type = url.searchParams.get('type');

	switch (type) {
		case 'oven-lot': {
			const lot = await LotRecord.findOne({ status: 'oven-ready' }).lean() as any;
			if (!lot) return json({ error: 'No test lots found' }, { status: 404 });
			return json({ lotId: lot.qrCodeRef });
		}

		case 'deck': {
			const deck = await Consumable.findOne({
				type: 'deck',
				status: { $in: ['available', 'Active'] },
				$or: [{ lockoutUntil: null }, { lockoutUntil: { $lt: new Date() } }]
			}).lean() as any;
			if (!deck) return json({ error: 'No test decks found' }, { status: 404 });
			return json({ deckId: deck._id });
		}

		case 'reagent-cartridge':
		case 'cartridge': {
			const cartridge = await CartridgeRecord.findOne({
				currentStage: { $in: ['wax_filling', 'reagent_filling', 'Backed Cartridge'] },
				'waxFilling.runId': { $exists: false }
			}).lean() as any;
			if (!cartridge) return json({ error: 'No test cartridges found' }, { status: 404 });
			return json({ cartridgeId: cartridge._id });
		}

		default:
			return json({ error: `Unknown type: ${type}. Valid: oven-lot, deck, reagent-cartridge` }, { status: 400 });
	}
};
