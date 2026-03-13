import { json } from '@sveltejs/kit';
import { connectDB, generateId, Consumable, LotRecord, CartridgeRecord } from '$lib/server/db';
import type { RequestHandler } from './$types';

const TEST_PREFIX = 'TEST-';

export const POST: RequestHandler = async () => {
	await connectDB();

	const created: Record<string, string[]> = { lots: [], decks: [], tubes: [], cartridges: [] };

	// 1. Create test oven-ready lots (backed cartridge lots with ovenEntryTime)
	for (let i = 1; i <= 3; i++) {
		const lotId = `${TEST_PREFIX}LOT-${String(i).padStart(3, '0')}`;
		const existing = await LotRecord.findOne({ qrCodeRef: lotId }).lean();
		if (!existing) {
			await LotRecord.create({
				_id: generateId(),
				qrCodeRef: lotId,
				processConfig: { _id: 'wax-filling', processName: 'Wax Filling', processType: 'manufacturing' },
				operator: { _id: 'test-user', username: 'test' },
				quantityProduced: 24,
				desiredQuantity: 24,
				ovenEntryTime: new Date(Date.now() - 60 * 60 * 1000), // 1 hour ago
				status: 'oven-ready',
				startTime: new Date()
			});
		}
		created.lots.push(lotId);
	}

	// 2. Create test decks
	for (let i = 1; i <= 2; i++) {
		const deckId = `${TEST_PREFIX}DECK-${String(i).padStart(3, '0')}`;
		const existing = await Consumable.findOne({ _id: deckId }).lean();
		if (!existing) {
			await Consumable.create({
				_id: deckId,
				type: 'deck',
				status: 'available'
			});
		}
		created.decks.push(deckId);
	}

	// 3. Create test incubator tubes
	for (let i = 1; i <= 2; i++) {
		const tubeId = `${TEST_PREFIX}TUBE-${String(i).padStart(3, '0')}`;
		const existing = await Consumable.findOne({ _id: tubeId }).lean();
		if (!existing) {
			await Consumable.create({
				_id: tubeId,
				type: 'incubator_tube',
				status: 'Active',
				initialVolumeUl: 2000,
				remainingVolumeUl: 2000,
				totalCartridgesFilled: 0,
				totalRunsUsed: 0,
				registeredBy: 'test'
			});
		}
		created.tubes.push(tubeId);
	}

	// 4. Create test cartridge records (for deck loading)
	for (let i = 1; i <= 48; i++) {
		const cartridgeId = `${TEST_PREFIX}CART-${String(i).padStart(4, '0')}`;
		const existing = await CartridgeRecord.findOne({ _id: cartridgeId }).lean();
		if (!existing) {
			const lotIndex = Math.ceil(i / 24);
			await CartridgeRecord.create({
				_id: cartridgeId,
				backing: {
					lotId: `${TEST_PREFIX}LOT-${String(lotIndex).padStart(3, '0')}`,
					lotQrCode: `${TEST_PREFIX}LOT-${String(lotIndex).padStart(3, '0')}`,
					ovenEntryTime: new Date(Date.now() - 60 * 60 * 1000),
					recordedAt: new Date()
				},
				currentStage: 'wax_filling',
				currentInventory: 'Backed Cartridge'
			});
		}
		created.cartridges.push(cartridgeId);
	}

	return json({
		success: true,
		message: 'Test inventory seeded',
		created
	});
};
