import { json } from '@sveltejs/kit';
import { connectDB, generateId, Consumable, LotRecord, CartridgeRecord, EquipmentLocation } from '$lib/server/db';
import { Equipment } from '$lib/server/db/models/equipment.js';
import { WaxFillingRun } from '$lib/server/db/models/wax-filling-run.js';
import { OpentronsRobot } from '$lib/server/db/models/opentrons-robot.js';
import type { RequestHandler } from './$types';

const TEST_PREFIX = 'TEST-';
const COUNT = 200;

export const POST: RequestHandler = async ({ locals }) => {
	if (!locals.user) return json({ error: 'Unauthorized' }, { status: 401 });
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

	// 7. Equipment records — SKIPPED: equipment should only be created via the Equipment CRUD page
	// Fridges and ovens must be manually registered, not auto-seeded
	results.equipment = 0;
	const fridgeDefs: { name: string; barcode: string; capacity: number; shelves: number }[] = [];
	const ovenDefs: { name: string; barcode: string; capacity: number }[] = [];
	/*
	const fridgeDefs = [
		{ name: 'Fridge 001', barcode: 'FRG-001', capacity: 30, shelves: 3 },
		{ name: 'Fridge 002', barcode: 'FRG-002', capacity: 30, shelves: 3 },
		{ name: 'Fridge 003', barcode: 'FRG-003', capacity: 30, shelves: 3 }
	];
	const ovenDefs = [
		{ name: 'Oven 001', barcode: 'OVN-001', capacity: 6 },
		{ name: 'Oven 002', barcode: 'OVN-002', capacity: 6 },
		{ name: 'Oven 003', barcode: 'OVN-003', capacity: 6 }
	];
	*/

	// Equipment seeding disabled — use Equipment CRUD page instead
	// const equipOps = [...]; const equipResult = await Equipment.bulkWrite(equipOps);

	// 8. Child shelf locations for fridges (linked to parent Equipment via parentEquipmentId)
	const fridgeEquipDocs = await Equipment.find({ equipmentType: 'fridge' }).lean() as any[];
	let shelfCount = 0;
	for (const fridge of fridgeEquipDocs) {
		const def = fridgeDefs.find(f => f.name === fridge.name);
		const numShelves = def?.shelves ?? 3;
		for (let s = 1; s <= numShelves; s++) {
			const shelfName = `${fridge.name} - Shelf ${s}`;
			const shelfBarcode = `${fridge.barcode}-S${s}`;
			const existing = await EquipmentLocation.findOne({ barcode: shelfBarcode }).lean();
			if (!existing) {
				await EquipmentLocation.create({
					_id: generateId(),
					parentEquipmentId: String(fridge._id),
					displayName: shelfName,
					barcode: shelfBarcode,
					locationType: 'fridge',
					isActive: true,
					capacity: 10,
					notes: `Shelf ${s} of ${fridge.name}`
				});
				shelfCount++;
			}
		}
	}
	results.fridges = shelfCount;

	// 9. Child locations for ovens (single slot each)
	const ovenEquipDocs = await Equipment.find({ equipmentType: 'oven' }).lean() as any[];
	let ovenLocCount = 0;
	for (const oven of ovenEquipDocs) {
		const existing = await EquipmentLocation.findOne({ parentEquipmentId: String(oven._id) }).lean();
		if (!existing) {
			await EquipmentLocation.create({
				_id: generateId(),
				parentEquipmentId: String(oven._id),
				displayName: oven.name,
				barcode: oven.barcode,
				locationType: 'oven',
				isActive: true,
				capacity: oven.capacity ?? 6,
				notes: `Oven location for ${oven.name}`
			});
			ovenLocCount++;
		}
	}
	results.ovens = ovenLocCount;

	return json({
		success: true,
		message: `Test inventory seeded (${COUNT} target each)`,
		created: results
	});
};
