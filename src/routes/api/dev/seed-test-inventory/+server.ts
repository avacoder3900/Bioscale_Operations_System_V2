import { json } from '@sveltejs/kit';
import { connectDB, generateId, Consumable, LotRecord, CartridgeRecord } from '$lib/server/db';
import { WaxFillingRun } from '$lib/server/db/models/wax-filling-run.js';
import type { RequestHandler } from './$types';

const TEST_PREFIX = 'TEST-';
const COUNT = 200;

export const POST: RequestHandler = async () => {
	await connectDB();

	const created: Record<string, string[]> = {
		lots: [], decks: [], tubes: [], cartridges: [],
		ovenLots: [], reagentCartridges: []
	};

	// 1. Create test oven-ready lots (LotRecord)
	for (let i = 1; i <= COUNT; i++) {
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
				ovenEntryTime: new Date(Date.now() - 60 * 60 * 1000),
				status: 'oven-ready',
				startTime: new Date()
			});
		}
		created.lots.push(lotId);
	}

	// 2. Create test decks
	for (let i = 1; i <= COUNT; i++) {
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
	for (let i = 1; i <= COUNT; i++) {
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

	// 4. Create test cartridge records (for wax filling deck loading)
	for (let i = 1; i <= COUNT; i++) {
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

	// 5. Create completed WaxFillingRuns with ovenLocationId so oven lots appear
	//    These simulate completed wax runs whose cartridges are now "oven-ready"
	for (let i = 1; i <= 10; i++) {
		const runId = `${TEST_PREFIX}WXR-${String(i).padStart(3, '0')}`;
		const existing = await WaxFillingRun.findById(runId).lean();
		if (!existing) {
			const endTime = new Date(Date.now() - (120 * 60 * 1000)); // 2 hours ago (past min oven time)
			await WaxFillingRun.create({
				_id: runId,
				robot: { _id: 'robot-1', name: 'Robot 1' },
				status: 'completed',
				ovenLocationId: `OVEN-SLOT-${i}`,
				runStartTime: new Date(Date.now() - (180 * 60 * 1000)),
				runEndTime: endTime,
				plannedCartridgeCount: 24,
				operator: { _id: 'test-user', username: 'test' }
			});
		}
		created.ovenLots.push(runId);
	}

	// 6. Create reagent-stage cartridges (for reagent filling deck loading)
	for (let i = 1; i <= COUNT; i++) {
		const cartridgeId = `${TEST_PREFIX}RCART-${String(i).padStart(4, '0')}`;
		const existing = await CartridgeRecord.findOne({ _id: cartridgeId }).lean();
		if (!existing) {
			await CartridgeRecord.create({
				_id: cartridgeId,
				backing: {
					lotId: `${TEST_PREFIX}LOT-001`,
					lotQrCode: `${TEST_PREFIX}LOT-001`,
					ovenEntryTime: new Date(Date.now() - 3 * 60 * 60 * 1000),
					recordedAt: new Date()
				},
				waxFilling: {
					runId: `${TEST_PREFIX}WXR-001`,
					tubeId: `${TEST_PREFIX}TUBE-001`,
					deckPosition: (i % 24) + 1,
					filledAt: new Date(Date.now() - 2 * 60 * 60 * 1000)
				},
				currentStage: 'reagent_filling',
				currentInventory: 'Wax Filled Cartridge'
			});
		}
		created.reagentCartridges.push(cartridgeId);
	}

	return json({
		success: true,
		message: `Test inventory seeded (${COUNT} each)`,
		created: {
			lots: created.lots.length,
			decks: created.decks.length,
			tubes: created.tubes.length,
			cartridges: created.cartridges.length,
			ovenLots: created.ovenLots.length,
			reagentCartridges: created.reagentCartridges.length
		}
	});
};
