import { connectDB, Consumable } from '$lib/server/db';
import type { PageServerLoad } from './$types';

export const load: PageServerLoad = async () => {
	try {
		await connectDB();

		const [decks, trays] = await Promise.all([
			Consumable.find({ type: 'deck' }).sort({ _id: 1 }).lean(),
			Consumable.find({ type: 'cooling_tray' }).sort({ _id: 1 }).lean()
		]);

		// Build deck name map for tray references
		const deckMap = new Map((decks as any[]).map((d: any) => [d._id, d]));

		return {
			decks: (decks as any[]).map((d: any) => ({
				id: d._id,
				name: d._id,
				description: d.notes ?? null,
				status: d.status ?? 'active',
				slots: 8 // default deck slot count
			})),
			trays: (trays as any[]).map((t: any) => {
				const deck = t.currentRobotId ? deckMap.get(t.currentRobotId) : null;
				return {
					id: t._id,
					name: t._id,
					description: t.notes ?? null,
					status: t.status ?? 'active',
					deckId: t.currentRobotId ?? null,
					deckName: deck ? (deck as any)._id : null
				};
			})
		};
	} catch (err) {
		console.error('[EQUIPMENT decks-trays] Load error:', err instanceof Error ? err.message : err);
		return { decks: [], trays: [] };
	}
};
