/**
 * OT-2 simulator fixtures (ROBOT-OVERHAUL test rig, 2026-10-08) — REMOVE
 * BEFORE FINAL SHIP.
 *
 * Writes everything the Robots page needs to run wax and reagent fills on
 * robots that do not exist, so the page can be exercised end to end while the
 * real OT-2s stay idle. Every document is prefixed `sim-` / `SIM-` so
 * `--teardown` removes all of it (and only it).
 *
 *   MONGODB_URI=… npx tsx scripts/ot2-sim/seed.ts [--robots 3] [--carts 72]
 *   MONGODB_URI=… npx tsx scripts/ot2-sim/seed.ts --reset-carts   # back to backing / wax_filled
 *   MONGODB_URI=… npx tsx scripts/ot2-sim/seed.ts --teardown      # delete every sim document
 *
 * Per robot N (1..--robots): "SIM Robot S0N" — the S0N slot code is what
 * BIMS derives the bridge device id (ot2-s0n-bridge) from — as an Equipment
 * robot AND an opentrons_robots record (same _id, like the real ones), with a
 * wax-filling and a reagent-filling protocol entry (the RTP schemas the Start
 * panel renders), plus a default scanner position set with a deck-barcode
 * position (what the deck scan + sweep require). Shared: one deck, one wax
 * lot, one reagent set lot + open fill lot, stored .py records for the
 * freshness gate (only when none are active), and `--carts` cartridges in
 * `backing` (SIM-W-…) and `wax_filled` (SIM-R-…).
 *
 * The robots' ip/port point at the simulator daemon (127.0.0.1:3195N) for the
 * direct line; on Vercel the queue line reaches the same daemon.
 */
import mongoose from 'mongoose';

const argv = process.argv.slice(2);
const flag = (name: string, dflt: string): string => {
	const i = argv.indexOf(`--${name}`);
	return i >= 0 && argv[i + 1] ? argv[i + 1] : dflt;
};
const ROBOTS = Math.max(1, Math.min(9, Number(flag('robots', '3')) || 3));
const CARTS = Math.max(24, Math.min(500, Number(flag('carts', '72')) || 72));
const TEARDOWN = argv.includes('--teardown');
const RESET_CARTS = argv.includes('--reset-carts');
const BASE_PORT = Number(process.env.SIM_BASE_PORT ?? 31950);

const uri = process.env.MONGODB_URI;
if (!uri) {
	console.error('MONGODB_URI not set');
	process.exit(1);
}

// Mirrors scripts/ot2-sim/daemon.ts WAX_SCHEMA / REAGENT_SCHEMA — keep in sync.
const WAX_SCHEMA = [
	{ variableName: 'cartridges', displayName: 'Cartridges', description: 'How many deck positions to fill (1-24)', type: 'int', default: 24, min: 1, max: 24 },
	{ variableName: 'vol_gate1', displayName: 'Gate 1 volume (uL)', type: 'float', default: 1.6, min: 0.5, max: 5 },
	{ variableName: 'vol_gate2', displayName: 'Gate 2 volume (uL)', type: 'float', default: 1.6, min: 0.5, max: 5 },
	{ variableName: 'vol_gate3', displayName: 'Gate 3 volume (uL)', type: 'float', default: 1.6, min: 0.5, max: 5 },
	{ variableName: 'vol_gate4', displayName: 'Gate 4 volume (uL)', type: 'float', default: 1.6, min: 0.5, max: 5 },
	{ variableName: 'row_pattern_0', displayName: 'Row pattern 0', type: 'bool', default: true },
	{ variableName: 'row_pattern_1', displayName: 'Row pattern 1', type: 'bool', default: true },
	{ variableName: 'row_pattern_2', displayName: 'Row pattern 2', type: 'bool', default: true },
	{ variableName: 'use_tip_calibration', displayName: 'Use tip calibration', type: 'bool', default: false },
	{ variableName: 'max_tip_adjust', displayName: 'Max tip adjust (mm)', type: 'float', default: 4.0, min: 0, max: 10 },
	{ variableName: 'run_calibration_check', displayName: 'Run calibration check', type: 'bool', default: false },
	{ variableName: 'tiprack_refilled', displayName: 'Tip rack refilled', type: 'bool', default: false }
];
const REAGENT_SCHEMA = [
	{ variableName: 'cartridges', displayName: 'Cartridges', description: 'How many deck positions to fill (1-24)', type: 'int', default: 24, min: 1, max: 24 },
	{ variableName: 'well_2', displayName: 'Fill well 2 (beads)', type: 'bool', default: true },
	{ variableName: 'well_3', displayName: 'Fill well 3 (tracer)', type: 'bool', default: true },
	{ variableName: 'well_4', displayName: 'Fill well 4 (wash)', type: 'bool', default: true },
	{ variableName: 'well_5', displayName: 'Fill well 5 (elution)', type: 'bool', default: true },
	{ variableName: 'use_tip_calibration', displayName: 'Use tip calibration', type: 'bool', default: false },
	{ variableName: 'tiprack_refilled', displayName: 'Tip rack refilled', type: 'bool', default: false }
];

const SIM_PY = (process: string) =>
	`# ${process} — SIMULATOR PLACEHOLDER (scripts/ot2-sim). Never runs on a robot.\nmetadata = {"protocolName": "${process} SIM", "apiLevel": "2.19"}\n\ndef run(ctx):\n    ctx.comment("sim")\n`;

await mongoose.connect(uri);
const db = mongoose.connection;
// String _ids everywhere (nanoids / barcodes), so untype the driver's ObjectId default.
const col = (name: string) => db.collection<any>(name);
const now = new Date();
const op = { _id: 'sim-seed', username: 'ot2-sim' };

const robotIds = Array.from({ length: 9 }, (_, i) => `sim-robot-s0${i + 1}`);
const simRobotFilter = { _id: { $in: robotIds } };
const simRunFilter = { 'robot._id': { $in: robotIds } };
const deviceIds = robotIds.map((id) => `ot2-${id.slice(-3)}-bridge`);

async function teardown() {
	const r = async (name: string, filter: any) => {
		const res = await col(name).deleteMany(filter);
		console.log(`  ${name}: ${res.deletedCount} removed`);
	};
	console.log('Tearing down simulator documents…');
	await r('wax_filling_runs', simRunFilter);
	await r('reagent_batch_records', simRunFilter);
	await r('ot2_bridge_commands', { deviceId: { $in: deviceIds } });
	await r('scanner_events', { deviceId: { $in: deviceIds } });
	await r('opentrons_scanner_sweep_runs', { robotId: { $in: robotIds } });
	await r('opentrons_scanner_position_sets', { robotId: { $in: robotIds } });
	await r('ot2_direct_calls', { robotId: { $in: robotIds } });
	await r('cartridge_records', { _id: { $regex: '^SIM-[WR]-' } });
	await r('equipment', { _id: { $regex: '^sim-' } });
	await r('opentrons_robots', simRobotFilter);
	await r('wax_batches', { _id: { $regex: '^sim-' } });
	await r('fill_lots', { _id: { $regex: '^sim-' } });
	await r('reagent_set_lots', { _id: { $regex: '^sim-' } });
	await r('opentrons_protocols', { _id: { $regex: '^sim-' } });
	console.log('Done. (AuditLog rows written during sim runs are kept — they name sim-robot-* ids.)');
}

async function resetCarts() {
	const w = await col('cartridge_records').updateMany(
		{ _id: { $regex: '^SIM-W-' } },
		{ $set: { status: 'backing', statusUpdatedOn: now.toISOString() }, $unset: { waxFilling: '', waxStorage: '', reagentFilling: '', priorStatus: '' } }
	);
	const r = await col('cartridge_records').updateMany(
		{ _id: { $regex: '^SIM-R-' } },
		{ $set: { status: 'wax_filled', statusUpdatedOn: now.toISOString() }, $unset: { reagentFilling: '', priorStatus: '' } }
	);
	console.log(`Reset ${w.modifiedCount} wax carts → backing, ${r.modifiedCount} reagent carts → wax_filled.`);
}

async function seed() {
	console.log(`Seeding ${ROBOTS} simulated robot(s), ${CARTS} cartridges per stage…`);

	// ── robots: Equipment + opentrons_robots, same _id ──
	for (let n = 1; n <= ROBOTS; n++) {
		const id = `sim-robot-s0${n}`;
		const name = `SIM Robot S0${n}`;
		const deviceId = `ot2-s0${n}-bridge`;
		const port = BASE_PORT + n;
		await col('equipment').updateOne(
			{ _id: id },
			{
				$set: { name, equipmentType: 'robot', status: 'active', isActive: true, ip: '127.0.0.1', port, robotSide: `sim ${n}`, updatedAt: now },
				$setOnInsert: { createdAt: now }
			},
			{ upsert: true }
		);
		const protocols = [
			{
				_id: `sim-proto-entry-wax-s0${n}`,
				opentronsProtocolId: `sim-proto-wax-s0${n}`,
				protocolName: 'Wax_Filling_SIM.py',
				protocolType: 'wax-filling',
				parametersSchema: WAX_SCHEMA,
				analysisStatus: 'completed',
				labwareDefinitions: null,
				pipettesRequired: [{ pipetteName: 'p20_single_gen2', mount: 'left' }],
				uploadedBy: 'ot2-sim seed',
				createdAt: now,
				updatedAt: now
			},
			{
				_id: `sim-proto-entry-reagent-s0${n}`,
				opentronsProtocolId: `sim-proto-reagent-s0${n}`,
				protocolName: 'Reagent_Filling_SIM.py',
				protocolType: 'reagent-filling',
				parametersSchema: REAGENT_SCHEMA,
				analysisStatus: 'completed',
				labwareDefinitions: null,
				pipettesRequired: [{ pipetteName: 'p20_single_gen2', mount: 'left' }],
				uploadedBy: 'ot2-sim seed',
				createdAt: now,
				updatedAt: now
			}
		];
		await col('opentrons_robots').updateOne(
			{ _id: id },
			{
				$set: {
					name,
					ip: '127.0.0.1',
					port,
					robotSide: `sim ${n}`,
					isActive: true,
					bridgeDeviceId: deviceId,
					connection: { mode: 'queue', updatedAt: now, updatedBy: 'ot2-sim seed' },
					robotModel: 'OT-2 (simulated)',
					robotSerial: `SIM-${n}`,
					source: 'sim',
					protocols,
					lastHealthOk: true,
					lastHealthAt: now,
					updatedAt: now
				},
				$setOnInsert: { createdAt: now }
			},
			{ upsert: true }
		);
		// Default position set: 24 taught slots + the deck-barcode position.
		const positions = Array.from({ length: 24 }, (_, i) => ({ slotIndex: i, x: 30 + (i % 3) * 120, y: 300 - Math.floor(i / 3) * 35, z: 60 }));
		await col('opentrons_scanner_position_sets').updateOne(
			{ _id: `sim-positions-s0${n}` },
			{
				$set: {
					robotId: id,
					title: `SIM deck positions (${name})`,
					positionCount: 24,
					positions,
					deckBarcodePosition: { x: 20, y: 20, z: 60 },
					isDefault: true,
					pipetteMount: 'left',
					pipetteName: 'p20_single_gen2',
					notes: 'simulator — not taught on a robot',
					calibratedBy: op,
					calibratedAt: now,
					updatedBy: op,
					updatedAt: now
				},
				$setOnInsert: { createdAt: now }
			},
			{ upsert: true }
		);
		await col('opentrons_scanner_position_sets').updateMany({ robotId: id, _id: { $ne: `sim-positions-s0${n}` } }, { $set: { isDefault: false } });
		console.log(`  robot ${name} (${id}, ${deviceId}, http://127.0.0.1:${port})`);
	}

	// ── shared: deck, wax lot, reagent set lot + fill lot ──
	await col('equipment').updateOne(
		{ _id: 'sim-deck-001' },
		{ $set: { name: 'SIM Deck 001', equipmentType: 'deck', status: 'available', isActive: true, barcode: 'SIM-DECK-001', deckLoadName: 'sim_deck', updatedAt: now }, $setOnInsert: { createdAt: now } },
		{ upsert: true }
	);
	await col('wax_batches').updateOne(
		{ _id: 'sim-wax-lot-001' },
		{
			$set: { lotNumber: 'WAX-SIM-0001', lotBarcode: 'SIM-WAX-0001', initialVolumeUl: 200_000, remainingVolumeUl: 200_000, fullTubeCount: 10, partialTubeMl: 0, createdBy: op, updatedAt: now },
			$setOnInsert: { usageLog: [], createdAt: now }
		},
		{ upsert: true }
	);
	await col('reagent_set_lots').updateOne(
		{ _id: 'sim-reagent-lot-001' },
		{ $set: { lotNumber: 'RSL-SIM-0001', name: 'SIM reagent set lot', status: 'active', components: [], createdBy: 'ot2-sim seed', updatedAt: now }, $setOnInsert: { createdAt: now } },
		{ upsert: true }
	);
	await col('fill_lots').updateOne(
		{ _id: 'sim-fill-lot-001' },
		{
			$set: { fillLotNumber: 'FL-SIM-001', name: 'SIM fill lot', status: 'open', reagentLotId: 'sim-reagent-lot-001', reagentLotNumber: 'RSL-SIM-0001', reagentLotSource: 'sim', fillDate: now.toISOString().slice(0, 10), createdBy: 'ot2-sim seed', updatedAt: now },
			$setOnInsert: { runIds: [], createdAt: now }
		},
		{ upsert: true }
	);
	// Stored .py for the run-start freshness gate's re-sync — only when the
	// line has none active (the real ones must keep winning when present).
	for (const p of ['wax-filling', 'reagent-filling']) {
		const active = await col('opentrons_protocols').findOne({ processType: p, isActive: true, _id: { $not: /^sim-/ } }, { projection: { _id: 1 } });
		if (active) {
			await col('opentrons_protocols').deleteMany({ _id: `sim-protocol-${p}` });
			console.log(`  stored ${p} .py: real one present (${active._id}) — no sim copy`);
			continue;
		}
		await col('opentrons_protocols').updateOne(
			{ _id: `sim-protocol-${p}` },
			{ $set: { protocolName: `${p} SIM`, version: 1, processType: p, fileName: `${p === 'wax-filling' ? 'Wax' : 'Reagent'}_Filling_SIM.py`, fileContent: SIM_PY(p), isActive: true, deployments: [], updatedAt: now }, $setOnInsert: { createdAt: now } },
			{ upsert: true }
		);
		console.log(`  stored ${p} .py: sim placeholder written`);
	}

	// ── cartridges: SIM-W-#### backing (wax-ready), SIM-R-#### wax_filled (reagent-ready) ──
	const carts = col('cartridge_records');
	const ops: any[] = [];
	for (let i = 1; i <= CARTS; i++) {
		const id4 = String(i).padStart(4, '0');
		ops.push({
			updateOne: {
				filter: { _id: `SIM-W-${id4}` },
				update: { $setOnInsert: { status: 'backing', statusUpdatedOn: now.toISOString(), backing: { manualBackedAt: now, recordedAt: now, operator: op }, notes: [{ _id: `sim-note-w-${id4}`, body: 'Simulator cartridge (scripts/ot2-sim). Not a real part.', phase: 'sim', author: op, createdAt: now }], createdAt: now, updatedAt: now } },
				upsert: true
			}
		});
		ops.push({
			updateOne: {
				filter: { _id: `SIM-R-${id4}` },
				update: { $setOnInsert: { status: 'wax_filled', statusUpdatedOn: now.toISOString(), backing: { manualBackedAt: now, recordedAt: now, operator: op }, waxFilling: { recordedAt: now, operator: op, runId: null, robotId: null, note: 'sim' }, notes: [{ _id: `sim-note-r-${id4}`, body: 'Simulator cartridge (scripts/ot2-sim). Not a real part.', phase: 'sim', author: op, createdAt: now }], createdAt: now, updatedAt: now } },
				upsert: true
			}
		});
	}
	const res = await carts.bulkWrite(ops, { ordered: false });
	console.log(`  cartridges: ${res.upsertedCount} new (${CARTS} backing + ${CARTS} wax_filled kept)`);
	console.log('\nNext: run the daemon —');
	console.log('  BIMS_BASE_URL=<bims url> AGENT_API_KEY=<key> MONGODB_URI=<uri> npx tsx scripts/ot2-sim/daemon.ts');
	console.log('then open /manufacturing/cart-mfg/robots. Remove everything with --teardown.');
}

try {
	if (TEARDOWN) await teardown();
	else if (RESET_CARTS) await resetCarts();
	else await seed();
} finally {
	await mongoose.disconnect();
}
