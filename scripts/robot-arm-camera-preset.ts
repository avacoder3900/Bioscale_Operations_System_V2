/**
 * Save a robot-arm camera preset straight into Mongo (no running app needed).
 *
 *   npx tsx scripts/robot-arm-camera-preset.ts --name "Camera defaults — Shared Office, Blinds Open" \
 *       --conditions "Shared office, blinds open, daylight through the window" \
 *       --kind camera-default --values '{"auto_exposure":3,"exposure_time_absolute":166,...}' \
 *       [--camera external] [--notes "..."] [--by alejandro] [--controls controls.json]
 *
 * `--values` is the control name → raw value map as camera_controls.py reports
 * it; `--controls` may point at a saved GET /cameras/{name}/controls answer so
 * the ranges/defaults are stored with the preset. Reads MONGODB_URI from .env.
 * Normal use is the Vision tab's "Save current as…" button; this exists for the
 * first preset and for recording values captured on the Pi directly.
 */
import mongoose from 'mongoose';
import { nanoid } from 'nanoid';
import * as dotenv from 'dotenv';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, resolve } from 'path';
import { RobotArmCameraPreset } from '../src/lib/server/db/models/robot-arm-camera-preset.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: resolve(__dirname, '..', '.env') });

function arg(name: string): string | undefined {
	const i = process.argv.indexOf(`--${name}`);
	return i === -1 ? undefined : process.argv[i + 1];
}

async function main() {
	const uri = process.env.MONGODB_URI;
	if (!uri) throw new Error('MONGODB_URI not found in .env');
	const name = arg('name');
	const valuesRaw = arg('values');
	if (!name || !valuesRaw) throw new Error('--name and --values are required');
	const values = JSON.parse(valuesRaw) as Record<string, number>;
	for (const [k, v] of Object.entries(values)) {
		if (!/^[a-z0-9_]{1,64}$/.test(k) || !Number.isInteger(v)) throw new Error(`bad value ${k}=${v}`);
	}
	const controlsFile = arg('controls');
	const report = controlsFile ? JSON.parse(readFileSync(controlsFile, 'utf-8')) : null;
	const controls = Array.isArray(report?.controls)
		? report.controls.map((c: any) => ({ id: c.id, type: c.type, min: c.min, max: c.max, step: c.step, default: c.default, value: c.value, flags: c.flags ?? [], unit: c.unit ?? '' }))
		: [];
	const kind = arg('kind') === 'camera-default' ? 'camera-default' : 'operator';
	const by = arg('by') ?? 'script';

	await mongoose.connect(uri);
	const doc = await RobotArmCameraPreset.create({
		_id: nanoid(),
		cameraName: arg('camera') ?? 'external',
		name,
		conditions: arg('conditions') ?? null,
		notes: arg('notes') ?? null,
		kind,
		values,
		controls,
		device: report?.device ?? null,
		createdBy: { _id: `script:${by}`, username: by }
	});
	console.log(`saved preset ${doc._id}: "${doc.name}" (${kind}, ${Object.keys(values).length} values, ${controls.length} control ranges)`);
	await mongoose.disconnect();
}

main().catch((e) => {
	console.error(e instanceof Error ? e.message : e);
	process.exit(1);
});
