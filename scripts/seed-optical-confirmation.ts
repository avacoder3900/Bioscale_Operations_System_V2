/**
 * Seed + inspect the optical-confirmation storage shape.
 *
 * Runs the full flow against your Mongo using the REAL Mongoose models
 * (so what you see is exactly what the API endpoints persist):
 *   1. ensure the OCA-STD assay + a criteria range exist
 *   2. capture an optical_test LabCartridge
 *   3. attach it to a sample SPU
 *   4. store a multi-channel optical reading + evaluate vs the range
 *   5. print the three resulting documents
 *
 * Usage (in a clone with deps + a .env containing MONGODB_URI):
 *   npx tsx scripts/seed-optical-confirmation.ts
 *   npx tsx scripts/seed-optical-confirmation.ts --cleanup   # remove the test docs and exit
 *
 * It is idempotent: prior test artifacts (udi TEST-OCA-001, barcode OCA-0001)
 * are removed at the start of every run.
 */
import mongoose from 'mongoose';
import * as dotenv from 'dotenv';
import { fileURLToPath } from 'url';
import { dirname, resolve } from 'path';

import { Spu } from '../src/lib/server/db/models/spu.js';
import { LabCartridge } from '../src/lib/server/db/models/lab-cartridge.js';
import { AssayDefinition } from '../src/lib/server/db/models/assay-definition.js';
import { ManufacturingSettings } from '../src/lib/server/db/models/manufacturing-settings.js';
import { ValidationSession } from '../src/lib/server/db/models/validation-session.js';
import { generateId } from '../src/lib/server/db/utils.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: resolve(__dirname, '..', '.env') });

const TEST_UDI = 'TEST-OCA-001';
const TEST_BARCODE = 'OCA-0001';
const ASSAY_SKU = 'OCA-STD';

const uri = process.env.MONGODB_URI;
if (!uri) {
	console.error('MONGODB_URI is not set. Add it to .env or the environment.');
	process.exit(1);
}

// Same evaluation the result endpoint uses: last reading per channel vs range.
function evaluate(readings: any[], parameters: any[]) {
	const results = (parameters ?? []).map((p) => {
		const last = readings.filter((r) => r.channel === p.channel).sort((a, b) => a.readingNumber - b.readingNumber).at(-1);
		const value = last ? last.value : null;
		const passed = value !== null && (p.min == null || value >= p.min) && (p.max == null || value <= p.max);
		return { name: p.name, channel: p.channel, unit: p.unit, value, min: p.min ?? null, max: p.max ?? null, passed };
	});
	const failureReasons = results.filter((r) => !r.passed).map((r) => `${r.name} out of range`);
	return { results, overallPassed: failureReasons.length === 0, failureReasons };
}

async function cleanup() {
	const spu = await Spu.findOne({ udi: TEST_UDI });
	if (spu) await ValidationSession.deleteMany({ spuId: spu._id });
	await Spu.deleteMany({ udi: TEST_UDI });
	await LabCartridge.deleteMany({ barcode: TEST_BARCODE });
}

await mongoose.connect(uri);
console.log('MongoDB connected\n');

await cleanup();
if (process.argv.includes('--cleanup')) {
	console.log('Cleaned up test artifacts. Done.');
	await mongoose.disconnect();
	process.exit(0);
}

const op = { _id: 'seed-script', username: 'seed-script' };
const now = new Date();

// 1) assay + criteria range -------------------------------------------------
let assay = await AssayDefinition.findOne({ skuCode: ASSAY_SKU });
if (!assay) assay = await AssayDefinition.create({ _id: generateId(), name: 'Optical Confirm', skuCode: ASSAY_SKU, isActive: true });

await ManufacturingSettings.findByIdAndUpdate(
	'default',
	{
		$set: {
			opticalConfirmation: {
				parameters: [
					{ name: 'channelA', channel: 'A', unit: 'OD', min: 0.3, max: 0.6, target: 0.45, required: true },
					{ name: 'channelB', channel: 'B', unit: 'OD', min: 0.0, max: 0.2, target: 0.1, required: true }
				],
				locked: false,
				version: 1
			}
		}
	},
	{ upsert: true, new: true }
);
const settings = await ManufacturingSettings.findById('default').lean();
const criteria = (settings as any).opticalConfirmation;

// 2) sample SPU + capture cartridge ----------------------------------------
const spu = await Spu.create({ _id: generateId(), udi: TEST_UDI, status: 'validating' });

const cartridge = await LabCartridge.create({
	_id: generateId(),
	barcode: TEST_BARCODE,
	cartridgeType: 'optical_test',
	status: 'available',
	assay: { _id: assay._id, name: assay.name, skuCode: assay.skuCode },
	notes: `Optical confirmation assay ${assay.skuCode} - captured as wax cartridge (off standard workflow)`,
	usageLog: [{ action: 'registered', newValue: assay.skuCode, performedBy: op, performedAt: now }],
	createdBy: op._id
});

// 3) attach -----------------------------------------------------------------
spu.validation.opticalConfirmation = {
	status: 'pending',
	labCartridgeId: cartridge._id,
	cartridgeBarcode: cartridge.barcode,
	assay: { _id: assay._id, name: assay.name, skuCode: assay.skuCode },
	attachedAt: now,
	attachedBy: op
};
spu.markModified('validation.opticalConfirmation');
await spu.save();
cartridge.status = 'in_use';
cartridge.usageLog.push({ action: 'used', spuId: spu._id, performedBy: op, performedAt: now });
await cartridge.save();

// 4) store a reading + evaluate --------------------------------------------
const readings = [
	{ readingNumber: 1, channel: 'A', value: 0.412, timestampMs: 0 },
	{ readingNumber: 2, channel: 'A', value: 0.418, timestampMs: 1000 },
	{ readingNumber: 3, channel: 'B', value: 0.095, timestampMs: 1000 }
];
const { results, overallPassed, failureReasons } = evaluate(readings, criteria.parameters);
const criteriaUsed = { version: criteria.version ?? 1, parameters: criteria.parameters };

const session = await ValidationSession.create({
	_id: generateId(),
	type: 'optical_confirmation',
	spuId: spu._id,
	spuUdi: spu.udi,
	status: overallPassed ? 'completed' : 'failed',
	startedAt: now,
	completedAt: now,
	userId: op._id,
	barcode: cartridge.barcode,
	rawData: { readings },
	results: [{ _id: generateId(), testType: 'optical_confirmation', rawData: { readings }, processedData: results, passed: overallPassed, createdAt: now }],
	overallPassed,
	failureReasons,
	criteriaUsed
});

const ocPath = spu.validation.opticalConfirmation;
ocPath.status = overallPassed ? 'passed' : 'failed';
ocPath.sessionId = session._id;
ocPath.completedAt = now;
ocPath.rawData = { readings };
ocPath.results = results;
ocPath.criteriaUsed = criteriaUsed;
ocPath.failureReasons = failureReasons;
spu.markModified('validation.opticalConfirmation');
await spu.save();

cartridge.status = 'depleted';
cartridge.usageLog.push({ action: 'status_changed', previousValue: 'in_use', newValue: 'depleted', spuId: spu._id, validationSessionId: session._id, performedBy: op, performedAt: now });
await cartridge.save();

// 5) print what got stored --------------------------------------------------
const storedSpu = await Spu.findById(spu._id).lean();
const storedCart = await LabCartridge.findById(cartridge._id).lean();
const storedSession = await ValidationSession.findById(session._id).lean();

const show = (label: string, doc: any) => {
	console.log('\n===== ' + label + ' =====');
	console.log(JSON.stringify(doc, null, 2));
};

console.log(`Result: ${overallPassed ? 'PASSED' : 'FAILED'}  failureReasons=${JSON.stringify(failureReasons)}`);
show('spu.validation.opticalConfirmation', (storedSpu as any).validation.opticalConfirmation);
show('ValidationSession', storedSession);
show('LabCartridge', storedCart);

await mongoose.disconnect();
console.log('\nDone. Re-run with --cleanup to remove these test docs.');
