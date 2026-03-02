/**
 * Seed script for domain data (everything except auth).
 * Run AFTER scripts/seed.ts (which creates roles + users).
 *
 * Usage: npx tsx scripts/seed-domain-data.ts
 *
 * Creates test data for all major domains so that routes can be visually
 * verified during manual testing. Uses upsert pattern to be idempotent.
 */
import mongoose from 'mongoose';
import { nanoid } from 'nanoid';
import * as dotenv from 'dotenv';
import { fileURLToPath } from 'url';
import { dirname, resolve } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
dotenv.config({ path: resolve(__dirname, '..', '.env') });

const MONGODB_URI = process.env.MONGODB_URI;
if (!MONGODB_URI) {
	console.error('MONGODB_URI not found in .env');
	process.exit(1);
}

// Helpers
const id = () => nanoid();
const ago = (days: number) => new Date(Date.now() - days * 24 * 60 * 60 * 1000);
const hoursAgo = (h: number) => new Date(Date.now() - h * 60 * 60 * 1000);
const now = new Date();

async function upsertMany(
	db: mongoose.mongo.Db,
	collection: string,
	docs: any[],
	matchField = '_id'
) {
	const col = db.collection(collection);
	for (const doc of docs) {
		const { _id, ...rest } = doc;
		await col.updateOne(
			{ [matchField]: doc[matchField] },
			{ $set: rest, $setOnInsert: { _id } },
			{ upsert: true }
		);
	}
	console.log(`  ${collection}: ${docs.length} documents upserted`);
}

async function seed() {
	console.log('Connecting to MongoDB...');
	await mongoose.connect(MONGODB_URI!);
	console.log('Connected!\n');
	const db = mongoose.connection.db!;

	// ─── Lookup existing users ──────────────────────────────────────
	const users = db.collection('users');
	const admin = await users.findOne({ username: 'contracttest' });
	const operator = await users.findOne({ username: 'operator1' });
	if (!admin || !operator) {
		console.error('Run scripts/seed.ts first to create users.');
		process.exit(1);
	}
	const adminRef = { _id: admin._id as string, username: admin.username as string };
	const operatorRef = { _id: operator._id as string, username: operator.username as string };

	// ─── 1. Process Configurations (manufacturing) ──────────────────
	console.log('Seeding process configurations...');
	const backingConfigId = id();
	const waxConfigId = id();
	const reagentConfigId = id();
	await upsertMany(db, 'processconfigurations', [
		{
			_id: backingConfigId, processName: 'Backing', processType: 'backing',
			maxBatchSize: 96, steps: [
				{ stepNumber: 1, title: 'Load backing material', description: 'Place material on tray' },
				{ stepNumber: 2, title: 'Apply adhesive', description: 'Apply adhesive per WI' },
				{ stepNumber: 3, title: 'Oven cure', description: 'Transfer to oven' }
			],
			createdAt: ago(30), updatedAt: ago(30)
		},
		{
			_id: waxConfigId, processName: 'Wax Filling', processType: 'wax_filling',
			maxBatchSize: 48, steps: [
				{ stepNumber: 1, title: 'Setup robot', description: 'Prepare Opentrons' },
				{ stepNumber: 2, title: 'Load deck', description: 'Place cartridges on deck' },
				{ stepNumber: 3, title: 'Run protocol', description: 'Execute filling protocol' }
			],
			createdAt: ago(30), updatedAt: ago(30)
		},
		{
			_id: reagentConfigId, processName: 'Reagent Filling', processType: 'reagent_filling',
			maxBatchSize: 48, steps: [
				{ stepNumber: 1, title: 'Prepare reagents', description: 'Thaw and vortex' },
				{ stepNumber: 2, title: 'Load robot', description: 'Place tubes and cartridges' },
				{ stepNumber: 3, title: 'Run filling', description: 'Execute reagent protocol' }
			],
			createdAt: ago(30), updatedAt: ago(30)
		}
	], 'processName');

	// Re-fetch to get actual IDs
	const configs = db.collection('processconfigurations');
	const actualBackingConfig = await configs.findOne({ processName: 'Backing' });
	const actualWaxConfig = await configs.findOne({ processName: 'Wax Filling' });
	const actualReagentConfig = await configs.findOne({ processName: 'Reagent Filling' });

	// ─── 2. Lot Records (manufacturing) ─────────────────────────────
	console.log('Seeding lot records...');
	const lotIds = [id(), id(), id(), id(), id()];
	await upsertMany(db, 'lotrecords', [
		{
			_id: lotIds[0], qrCodeRef: 'LOT-BK-001',
			processConfig: { _id: actualBackingConfig!._id, processName: 'Backing', processType: 'backing' },
			operator: operatorRef, quantityProduced: 48, desiredQuantity: 48,
			status: 'completed', startTime: hoursAgo(6), finishTime: hoursAgo(4), cycleTime: 120,
			createdAt: hoursAgo(6), updatedAt: hoursAgo(4)
		},
		{
			_id: lotIds[1], qrCodeRef: 'LOT-BK-002',
			processConfig: { _id: actualBackingConfig!._id, processName: 'Backing', processType: 'backing' },
			operator: operatorRef, quantityProduced: 24, desiredQuantity: 48,
			status: 'completed', startTime: hoursAgo(3), finishTime: hoursAgo(1), cycleTime: 90,
			quantityDiscrepancyReason: 'Material shortage',
			createdAt: hoursAgo(3), updatedAt: hoursAgo(1)
		},
		{
			_id: lotIds[2], qrCodeRef: 'LOT-WX-001',
			processConfig: { _id: actualWaxConfig!._id, processName: 'Wax Filling', processType: 'wax_filling' },
			operator: operatorRef, quantityProduced: 48, desiredQuantity: 48,
			status: 'completed', startTime: ago(1), finishTime: hoursAgo(20), cycleTime: 45,
			createdAt: ago(1), updatedAt: hoursAgo(20)
		},
		{
			_id: lotIds[3], qrCodeRef: 'LOT-WX-002',
			processConfig: { _id: actualWaxConfig!._id, processName: 'Wax Filling', processType: 'wax_filling' },
			operator: adminRef, quantityProduced: 0, desiredQuantity: 48,
			status: 'in_progress', startTime: hoursAgo(1), finishTime: null, cycleTime: null,
			createdAt: hoursAgo(1), updatedAt: now
		},
		{
			_id: lotIds[4], qrCodeRef: 'LOT-RG-001',
			processConfig: { _id: actualReagentConfig!._id, processName: 'Reagent Filling', processType: 'reagent_filling' },
			operator: operatorRef, quantityProduced: 48, desiredQuantity: 48,
			status: 'completed', startTime: ago(2), finishTime: ago(2), cycleTime: 60,
			createdAt: ago(2), updatedAt: ago(2)
		}
	], 'qrCodeRef');

	// ─── 3. Assay Definitions ───────────────────────────────────────
	console.log('Seeding assay definitions...');
	const assayIds = [id(), id(), id()];
	await upsertMany(db, 'assaydefinitions', [
		{
			_id: assayIds[0], assayId: 'ASSAY-CRP', name: 'CRP Assay', skuCode: 'SKU-CRP-100',
			description: 'C-Reactive Protein quantitative assay',
			duration: 15, bcodeLength: 128, checksum: 42, isActive: true, shelfLifeDays: 180,
			reagents: [
				{ wellPosition: 1, reagentName: 'CRP Antibody', unitCost: '2.50', volumeMicroliters: 50, unit: 'uL', classification: 'antibody', isActive: true, sortOrder: 1 },
				{ wellPosition: 2, reagentName: 'Conjugate Buffer', unitCost: '0.80', volumeMicroliters: 100, unit: 'uL', classification: 'buffer', isActive: true, sortOrder: 2 },
				{ wellPosition: 3, reagentName: 'Substrate', unitCost: '1.20', volumeMicroliters: 75, unit: 'uL', classification: 'substrate', isActive: true, sortOrder: 3 }
			],
			versionHistory: [], corrections: [],
			createdAt: ago(60), updatedAt: ago(5)
		},
		{
			_id: assayIds[1], assayId: 'ASSAY-PCT', name: 'Procalcitonin Assay', skuCode: 'SKU-PCT-100',
			description: 'Procalcitonin semi-quantitative assay',
			duration: 20, bcodeLength: 256, checksum: 77, isActive: true, shelfLifeDays: 120,
			reagents: [
				{ wellPosition: 1, reagentName: 'PCT Antibody', unitCost: '5.00', volumeMicroliters: 50, unit: 'uL', classification: 'antibody', isActive: true, sortOrder: 1 },
				{ wellPosition: 2, reagentName: 'Gold Conjugate', unitCost: '3.00', volumeMicroliters: 50, unit: 'uL', classification: 'conjugate', isActive: true, sortOrder: 2 }
			],
			versionHistory: [], corrections: [],
			createdAt: ago(45), updatedAt: ago(10)
		},
		{
			_id: assayIds[2], assayId: 'ASSAY-FER', name: 'Ferritin Assay', skuCode: 'SKU-FER-100',
			description: 'Ferritin quantitative assay (discontinued)',
			duration: 12, bcodeLength: 128, checksum: 33, isActive: false, shelfLifeDays: 90,
			reagents: [
				{ wellPosition: 1, reagentName: 'Ferritin Ab', unitCost: '2.00', volumeMicroliters: 50, unit: 'uL', classification: 'antibody', isActive: true, sortOrder: 1 }
			],
			versionHistory: [], corrections: [],
			createdAt: ago(90), updatedAt: ago(30)
		}
	], 'skuCode');

	// Re-fetch assays
	const assayCol = db.collection('assaydefinitions');
	const actualAssays = await assayCol.find({}).toArray();
	const crpAssay = actualAssays.find(a => a.skuCode === 'SKU-CRP-100');
	const pctAssay = actualAssays.find(a => a.skuCode === 'SKU-PCT-100');

	// ─── 4. Equipment & Locations ───────────────────────────────────
	console.log('Seeding equipment and locations...');
	const fridgeId = id();
	const ovenId = id();
	await upsertMany(db, 'equipment', [
		{
			_id: fridgeId, name: 'Fridge A', equipmentType: 'fridge', location: 'Lab Room 101',
			status: 'active', currentTemperatureC: 4.2, temperatureMinC: 2, temperatureMaxC: 8,
			lastTemperatureReadAt: hoursAgo(0.5), notes: 'Primary cartridge storage',
			createdAt: ago(90), updatedAt: now
		},
		{
			_id: ovenId, name: 'Oven 1', equipmentType: 'oven', location: 'Lab Room 102',
			status: 'active', currentTemperatureC: 37.5, temperatureMinC: 35, temperatureMaxC: 40,
			lastTemperatureReadAt: hoursAgo(0.5), notes: 'Curing oven',
			createdAt: ago(90), updatedAt: now
		}
	], 'name');

	const actualFridge = await db.collection('equipment').findOne({ name: 'Fridge A' });
	const actualOven = await db.collection('equipment').findOne({ name: 'Oven 1' });

	const locIds = [id(), id(), id(), id()];
	await upsertMany(db, 'equipmentlocations', [
		{
			_id: locIds[0], barcode: 'LOC-FR-A1', locationType: 'fridge', displayName: 'Fridge A - Shelf 1',
			isActive: true, capacity: 48, currentPlacements: [],
			createdAt: ago(90), updatedAt: now
		},
		{
			_id: locIds[1], barcode: 'LOC-FR-A2', locationType: 'fridge', displayName: 'Fridge A - Shelf 2',
			isActive: true, capacity: 48, currentPlacements: [],
			createdAt: ago(90), updatedAt: now
		},
		{
			_id: locIds[2], barcode: 'LOC-OV-1A', locationType: 'oven', displayName: 'Oven 1 - Rack A',
			isActive: true, capacity: 96, currentPlacements: [],
			createdAt: ago(90), updatedAt: now
		},
		{
			_id: locIds[3], barcode: 'LOC-OV-1B', locationType: 'oven', displayName: 'Oven 1 - Rack B',
			isActive: true, capacity: 96, currentPlacements: [],
			createdAt: ago(90), updatedAt: now
		}
	], 'barcode');

	// ─── 5. Consumables (Decks & Cooling Trays) ────────────────────
	console.log('Seeding consumables (decks, trays)...');
	const deckIds = [id(), id()];
	const trayIds = [id(), id()];
	await upsertMany(db, 'consumables', [
		{
			_id: deckIds[0], type: 'deck', status: 'available',
			currentRobotId: null, lockoutUntil: null, lastUsed: hoursAgo(4),
			createdAt: ago(60), updatedAt: now
		},
		{
			_id: deckIds[1], type: 'deck', status: 'in_use',
			currentRobotId: 'robot-placeholder', lockoutUntil: null, lastUsed: now,
			createdAt: ago(60), updatedAt: now
		},
		{
			_id: trayIds[0], type: 'cooling_tray', status: 'available',
			assignedRunId: null, currentCartridges: [],
			createdAt: ago(60), updatedAt: now
		},
		{
			_id: trayIds[1], type: 'cooling_tray', status: 'in_use',
			assignedRunId: 'run-placeholder', currentCartridges: [],
			createdAt: ago(60), updatedAt: now
		}
	], '_id');

	// ─── 6. Wax Filling Runs ────────────────────────────────────────
	console.log('Seeding wax filling runs...');
	const waxRunIds = [id(), id(), id()];
	await upsertMany(db, 'waxfillingruns', [
		{
			_id: waxRunIds[0],
			robot: { _id: 'robot-1', name: 'OT-2 Left' },
			deckId: deckIds[0], coolingTrayId: trayIds[0],
			waxSourceLot: 'WAX-LOT-001', waxTubeId: 'TUBE-001',
			status: 'completed', operator: operatorRef,
			plannedCartridgeCount: 48, cartridgeIds: [],
			runStartTime: ago(2), runEndTime: ago(2),
			createdAt: ago(2), updatedAt: ago(2)
		},
		{
			_id: waxRunIds[1],
			robot: { _id: 'robot-1', name: 'OT-2 Left' },
			deckId: deckIds[1], coolingTrayId: trayIds[1],
			waxSourceLot: 'WAX-LOT-002', waxTubeId: 'TUBE-002',
			status: 'running', operator: operatorRef,
			plannedCartridgeCount: 48, cartridgeIds: [],
			runStartTime: hoursAgo(1), runEndTime: null,
			createdAt: hoursAgo(1), updatedAt: now
		},
		{
			_id: waxRunIds[2],
			robot: { _id: 'robot-2', name: 'OT-2 Right' },
			deckId: deckIds[0], coolingTrayId: trayIds[0],
			waxSourceLot: 'WAX-LOT-001', waxTubeId: 'TUBE-003',
			status: 'aborted', operator: adminRef, abortReason: 'Tube clog detected',
			plannedCartridgeCount: 48, cartridgeIds: [],
			runStartTime: ago(3), runEndTime: ago(3),
			createdAt: ago(3), updatedAt: ago(3)
		}
	], '_id');

	// ─── 7. Reagent Batch Records ───────────────────────────────────
	console.log('Seeding reagent batch records...');
	const reagentRunIds = [id(), id()];
	await upsertMany(db, 'reagentbatchrecords', [
		{
			_id: reagentRunIds[0], runNumber: 'RGT-RUN-001',
			robot: { _id: 'robot-1', name: 'OT-2 Left', side: 'left' },
			assayType: { _id: crpAssay!._id, name: 'CRP Assay', skuCode: 'SKU-CRP-100' },
			operator: operatorRef, deckId: deckIds[0],
			status: 'completed', cartridgeCount: 48,
			runStartTime: ago(1), runEndTime: ago(1),
			tubeRecords: [
				{ wellPosition: 1, reagentName: 'CRP Antibody', sourceLotId: 'RGT-LOT-001', transferTubeId: 'TT-001' },
				{ wellPosition: 2, reagentName: 'Conjugate Buffer', sourceLotId: 'RGT-LOT-002', transferTubeId: 'TT-002' }
			],
			cartridgesFilled: [], corrections: [],
			createdAt: ago(1), updatedAt: ago(1)
		},
		{
			_id: reagentRunIds[1], runNumber: 'RGT-RUN-002',
			robot: { _id: 'robot-2', name: 'OT-2 Right', side: 'right' },
			assayType: { _id: pctAssay!._id, name: 'Procalcitonin Assay', skuCode: 'SKU-PCT-100' },
			operator: operatorRef, deckId: deckIds[1],
			status: 'setup', cartridgeCount: 0,
			runStartTime: null, runEndTime: null,
			tubeRecords: [], cartridgesFilled: [], corrections: [],
			createdAt: hoursAgo(0.5), updatedAt: now
		}
	], 'runNumber');

	// ─── 8. Cartridge Records ───────────────────────────────────────
	console.log('Seeding cartridge records...');
	const cartridgeData = [];
	const phases = ['backing', 'wax_filled', 'wax_qc', 'wax_stored', 'reagent_filled', 'inspected', 'sealed', 'cured', 'stored', 'released'];
	for (let i = 0; i < 20; i++) {
		const phase = phases[i % phases.length];
		const cid = id();
		cartridgeData.push({
			_id: cid,
			currentPhase: phase,
			backing: {
				lotId: `BK-LOT-${String(Math.floor(i / 4) + 1).padStart(3, '0')}`,
				lotQrCode: `QR-BK-${String(i + 1).padStart(3, '0')}`,
				ovenEntryTime: ago(5 - Math.floor(i / 4)),
				recordedAt: ago(5 - Math.floor(i / 4))
			},
			waxFilling: phase !== 'backing' ? {
				runId: waxRunIds[0], robotId: 'robot-1', robotName: 'OT-2 Left',
				deckId: deckIds[0], deckPosition: (i % 48) + 1,
				waxTubeId: 'TUBE-001', waxSourceLot: 'WAX-LOT-001',
				operator: operatorRef, runStartTime: ago(4), runEndTime: ago(4),
				recordedAt: ago(4)
			} : undefined,
			waxQc: ['wax_qc', 'wax_stored', 'reagent_filled', 'inspected', 'sealed', 'cured', 'stored', 'released'].includes(phase) ? {
				status: 'Accepted', operator: operatorRef, timestamp: ago(3), recordedAt: ago(3)
			} : undefined,
			waxStorage: ['wax_stored', 'reagent_filled', 'inspected', 'sealed', 'cured', 'stored', 'released'].includes(phase) ? {
				location: 'Fridge A - Shelf 1', coolingTrayId: trayIds[0],
				operator: operatorRef, timestamp: ago(3), recordedAt: ago(3)
			} : undefined,
			reagentFilling: ['reagent_filled', 'inspected', 'sealed', 'cured', 'stored', 'released'].includes(phase) ? {
				runId: reagentRunIds[0], robotId: 'robot-1', robotName: 'OT-2 Left',
				assayType: { _id: crpAssay!._id, name: 'CRP Assay', skuCode: 'SKU-CRP-100' },
				deckPosition: (i % 48) + 1,
				operator: operatorRef, fillDate: ago(2), expirationDate: ago(-180),
				recordedAt: ago(2)
			} : undefined,
			reagentInspection: ['inspected', 'sealed', 'cured', 'stored', 'released'].includes(phase) ? {
				status: i % 7 === 0 ? 'Rejected' : 'Accepted',
				reason: i % 7 === 0 ? 'Visible contamination' : undefined,
				operator: operatorRef, timestamp: ago(2), recordedAt: ago(2)
			} : undefined,
			topSeal: ['sealed', 'cured', 'stored', 'released'].includes(phase) ? {
				batchId: 'TS-BATCH-001', topSealLotId: 'TS-LOT-001',
				operator: operatorRef, timestamp: ago(1), recordedAt: ago(1)
			} : undefined,
			corrections: [],
			createdAt: ago(5), updatedAt: ago(Math.max(0, 5 - i * 0.25))
		});
	}
	await upsertMany(db, 'cartridgerecords', cartridgeData, '_id');

	// ─── 9. Part Definitions ────────────────────────────────────────
	console.log('Seeding part definitions...');
	const partIds = [id(), id(), id(), id(), id()];
	await upsertMany(db, 'partdefinitions', [
		{
			_id: partIds[0], partNumber: 'PRT-PCB-001', name: 'Main PCB Board',
			description: 'Primary circuit board for SPU', category: 'Electronics',
			supplier: 'CircuitCo', manufacturer: 'FlexPCB Inc',
			unitCost: '45.00', unitOfMeasure: 'ea', leadTimeDays: 14,
			minimumOrderQty: 50, isActive: true, sortOrder: 1,
			createdBy: admin._id, createdAt: ago(60), updatedAt: ago(5)
		},
		{
			_id: partIds[1], partNumber: 'PRT-HSG-001', name: 'SPU Housing',
			description: 'Injection molded outer housing', category: 'Mechanical',
			supplier: 'MoldMasters', manufacturer: 'PlastiForm',
			unitCost: '12.50', unitOfMeasure: 'ea', leadTimeDays: 21,
			minimumOrderQty: 100, isActive: true, sortOrder: 2,
			createdBy: admin._id, createdAt: ago(60), updatedAt: ago(10)
		},
		{
			_id: partIds[2], partNumber: 'PRT-OPT-001', name: 'Optical Module',
			description: 'Spectrophotometer optical assembly', category: 'Optics',
			supplier: 'OpticalSys', manufacturer: 'PhotonTech',
			unitCost: '78.00', unitOfMeasure: 'ea', leadTimeDays: 28,
			minimumOrderQty: 25, isActive: true, sortOrder: 3,
			createdBy: admin._id, createdAt: ago(60), updatedAt: ago(15)
		},
		{
			_id: partIds[3], partNumber: 'PRT-BAT-001', name: 'Battery Pack',
			description: 'Rechargeable Li-ion battery', category: 'Electronics',
			supplier: 'PowerCell', manufacturer: 'BattTech',
			unitCost: '8.75', unitOfMeasure: 'ea', leadTimeDays: 7,
			minimumOrderQty: 200, isActive: true, sortOrder: 4,
			createdBy: admin._id, createdAt: ago(60), updatedAt: ago(2)
		},
		{
			_id: partIds[4], partNumber: 'PRT-LBL-001', name: 'Device Label',
			description: 'UDI barcode label', category: 'Consumables',
			supplier: 'LabelPro', manufacturer: 'LabelPro',
			unitCost: '0.15', unitOfMeasure: 'ea', leadTimeDays: 3,
			minimumOrderQty: 1000, isActive: true, sortOrder: 5,
			createdBy: admin._id, createdAt: ago(60), updatedAt: ago(1)
		}
	], 'partNumber');

	// Re-fetch part IDs
	const partCol = db.collection('partdefinitions');
	const actualParts = await partCol.find({}).toArray();

	// ─── 10. BOM Items (SPU + Cartridge) ────────────────────────────
	console.log('Seeding BOM items...');
	await upsertMany(db, 'bomitems', [
		{
			_id: id(), bomType: 'spu', partNumber: 'PRT-PCB-001', name: 'Main PCB Board',
			category: 'Electronics', quantityPerUnit: 1, unitOfMeasure: 'ea',
			supplier: 'CircuitCo', manufacturer: 'FlexPCB Inc',
			unitCost: '45.00', inventoryCount: 150, minimumStockLevel: 50,
			isActive: true, createdBy: admin._id as string,
			createdAt: ago(60), updatedAt: ago(5)
		},
		{
			_id: id(), bomType: 'spu', partNumber: 'PRT-HSG-001', name: 'SPU Housing',
			category: 'Mechanical', quantityPerUnit: 1, unitOfMeasure: 'ea',
			supplier: 'MoldMasters', manufacturer: 'PlastiForm',
			unitCost: '12.50', inventoryCount: 300, minimumStockLevel: 100,
			isActive: true, createdBy: admin._id as string,
			createdAt: ago(60), updatedAt: ago(10)
		},
		{
			_id: id(), bomType: 'cartridge', partNumber: 'CRT-WAX-001', name: 'Wax Pellet',
			category: 'Raw Materials', quantityPerUnit: 1, unitOfMeasure: 'ea',
			supplier: 'WaxWorks', manufacturer: 'WaxWorks',
			unitCost: '0.30', inventoryCount: 5000, minimumStockLevel: 1000,
			isActive: true, createdBy: admin._id as string,
			createdAt: ago(60), updatedAt: ago(3)
		},
		{
			_id: id(), bomType: 'cartridge', partNumber: 'CRT-SUB-001', name: 'Substrate Sheet',
			category: 'Raw Materials', quantityPerUnit: 1, unitOfMeasure: 'ea',
			supplier: 'SubCo', manufacturer: 'SubCo',
			unitCost: '0.50', inventoryCount: 8, minimumStockLevel: 500,  // LOW STOCK
			isActive: true, createdBy: admin._id as string,
			createdAt: ago(60), updatedAt: ago(1)
		},
		{
			_id: id(), bomType: 'cartridge', partNumber: 'CRT-SEAL-001', name: 'Top Seal Film',
			category: 'Consumables', quantityPerUnit: 1, unitOfMeasure: 'ft',
			supplier: 'SealTech', manufacturer: 'SealTech',
			unitCost: '0.08', inventoryCount: 20, minimumStockLevel: 200,  // LOW STOCK
			isActive: true, createdBy: admin._id as string,
			createdAt: ago(60), updatedAt: ago(1)
		}
	], 'partNumber');

	// ─── 11. Inventory Transactions ─────────────────────────────────
	console.log('Seeding inventory transactions...');
	const txnData = [];
	for (const part of actualParts) {
		// Receipt
		txnData.push({
			_id: id(),
			partDefinitionId: part._id as string,
			transactionType: 'receipt',
			quantity: 100,
			previousQuantity: 0,
			newQuantity: 100,
			reason: 'Initial stock receipt',
			performedBy: admin.username as string,
			performedAt: ago(30)
		});
		// Deduction
		txnData.push({
			_id: id(),
			partDefinitionId: part._id as string,
			transactionType: 'deduction',
			quantity: -5,
			previousQuantity: 100,
			newQuantity: 95,
			reason: 'Assembly batch AB-001',
			assemblySessionId: 'session-placeholder',
			performedBy: operator.username as string,
			performedAt: ago(15)
		});
		// Adjustment
		txnData.push({
			_id: id(),
			partDefinitionId: part._id as string,
			transactionType: 'adjustment',
			quantity: 3,
			previousQuantity: 95,
			newQuantity: 98,
			reason: 'Cycle count correction',
			performedBy: admin.username as string,
			performedAt: ago(5)
		});
	}
	// Add one retracted transaction
	txnData.push({
		_id: id(),
		partDefinitionId: actualParts[0]._id as string,
		transactionType: 'deduction',
		quantity: -10,
		previousQuantity: 98,
		newQuantity: 88,
		reason: 'Wrong part pulled',
		performedBy: operator.username as string,
		performedAt: ago(3),
		retractedBy: admin.username as string,
		retractedAt: ago(2),
		retractionReason: 'Incorrect part number scanned'
	});
	await upsertMany(db, 'inventorytransactions', txnData, '_id');

	// ─── 12. Validation Sessions ────────────────────────────────────
	console.log('Seeding validation sessions...');
	const validationData = [];
	const valTypes = ['spectrophotometer', 'thermocouple', 'magnetometer'];
	const valStatuses = ['completed', 'completed', 'failed', 'completed', 'in_progress'];
	for (let i = 0; i < 15; i++) {
		const type = valTypes[i % 3];
		const status = valStatuses[i % 5];
		validationData.push({
			_id: id(),
			type,
			status,
			spuId: `spu-placeholder-${i}`,
			userId: i % 2 === 0 ? admin._id as string : operator._id as string,
			startedAt: hoursAgo(48 - i * 3),
			completedAt: status === 'completed' || status === 'failed' ? hoursAgo(47 - i * 3) : null,
			results: status === 'completed' ? [
				{ testType: `${type}_calibration`, passed: true, notes: 'Within tolerance', createdAt: hoursAgo(47 - i * 3) }
			] : status === 'failed' ? [
				{ testType: `${type}_calibration`, passed: false, notes: 'Out of range', createdAt: hoursAgo(47 - i * 3) }
			] : [],
			createdAt: hoursAgo(48 - i * 3)
		});
	}
	await upsertMany(db, 'validationsessions', validationData, '_id');

	// ─── 13. Generated Barcodes ─────────────────────────────────────
	console.log('Seeding generated barcodes...');
	const barcodeData = [];
	for (let i = 0; i < 10; i++) {
		barcodeData.push({
			_id: id(),
			prefix: 'VAL',
			sequence: i + 1,
			barcode: `VAL-${String(i + 1).padStart(6, '0')}`,
			type: 'validation',
			createdAt: i < 3 ? hoursAgo(i) : ago(i)  // First 3 are "today"
		});
	}
	await upsertMany(db, 'generatedbarcodes', barcodeData, 'barcode');

	// ─── 14. Customers ──────────────────────────────────────────────
	console.log('Seeding customers...');
	await upsertMany(db, 'customers', [
		{
			_id: id(), name: 'Metro General Hospital', customerType: 'hospital',
			contactName: 'Dr. Sarah Chen', contactEmail: 'schen@metrogeneral.org',
			contactPhone: '555-0101', address: '100 Medical Center Dr, Suite 300',
			isActive: true, createdBy: admin._id, createdAt: ago(90), updatedAt: ago(10)
		},
		{
			_id: id(), name: 'Riverside Clinic', customerType: 'clinic',
			contactName: 'James Park', contactEmail: 'jpark@riversideclinic.com',
			contactPhone: '555-0202', address: '45 River Road',
			isActive: true, createdBy: admin._id, createdAt: ago(60), updatedAt: ago(5)
		},
		{
			_id: id(), name: 'BioResearch Labs', customerType: 'research',
			contactName: 'Dr. Emily Watson', contactEmail: 'ewatson@bioresearch.edu',
			contactPhone: '555-0303', address: '1 University Ave, Lab 420',
			isActive: true, createdBy: admin._id, createdAt: ago(30), updatedAt: ago(1)
		}
	], 'name');

	// ─── 15. Kanban Projects & Tasks ────────────────────────────────
	console.log('Seeding kanban projects and tasks...');
	const projectIds = [id(), id()];
	await upsertMany(db, 'kanbanprojects', [
		{
			_id: projectIds[0], name: 'Manufacturing Sprint 1', color: '#3B82F6',
			isActive: true, createdBy: admin._id, createdAt: ago(14), updatedAt: ago(1)
		},
		{
			_id: projectIds[1], name: 'QA Improvements', color: '#10B981',
			isActive: true, createdBy: admin._id, createdAt: ago(7), updatedAt: now
		}
	], 'name');

	const actualProjects = await db.collection('kanbanprojects').find({}).toArray();

	await upsertMany(db, 'kanbantasks', [
		{
			_id: id(), title: 'Calibrate spectrophotometer', description: 'Monthly calibration due',
			status: 'todo', priority: 'high', projectId: actualProjects[0]?._id,
			assignedTo: operator._id, createdBy: admin._id,
			archived: false, createdAt: ago(3), updatedAt: ago(1)
		},
		{
			_id: id(), title: 'Order new wax tubes', description: 'Running low on WAX-LOT-002',
			status: 'in_progress', priority: 'medium', projectId: actualProjects[0]?._id,
			assignedTo: admin._id, createdBy: admin._id,
			archived: false, createdAt: ago(5), updatedAt: hoursAgo(2)
		},
		{
			_id: id(), title: 'Review QC rejection trends', description: 'Monthly analysis',
			status: 'done', priority: 'low', projectId: actualProjects[1]?._id,
			assignedTo: admin._id, createdBy: admin._id,
			archived: false, createdAt: ago(10), updatedAt: ago(2)
		},
		{
			_id: id(), title: 'Update reagent filling SOP', description: 'Incorporate new buffer protocol',
			status: 'todo', priority: 'medium', projectId: actualProjects[1]?._id,
			assignedTo: operator._id, createdBy: admin._id,
			archived: false, createdAt: ago(2), updatedAt: ago(1)
		}
	], 'title');

	// ─── 16. SPUs ───────────────────────────────────────────────────
	console.log('Seeding SPUs...');
	const spuStatuses = ['draft', 'assembling', 'assembled', 'validated', 'assigned', 'deployed'];
	for (let i = 0; i < 6; i++) {
		await upsertMany(db, 'spus', [{
			_id: id(), udi: `SPU-${String(i + 1).padStart(4, '0')}`,
			status: spuStatuses[i],
			assemblyStatus: i >= 2 ? 'completed' : (i === 1 ? 'in_progress' : 'created'),
			qcStatus: i >= 3 ? 'passed' : 'pending',
			parts: [],
			corrections: [],
			createdBy: admin._id, owner: i >= 4 ? 'Metro General Hospital' : undefined,
			createdAt: ago(30 - i * 5), updatedAt: ago(Math.max(0, 10 - i * 2))
		}], 'udi');
	}

	// ─── 17. Cartridge Groups & Lab Cartridges ─────────────────────
	console.log('Seeding cartridge groups...');
	const groupIds = [id(), id(), id()];
	await upsertMany(db, 'cartridge_groups', [
		{
			_id: groupIds[0], name: 'Measurement', description: 'Standard measurement cartridges',
			color: '#3B82F6', createdBy: admin._id as string,
			createdAt: ago(60), updatedAt: ago(5)
		},
		{
			_id: groupIds[1], name: 'Calibration', description: 'Calibration reference cartridges',
			color: '#10B981', createdBy: admin._id as string,
			createdAt: ago(60), updatedAt: ago(10)
		},
		{
			_id: groupIds[2], name: 'Reference', description: 'Quality reference cartridges',
			color: '#F59E0B', createdBy: admin._id as string,
			createdAt: ago(60), updatedAt: ago(15)
		}
	], 'name');

	// Re-fetch groups
	const actualGroups = await db.collection('cartridge_groups').find({}).toArray();
	const grpMeasurement = actualGroups.find(g => g.name === 'Measurement');
	const grpCalibration = actualGroups.find(g => g.name === 'Calibration');
	const grpReference = actualGroups.find(g => g.name === 'Reference');

	console.log('Seeding lab cartridges...');
	const cartridgeTypes = ['measurement', 'calibration', 'reference', 'test'] as const;
	const cartridgeStatuses = ['available', 'in_use', 'depleted', 'expired', 'quarantine', 'available', 'in_use', 'available', 'available', 'disposed'] as const;
	const cartridgeGroupAssign = [grpMeasurement, grpCalibration, grpReference, grpMeasurement, grpCalibration, grpMeasurement, grpReference, grpCalibration, grpMeasurement, grpReference];

	const labCartridgeData = [];
	for (let i = 0; i < 10; i++) {
		const cid = id();
		const status = cartridgeStatuses[i];
		const cType = cartridgeTypes[i % 4];
		const group = cartridgeGroupAssign[i];
		labCartridgeData.push({
			_id: cid,
			barcode: `LC-${String(i + 1).padStart(4, '0')}`,
			serialNumber: `SN-LC-${String(i + 1).padStart(6, '0')}`,
			lotNumber: `LOT-LC-${String(Math.floor(i / 3) + 1).padStart(3, '0')}`,
			cartridgeType: cType,
			status,
			groupId: group?._id as string,
			manufacturer: i % 2 === 0 ? 'BioScale Inc' : 'CartridgeCo',
			expirationDate: ago(-90 + i * 10),
			receivedDate: ago(30 - i),
			openedDate: ['in_use', 'depleted', 'disposed'].includes(status) ? ago(15 - i) : null,
			usesRemaining: status === 'depleted' ? 0 : status === 'disposed' ? 0 : 10 - i,
			totalUses: 10,
			storageLocation: i % 2 === 0 ? 'Fridge A - Shelf 1' : 'Fridge A - Shelf 2',
			storageConditions: '2-8°C',
			notes: i === 4 ? 'Quarantined due to temperature excursion' : null,
			isActive: status !== 'disposed',
			usageLog: [
				{
					_id: id(), action: 'registered', previousValue: null, newValue: 'available',
					performedBy: adminRef, performedAt: ago(30 - i)
				},
				...(status !== 'available' ? [{
					_id: id(), action: 'status_changed' as const, previousValue: 'available', newValue: status,
					performedBy: operatorRef, performedAt: ago(15 - i)
				}] : [])
			],
			createdAt: ago(30 - i), updatedAt: ago(Math.max(0, 15 - i))
		});
	}
	await upsertMany(db, 'lab_cartridges', labCartridgeData, 'barcode');

	// ─── 18. Firmware Devices, Cartridges & Events ─────────────────
	console.log('Seeding firmware devices...');
	const fwDeviceIds = [id(), id(), id()];
	await upsertMany(db, 'firmware_devices', [
		{
			_id: fwDeviceIds[0], deviceId: 'FW-DEV-001', apiKey: 'key-abc-123',
			firmwareVersion: '2.1.0', dataFormatVersion: '3.0',
			lastSeen: hoursAgo(0.5), metadata: { location: 'Lab Room 101' },
			createdAt: ago(90), updatedAt: hoursAgo(0.5)
		},
		{
			_id: fwDeviceIds[1], deviceId: 'FW-DEV-002', apiKey: 'key-def-456',
			firmwareVersion: '2.0.3', dataFormatVersion: '3.0',
			lastSeen: ago(2), metadata: { location: 'Lab Room 102' },
			createdAt: ago(60), updatedAt: ago(2)
		},
		{
			_id: fwDeviceIds[2], deviceId: 'FW-DEV-003', apiKey: 'key-ghi-789',
			firmwareVersion: '1.9.5', dataFormatVersion: '2.5',
			lastSeen: ago(14), metadata: { location: 'Field Site A' },
			createdAt: ago(120), updatedAt: ago(14)
		}
	], 'deviceId');

	console.log('Seeding firmware cartridges...');
	const fwCartStatuses = ['active', 'used', 'expired', 'active', 'pending', 'active', 'used', 'expired'] as const;
	const fwCartData = [];
	for (let i = 0; i < 8; i++) {
		fwCartData.push({
			_id: id(),
			cartridgeUuid: `FWC-${String(i + 1).padStart(4, '0')}-${id().substring(0, 8)}`,
			assayId: i % 2 === 0 ? (crpAssay?._id as string) : (pctAssay?._id as string),
			status: fwCartStatuses[i],
			lotNumber: `FW-LOT-${String(Math.floor(i / 3) + 1).padStart(3, '0')}`,
			expirationDate: ago(-60 + i * 15),
			serialNumber: `FW-SN-${String(i + 1).padStart(6, '0')}`,
			siteId: i < 4 ? 'SITE-LAB' : 'SITE-FIELD-A',
			program: i % 3 === 0 ? 'CRP-Program' : 'PCT-Program',
			experiment: `EXP-${String(Math.floor(i / 2) + 1).padStart(3, '0')}`,
			arm: i % 2 === 0 ? 'A' : 'B',
			quantity: 1,
			testResultId: i < 3 ? `tr-placeholder-${i}` : null,
			createdAt: ago(30 - i * 3), updatedAt: ago(15 - i * 2)
		});
	}
	await upsertMany(db, 'firmware_cartridges', fwCartData, 'cartridgeUuid');

	console.log('Seeding device events...');
	const eventTypes = ['validate', 'load_assay', 'upload', 'reset', 'error'] as const;
	const deviceEventData = [];
	for (let i = 0; i < 15; i++) {
		const evType = eventTypes[i % 5];
		const isError = evType === 'error';
		deviceEventData.push({
			_id: id(),
			deviceId: i < 6 ? 'FW-DEV-001' : i < 11 ? 'FW-DEV-002' : 'FW-DEV-003',
			eventType: evType,
			cartridgeUuid: evType !== 'reset' ? `FWC-${String((i % 8) + 1).padStart(4, '0')}-event` : null,
			success: !isError,
			errorMessage: isError ? `Device error: sensor ${i} timeout` : null,
			createdAt: hoursAgo(72 - i * 4)
		});
	}
	await upsertMany(db, 'device_events', deviceEventData, '_id');

	// ─── 19. Test Results ──────────────────────────────────────────
	console.log('Seeding test results...');
	const testStatuses = ['uploaded', 'processing', 'completed', 'completed', 'failed'] as const;
	const testResultData = [];
	for (let i = 0; i < 5; i++) {
		const trStatus = testStatuses[i];
		testResultData.push({
			_id: id(),
			dataFormatCode: `DF-${i + 1}`,
			cartridgeUuid: `FWC-${String(i + 1).padStart(4, '0')}-test`,
			assayId: i % 2 === 0 ? 'ASSAY-CRP' : 'ASSAY-PCT',
			deviceId: i < 3 ? 'FW-DEV-001' : 'FW-DEV-002',
			startTime: Date.now() - (72 - i * 12) * 3600000,
			duration: 900 + i * 120,
			numberOfReadings: 50 + i * 10,
			baselineScans: 5,
			testScans: 45 + i * 10,
			status: trStatus,
			readings: Array.from({ length: 5 }, (_, j) => ({
				readingNumber: j + 1,
				channel: (['A', 'B', 'C'] as const)[j % 3],
				position: j + 1,
				temperature: 37.0 + Math.random() * 0.5,
				laserOutput: 100 + Math.random() * 5,
				timestampMs: j * 1000,
				f1: Math.random() * 100, f2: Math.random() * 100,
				f3: Math.random() * 100, f4: Math.random() * 100,
				f5: Math.random() * 100, f6: Math.random() * 100,
				f7: Math.random() * 100, f8: Math.random() * 100,
				clearChannel: Math.random() * 50,
				nirChannel: Math.random() * 50
			})),
			processedAt: trStatus === 'completed' ? hoursAgo(48 - i * 10) : (trStatus === 'failed' ? hoursAgo(50 - i * 10) : null),
			createdAt: hoursAgo(72 - i * 12), updatedAt: hoursAgo(48 - i * 10)
		});
	}
	await upsertMany(db, 'test_results', testResultData, '_id');

	// ─── 20. Shipping Lots & Packages (expanded) ───────────────────
	console.log('Seeding shipping data...');

	// Re-fetch customers
	const actualCustomers = await db.collection('customers').find({}).toArray();
	const metroHospital = actualCustomers.find(c => c.name === 'Metro General Hospital');
	const riversideClinic = actualCustomers.find(c => c.name === 'Riverside Clinic');

	const shippingLotIds = [id(), id(), id()];
	await upsertMany(db, 'shipping_lots', [
		{
			_id: shippingLotIds[0],
			assayType: { _id: crpAssay!._id as string, name: 'CRP Assay' },
			customer: { _id: metroHospital!._id as string, name: 'Metro General Hospital' },
			status: 'open', cartridgeCount: 24, notes: 'Initial CRP lot for Metro General',
			qaqcReleases: [],
			createdAt: ago(5), updatedAt: ago(2)
		},
		{
			_id: shippingLotIds[1],
			assayType: { _id: pctAssay!._id as string, name: 'Procalcitonin Assay' },
			customer: { _id: riversideClinic!._id as string, name: 'Riverside Clinic' },
			status: 'released', cartridgeCount: 48,
			releasedAt: ago(1), releasedBy: admin.username as string,
			notes: 'PCT lot for Riverside',
			qaqcReleases: [{
				_id: id(), reagentRunId: reagentRunIds[0],
				qaqcCartridgeIds: ['qc-cart-1', 'qc-cart-2'],
				testResult: 'pass',
				testedBy: operatorRef, testedAt: ago(2),
				notes: 'All QC cartridges passed', createdAt: ago(2)
			}],
			createdAt: ago(7), updatedAt: ago(1)
		},
		{
			_id: shippingLotIds[2],
			assayType: { _id: crpAssay!._id as string, name: 'CRP Assay' },
			customer: { _id: metroHospital!._id as string, name: 'Metro General Hospital' },
			status: 'shipped', cartridgeCount: 12,
			releasedAt: ago(10), releasedBy: admin.username as string,
			notes: 'Urgent order',
			qaqcReleases: [{
				_id: id(), reagentRunId: reagentRunIds[0],
				qaqcCartridgeIds: ['qc-cart-3'],
				testResult: 'pass',
				testedBy: adminRef, testedAt: ago(11),
				notes: 'QC pass', createdAt: ago(11)
			}],
			createdAt: ago(14), updatedAt: ago(3)
		}
	], '_id');

	const shippingPkgIds = [id(), id(), id()];
	await upsertMany(db, 'shipping_packages', [
		{
			_id: shippingPkgIds[0], barcode: 'PKG-001',
			customer: {
				_id: metroHospital!._id as string, name: 'Metro General Hospital',
				customerType: 'hospital', contactName: 'Dr. Sarah Chen',
				contactEmail: 'schen@metrogeneral.org', contactPhone: '555-0101',
				address: '100 Medical Center Dr, Suite 300'
			},
			trackingNumber: '1Z999AA10123456784', carrier: 'UPS',
			status: 'shipped', notes: 'Handle with care',
			packedBy: operator.username as string, packedAt: ago(3),
			shippedAt: ago(2), deliveredAt: null,
			cartridges: [
				{ cartridgeId: 'cart-ship-1', addedAt: ago(4) },
				{ cartridgeId: 'cart-ship-2', addedAt: ago(4) }
			],
			createdAt: ago(5), updatedAt: ago(2)
		},
		{
			_id: shippingPkgIds[1], barcode: 'PKG-002',
			customer: {
				_id: riversideClinic!._id as string, name: 'Riverside Clinic',
				customerType: 'clinic', contactName: 'James Park',
				contactEmail: 'jpark@riversideclinic.com', contactPhone: '555-0202',
				address: '45 River Road'
			},
			trackingNumber: null, carrier: 'FedEx',
			status: 'packed', notes: null,
			packedBy: admin.username as string, packedAt: ago(1),
			shippedAt: null, deliveredAt: null,
			cartridges: [
				{ cartridgeId: 'cart-ship-3', addedAt: ago(2) }
			],
			createdAt: ago(3), updatedAt: ago(1)
		},
		{
			_id: shippingPkgIds[2], barcode: 'PKG-003',
			customer: {
				_id: metroHospital!._id as string, name: 'Metro General Hospital',
				customerType: 'hospital', contactName: 'Dr. Sarah Chen',
				contactEmail: 'schen@metrogeneral.org', contactPhone: '555-0101',
				address: '100 Medical Center Dr, Suite 300'
			},
			trackingNumber: null, carrier: null,
			status: 'created', notes: 'Awaiting cartridges',
			packedBy: null, packedAt: null,
			shippedAt: null, deliveredAt: null,
			cartridges: [],
			createdAt: ago(1), updatedAt: ago(1)
		}
	], 'barcode');

	// ─── 21. Integration (Box.com mock) ─────────────────────────────
	console.log('Seeding integration records...');
	await upsertMany(db, 'integrations', [{
		_id: id(), type: 'box',
		accessToken: 'mock-box-token-for-testing',
		refreshToken: 'mock-refresh-token',
		isActive: true,
		lastSyncAt: hoursAgo(2),
		lastSyncStatus: 'success',
		lastSyncError: null,
		syncIntervalMinutes: 60,
		createdAt: ago(30), updatedAt: hoursAgo(2)
	}], 'type');

	// ─── Done ───────────────────────────────────────────────────────
	console.log('\n✅ Domain data seed complete!');
	console.log('  Process configs: 3');
	console.log('  Lot records: 5');
	console.log('  Assay definitions: 3 (1 inactive)');
	console.log('  Equipment: 2 (fridge + oven)');
	console.log('  Equipment locations: 4');
	console.log('  Consumables: 4 (2 decks, 2 trays)');
	console.log('  Wax filling runs: 3 (1 active, 1 aborted, 1 complete)');
	console.log('  Reagent batch records: 2');
	console.log('  Cartridge records: 20 (across 10 phases)');
	console.log('  Part definitions: 5');
	console.log('  BOM items: 5 (2 SPU, 3 cartridge — 2 low stock)');
	console.log('  Inventory transactions: 16');
	console.log('  Validation sessions: 15 (5 per instrument type)');
	console.log('  Generated barcodes: 10 (3 today)');
	console.log('  Customers: 3');
	console.log('  Kanban projects: 2, tasks: 4');
	console.log('  SPUs: 6 (various statuses)');
	console.log('  Cartridge groups: 3');
	console.log('  Lab cartridges: 10 (mixed statuses/types)');
	console.log('  Firmware devices: 3');
	console.log('  Firmware cartridges: 8');
	console.log('  Device events: 15');
	console.log('  Test results: 5 (mixed statuses)');
	console.log('  Shipping lots: 3 (open, released, shipped)');
	console.log('  Shipping packages: 3 (created, packed, shipped)');
	console.log('  Integrations: 1 (Box.com mock)');

	await mongoose.disconnect();
}

seed().catch((err) => {
	console.error('Domain seed failed:', err);
	process.exit(1);
});
