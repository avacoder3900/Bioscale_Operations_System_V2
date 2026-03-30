import { connectDB, Consumable } from '$lib/server/db';
import { requirePermission } from '$lib/server/permissions';
import type { PageServerLoad } from './$types';

export const load: PageServerLoad = async ({ locals }) => {
	requirePermission(locals.user, 'equipment:read');
	await connectDB();

	const [decks, trays] = await Promise.all([
		Consumable.find({ type: 'deck' }).sort({ _id: 1 }).lean(),
		Consumable.find({ type: 'cooling_tray' }).sort({ _id: 1 }).lean()
	]);

	// Build deck name map for tray references
	const deckMap = new Map(decks.map((d: any) => [d._id, d]));

	return {
		decks: decks.map((d: any) => ({
			id: d._id,
			name: d._id,
			description: d.notes ?? null,
			status: d.status ?? 'active',
			slots: 8 // default deck slot count
		})),
		trays: trays.map((t: any) => {
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
};
