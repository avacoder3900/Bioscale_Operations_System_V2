import { json } from '@sveltejs/kit';
import { connectDB, generateId, Consumable, LotRecord, CartridgeRecord, EquipmentLocation } from '$lib/server/db';
import { Equipment } from '$lib/server/db/models/equipment.js';
import { WaxFillingRun } from '$lib/server/db/models/wax-filling-run.js';
import { OpentronsRobot } from '$lib/server/db/models/opentrons-robot.js';
import type { RequestHandler } from './$types';

const TEST_PREFIX = 'TEST-';
const COUNT = 200;

export const POST: RequestHandler = async () => {
	await connectDB();

	const results: Record<string, number | string[]> = {};

	// 0. Find all active robots so oven lots match real robot IDs
	const robots = await OpentronsRobot.find({ isActive: true }, { _id: 1, name: 1 }).lean();
	const robotIds = robots.map((r: any) => String(r._id));
	if (!robotIds.length) robotIds.push('robot-1');
	results.robotIds = robotIds;

	// 1. Lots (bulk upsert)
	const lotOps = Array.from({ length: COUNT }, (_, i) => {
		const lotId = `${TEST_PREFIX}LOT-${String(i + 1).padStart(3, '0')}`;
		return {
			updateOne: {
				filter: { qrCodeRef: lotId },
				update: {
					$setOnInsert: {
						_id: generateId(),
						qrCodeRef: lotId,
						processConfig: { _id: 'wax-filling', processName: 'Wax Filling', processType: 'manufacturing' },
						operator: { _id: 'test-user', username: 'test' },
						quantityProduced: 24, desiredQuantity: 24,
						ovenEntryTime: new Date(Date.now() - 60 * 60 * 1000),
						status: 'oven-ready', startTime: new Date()
					}
				},
				upsert: true
			}
		};
	});
	const lotResult = await LotRecord.bulkWrite(lotOps);
	results.lots = lotResult.upsertedCount;

	// 2. Decks
	const deckOps = Array.from({ length: COUNT }, (_, i) => {
		const deckId = `${TEST_PREFIX}DECK-${String(i + 1).padStart(3, '0')}`;
		return {
			updateOne: {
				filter: { _id: deckId },
				update: { $setOnInsert: { _id: deckId, type: 'deck', status: 'available' } },
				upsert: true
			}
		};
	});
	const deckResult = await Consumable.bulkWrite(deckOps);
	results.decks = deckResult.upsertedCount;

	// 2b. Cooling trays
	const trayOps = Array.from({ length: 20 }, (_, i) => {
		const trayId = `${TEST_PREFIX}TRAY-${String(i + 1).padStart(3, '0')}`;
		return {
			updateOne: {
				filter: { _id: trayId },
				update: { $setOnInsert: { _id: trayId, type: 'cooling_tray', status: 'available' } },
				upsert: true
			}
		};
	});
	const trayResult = await Consumable.bulkWrite(trayOps);
	results.trays = trayResult.upsertedCount;

	// 3. Incubator tubes
	const tubeOps = Array.from({ length: COUNT }, (_, i) => {
		const tubeId = `${TEST_PREFIX}TUBE-${String(i + 1).padStart(3, '0')}`;
		return {
			updateOne: {
				filter: { _id: tubeId },
				update: {
					$setOnInsert: {
						_id: tubeId, type: 'incubator_tube', status: 'Active',
						initialVolumeUl: 2000, remainingVolumeUl: 2000,
						totalCartridgesFilled: 0, totalRunsUsed: 0, registeredBy: 'test'
					}
				},
				upsert: true
			}
		};
	});
	const tubeResult = await Consumable.bulkWrite(tubeOps);
	results.tubes = tubeResult.upsertedCount;

	// 4. Wax-stage cartridges
	const cartOps = Array.from({ length: COUNT }, (_, i) => {
		const cartridgeId = `${TEST_PREFIX}CART-${String(i + 1).padStart(4, '0')}`;
		const lotIndex = Math.ceil((i + 1) / 24);
		return {
			updateOne: {
				filter: { _id: cartridgeId },
				update: {
					$setOnInsert: {
						_id: cartridgeId,
						backing: {
							lotId: `${TEST_PREFIX}LOT-${String(lotIndex).padStart(3, '0')}`,
							lotQrCode: `${TEST_PREFIX}LOT-${String(lotIndex).padStart(3, '0')}`,
							ovenEntryTime: new Date(Date.now() - 60 * 60 * 1000),
							recordedAt: new Date()
						},
						currentStage: 'wax_filling', currentInventory: 'Backed Cartridge'
					}
				},
				upsert: true
			}
		};
	});
	const cartResult = await CartridgeRecord.bulkWrite(cartOps);
	results.cartridges = cartResult.upsertedCount;

	// 5. Completed WaxFillingRuns with ovenLocationId (oven lots for deck loading)
	//    Create 10 per robot so they show up regardless of which robot is selected
	const waxRunOps: any[] = [];
	for (const rid of robotIds) {
		for (let i = 1; i <= 10; i++) {
			const runId = `${TEST_PREFIX}WXR-${rid}-${String(i).padStart(3, '0')}`;
			waxRunOps.push({
				updateOne: {
					filter: { _id: runId },
					update: {
						$setOnInsert: {
							_id: runId,
							robot: { _id: rid, name: `Robot ${rid}` },
							status: 'completed',
							ovenLocationId: `OVEN-SLOT-${i}`,
							runStartTime: new Date(Date.now() - 180 * 60 * 1000),
							runEndTime: new Date(Date.now() - 120 * 60 * 1000),
							plannedCartridgeCount: 24,
							operator: { _id: 'test-user', username: 'test' }
						}
					},
					upsert: true
				}
			});
		}
	}
	const waxResult = await WaxFillingRun.bulkWrite(waxRunOps);
	results.ovenLots = waxResult.upsertedCount;

	// 6. Reagent-stage cartridges
	const reagentOps = Array.from({ length: COUNT }, (_, i) => {
		const cartridgeId = `${TEST_PREFIX}RCART-${String(i + 1).padStart(4, '0')}`;
		return {
			updateOne: {
				filter: { _id: cartridgeId },
				update: {
					$setOnInsert: {
						_id: cartridgeId,
						backing: {
							lotId: `${TEST_PREFIX}LOT-001`, lotQrCode: `${TEST_PREFIX}LOT-001`,
							ovenEntryTime: new Date(Date.now() - 3 * 60 * 60 * 1000),
							recordedAt: new Date()
						},
						waxFilling: {
							runId: `${TEST_PREFIX}WXR-001`, tubeId: `${TEST_PREFIX}TUBE-001`,
							deckPosition: (i % 24) + 1,
							filledAt: new Date(Date.now() - 2 * 60 * 60 * 1000)
						},
						currentStage: 'reagent_filling', currentInventory: 'Wax Filled Cartridge'
					}
				},
				upsert: true
			}
		};
	});
	const reagentResult = await CartridgeRecord.bulkWrite(reagentOps);
	results.reagentCartridges = reagentResult.upsertedCount;

	// 7. Fridges
	const fridgeNames = ['Fridge 1', 'Fridge 2', 'Fridge 3'];
	const fridgeOps = fridgeNames.map((name, i) => ({
		updateOne: {
			filter: { displayName: name, locationType: 'fridge' },
			update: {
				$setOnInsert: {
					_id: generateId(),
					displayName: name,
					barcode: `FRG-${String(i + 1).padStart(3, '0')}`,
					locationType: 'fridge',
					isActive: true,
					capacity: 10,
					notes: `Test fridge ${i + 1}`
				}
			},
			upsert: true
		}
	}));
	const fridgeResult = await EquipmentLocation.bulkWrite(fridgeOps);
	results.fridges = fridgeResult.upsertedCount;

	// 8. Ovens
	const ovenNames = ['Oven 1', 'Oven 2', 'Oven 3'];
	const ovenOps = ovenNames.map((name, i) => ({
		updateOne: {
			filter: { displayName: name, locationType: 'oven' },
			update: {
				$setOnInsert: {
					_id: generateId(),
					displayName: name,
					barcode: `OVN-${String(i + 1).padStart(3, '0')}`,
					locationType: 'oven',
					isActive: true,
					capacity: 6,
					notes: `Test oven ${i + 1}`
				}
			},
			upsert: true
		}
	}));
	const ovenResult = await EquipmentLocation.bulkWrite(ovenOps);
	results.ovens = ovenResult.upsertedCount;

	// 9. Equipment records (for equipment overview page)
	const equipOps = [
		...fridgeNames.map((name, i) => ({
			updateOne: {
				filter: { name, equipmentType: 'fridge' },
				update: {
					$setOnInsert: {
						_id: generateId(), name, equipmentType: 'fridge',
						status: 'active', currentTemperatureC: 2 + Math.random() * 4,
						notes: `Test fridge ${i + 1}`
					}
				},
				upsert: true
			}
		})),
		...ovenNames.map((name, i) => ({
			updateOne: {
				filter: { name, equipmentType: 'oven' },
				update: {
					$setOnInsert: {
						_id: generateId(), name, equipmentType: 'oven',
						status: 'active', currentTemperatureC: 60 + Math.random() * 10,
						notes: `Test oven ${i + 1}`
					}
				},
				upsert: true
			}
		}))
	];
	const equipResult = await Equipment.bulkWrite(equipOps);
	results.equipment = equipResult.upsertedCount;

	return json({
		success: true,
		message: `Test inventory seeded (${COUNT} target each)`,
		created: results
	});
};
