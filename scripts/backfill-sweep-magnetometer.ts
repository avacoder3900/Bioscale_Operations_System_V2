/**
 * Backfill: which magnetometer took each stored magnet sweep.
 *
 * Sweeps stored before BIMS recorded the magnetometer carry no identity. The two
 * magnetometers differ in the resting (zero-field) offsets of their 15 sensors,
 * and that offset pattern is in every complete sweep, so the instrument can be
 * recovered from the data itself. This script classifies each stored `mag_sweep`
 * session and writes `magnetometer: { ..., source: 'inferred' }`.
 *
 *   npx tsx --tsconfig tsconfig.json scripts/backfill-sweep-magnetometer.ts            # report only
 *   npx tsx --tsconfig tsconfig.json scripts/backfill-sweep-magnetometer.ts --apply    # write
 *   ... --mag002=MAG-002-<24 hex>     full barcode of the second magnetometer, when known
 *
 * Method (validated on the stored sweeps, 2026-11-16):
 *   1. Mean each sensor (wells 1-5 x lanes A/B/C) per stage position.
 *   2. Per sensor: the position of its peak z, then the median x, y and z over
 *      positions at least 24 mm from that peak — the sensor's resting offset.
 *      Only wells 1, 2, 4 and 5 have such positions: 12 sensors x 3 axes = 36 features.
 *   3. Centre = median of each feature over sweeps created before 2026-11-09,
 *      scale = 1.4826 x MAD of the same set. That set knowingly contains nine
 *      group B sweeps from Sep 29-30; the median is robust to them, and it is
 *      kept this way so the result matches the validated analysis.
 *   4. Direction = mean z-vector of the sweeps created 2026-11-11 (0211, 0245, 0247).
 *      Projection = dot(z, direction) / |direction|^2 — near 0 for group A, near 1
 *      for group B, nothing in between. < 0.35 = A, > 0.65 = B, else unassigned.
 *
 * Group A is MAG-001 (anchored by device logs); group B is MAG-002.
 *
 * Skipped: partial sweeps (a sensor with fewer than 190 positions), a sensor whose
 * peak z is below 3000, and the known-bad 0247 sweep of 2026-09-25.
 * Never overwrites an identity whose source is not 'inferred'.
 *
 * A sweep whose stored header already names the magnetometer (rawData.meta.mag,
 * firmware v110+) is not fingerprinted into an 'inferred' value: the device's
 * own statement is promoted instead, with source 'device'.
 */
import 'dotenv/config';
import mongoose from 'mongoose';
import { ValidationSession, AuditLog } from '../src/lib/server/db/models/index.js';
import { generateId } from '../src/lib/server/db/utils.js';
import { aggregate, ROW_FIELDS } from '../src/lib/server/validation/mag-sweep.js';
import {
	chooseScan,
	decodeDeviceLogEvent,
	extractMagnetometerScans,
	normaliseMagnetometerBarcode,
	pickMagnetometer,
	SCAN_WINDOWS,
	type MagnetometerScan
} from '../src/lib/server/magnetometer-identity.js';

const uri = process.env.MONGODB_URI;
if (!uri) {
	console.error('MONGODB_URI not set in .env');
	process.exit(1);
}
const apply = process.argv.includes('--apply');
const mag002Arg = process.argv.find((a) => a.startsWith('--mag002='))?.slice('--mag002='.length) ?? null;

const MAG_001 = { barcode: 'MAG-001-e00fce685d49ee5dc2a29545', label: 'MAG-001' };
let MAG_002 = { barcode: 'MAG-002', label: 'MAG-002' };
if (mag002Arg) {
	const id = normaliseMagnetometerBarcode(mag002Arg);
	if (!id || id.label !== 'MAG-002') {
		console.error(`--mag002=${mag002Arg} is not a MAG-002 barcode (expected MAG-002-<hex>)`);
		process.exit(1);
	}
	MAG_002 = id;
}

const PRE_CUTOFF = '2026-11-09'; // centre/scale set: createdAt before this (UTC)
const DIRECTION_DATE = '2026-11-11';
const DIRECTION_DEVICES = ['0211', '0245', '0247'];
const FAR_UM = 24000;
const MIN_POSITIONS = 190;
const MIN_PEAK_Z = 3000;
const A_BELOW = 0.35;
const B_ABOVE = 0.65;
/** The expected list below was drawn up from sweeps stored up to midday (US Central) on Nov 16. */
const EXPECTED_AS_OF = new Date('2026-11-16T18:00:00Z');

/** Expected group B, as `<udi suffix> <UTC date>`; a repeated entry means two sweeps. */
const EXPECTED_B = [
	'0251 2026-09-29',
	'0210 2026-09-30', '0217 2026-09-30', '0222 2026-09-30', '0243 2026-09-30', '0245 2026-09-30',
	'0249 2026-09-30', '0249 2026-09-30', '0257 2026-09-30',
	'0202 2026-11-09', '0215 2026-11-09', '0218 2026-11-09', '0222 2026-11-09', '0236 2026-11-09',
	'0244 2026-11-09', '0249 2026-11-09', '0256 2026-11-09',
	'0211 2026-11-11', '0245 2026-11-11', '0247 2026-11-11',
	'0251 2026-11-16', '0252 2026-11-16'
];

const WELLS = [1, 2, 3, 4, 5];
const LANES = ['A', 'B', 'C'];
const AXES = ['x', 'y', 'z'] as const;
/** The 36 features: wells 1, 2, 4, 5 x lanes x axes, in a fixed order. */
const FEATURE_KEYS: string[] = [];
for (const w of [1, 2, 4, 5]) for (const l of LANES) for (const ax of AXES) FEATURE_KEYS.push(`${w}${l}${ax}`);

const mean = (a: number[]) => a.reduce((s, v) => s + v, 0) / a.length;
const med = (a: number[]) => {
	const s = a.slice().sort((x, y) => x - y);
	const n = s.length;
	return n % 2 ? s[(n - 1) / 2] : (s[n / 2 - 1] + s[n / 2]) / 2;
};

/**
 * Stored rows -> the canonical raw layout aggregate() reads, resolving columns
 * BY NAME from rawData.fields (raw per-rep rows and the 17/18-column means
 * layout both work). A channel whose x, y, z and t are all exactly zero is the
 * device's "read nothing here" placeholder and is left out, not averaged in.
 */
function canonicalRows(rawData: any): number[][] {
	const fields: string[] = Array.isArray(rawData?.fields) && rawData.fields.length
		? rawData.fields.map(String)
		: ['y', 'well', 'rep', 'tA', 'xA', 'yA', 'zA', 'tB', 'xB', 'yB', 'zB', 'tC', 'xC', 'yC', 'zC'];
	const iy = fields.indexOf('y');
	const iw = fields.indexOf('well');
	if (iy < 0 || iw < 0) return [];
	const cols = LANES.map((l) => ({
		t: fields.indexOf('t' + l), x: fields.indexOf('x' + l), y: fields.indexOf('y' + l), z: fields.indexOf('z' + l)
	}));

	const out: number[][] = [];
	for (const r of (rawData?.rows ?? []) as unknown[]) {
		if (!Array.isArray(r)) continue;
		const row = new Array<number>(ROW_FIELDS).fill(NaN);
		row[0] = Number(r[iy]);
		row[1] = Number(r[iw]);
		row[2] = 1;
		cols.forEach((c, ci) => {
			if (c.x < 0 || c.y < 0 || c.z < 0) return;
			const x = Number(r[c.x]), y = Number(r[c.y]), z = Number(r[c.z]);
			const t = c.t >= 0 ? Number(r[c.t]) : NaN;
			if (![x, y, z].every(Number.isFinite)) return;
			if (x === 0 && y === 0 && z === 0 && (t === 0 || !Number.isFinite(t))) return;
			const base = 3 + ci * 4;
			row[base] = t; row[base + 1] = x; row[base + 2] = y; row[base + 3] = z;
		});
		out.push(row);
	}
	return out;
}

interface Sweep {
	id: string;
	udi: string;
	createdAt: Date;
	date: string;
	file: string;
	existing: { barcode?: string; label?: string; source?: string } | null;
	particleDeviceId: string | null;
	testRanAt: Date | null;
	skip: string | null;
	features: number[] | null;
	z?: number[];
	projection?: number;
	group?: 'A' | 'B' | null;
	logMatch?: MagnetometerScan | null;
	/** What the device wrote in the sweep header (rawData.meta.mag), if anything. */
	metaMag: { barcode: string; label: string } | null;
}

function fingerprint(rawData: any): { skip: string } | { features: number[] } {
	const series = aggregate(canonicalRows(rawData));
	const peakY = new Map<string, number>();
	for (const w of WELLS) for (const l of LANES) {
		const s = series.get(`${w}|${l}`);
		if (!s || s.length < MIN_POSITIONS) return { skip: `partial (sensor ${w}${l}: ${s?.length ?? 0} positions)` };
		let pk = s[0];
		for (const p of s) if (p.bz > pk.bz) pk = p;
		if (pk.bz < MIN_PEAK_Z) return { skip: `sensor ${w}${l} peak z ${pk.bz.toFixed(0)} below ${MIN_PEAK_Z}` };
		peakY.set(`${w}|${l}`, pk.y);
	}

	const byKey = new Map<string, number>();
	for (const w of WELLS) for (const l of LANES) {
		const s = series.get(`${w}|${l}`)!;
		const pk = peakY.get(`${w}|${l}`)!;
		const far = s.filter((p) => Math.abs(p.y - pk) >= FAR_UM);
		if (far.length < 8) continue;
		byKey.set(`${w}${l}x`, med(far.map((p) => p.bx)));
		byKey.set(`${w}${l}y`, med(far.map((p) => p.by)));
		byKey.set(`${w}${l}z`, med(far.map((p) => p.bz)));
	}
	// Exactly the 36 expected features, or the sweep is not comparable with the rest.
	if (byKey.size !== FEATURE_KEYS.length || !FEATURE_KEYS.every((k) => byKey.has(k))) {
		return { skip: `resting-offset features ${byKey.size}, expected ${FEATURE_KEYS.length}` };
	}
	return { features: FEATURE_KEYS.map((k) => byKey.get(k)!) };
}

async function main() {
	await mongoose.connect(uri!);
	const db = mongoose.connection.db!;
	console.log(`Mode: ${apply ? 'APPLY (writes)' : 'report only (no writes)'}`);
	console.log(`MAG-001 = ${MAG_001.barcode}`);
	console.log(`MAG-002 = ${MAG_002.barcode}${mag002Arg ? '' : '  (full barcode unknown: label only; pass --mag002=<barcode> to store it)'}\n`);

	// ---- load + fingerprint ------------------------------------------------
	const sweeps: Sweep[] = [];
	const cursor = db.collection('validation_sessions').find({ type: 'mag_sweep' }).sort({ createdAt: 1 });
	for await (const s of cursor as any) {
		const createdAt = new Date(s.createdAt ?? s.startedAt);
		const udi = String(s.spuUdi ?? '').slice(-4);
		const date = createdAt.toISOString().slice(0, 10);
		const base: Sweep = {
			id: String(s._id), udi, createdAt, date,
			file: String(s.rawData?.sourceFile ?? ''),
			existing: s.magnetometer?.barcode ? s.magnetometer : null,
			particleDeviceId: s.particleDeviceId ?? null,
			testRanAt: s.testRanAt ? new Date(s.testRanAt) : null,
			metaMag: pickMagnetometer(null, s.rawData?.meta),
			skip: null, features: null
		};
		if (!Array.isArray(s.rawData?.rows) || s.rawData.rows.length === 0) base.skip = 'no rows';
		else if (udi === '0247' && date === '2026-09-25') base.skip = 'known-bad 0247 sweep of 2026-09-25';
		else {
			const f = fingerprint(s.rawData);
			if ('skip' in f) base.skip = f.skip;
			else base.features = f.features;
		}
		sweeps.push(base);
	}

	const good = sweeps.filter((s) => s.features);
	const pre = good.filter((s) => s.createdAt.toISOString() < PRE_CUTOFF);
	const dirSet = good.filter((s) => s.date === DIRECTION_DATE);
	console.log(`mag_sweep sessions: ${sweeps.length}   usable: ${good.length}   skipped: ${sweeps.length - good.length}`);
	console.log(`centre/scale set (created before ${PRE_CUTOFF}): ${pre.length}   direction set (${DIRECTION_DATE}): ${dirSet.map((s) => s.udi).join(', ') || 'none'}`);

	const problems: string[] = [];
	if (pre.length < 10) problems.push(`only ${pre.length} sweeps before ${PRE_CUTOFF} — too few for a centre and scale`);
	const dirDevices = dirSet.map((s) => s.udi).sort().join(',');
	if (dirDevices !== DIRECTION_DEVICES.slice().sort().join(',')) {
		problems.push(`direction set is [${dirDevices}], expected [${DIRECTION_DEVICES.join(',')}]`);
	}
	if (pre.length < 10 || dirSet.length === 0) {
		console.error('\nCannot classify: ' + problems.join('; '));
		await mongoose.disconnect();
		process.exit(1);
	}

	// ---- centre, scale, direction, projection --------------------------------
	const n = FEATURE_KEYS.length;
	const centre: number[] = [], scale: number[] = [];
	for (let i = 0; i < n; i++) {
		const v = pre.map((s) => s.features![i]);
		const c = med(v);
		centre.push(c);
		scale.push(med(v.map((x) => Math.abs(x - c))) * 1.4826 + 1e-9);
	}
	for (const s of good) s.z = s.features!.map((v, i) => (v - centre[i]) / scale[i]);
	const dir: number[] = [];
	for (let i = 0; i < n; i++) dir.push(mean(dirSet.map((s) => s.z![i])));
	const norm2 = dir.reduce((a, v) => a + v * v, 0);
	for (const s of good) {
		s.projection = s.z!.reduce((a, v, i) => a + v * dir[i], 0) / norm2;
		s.group = s.projection < A_BELOW ? 'A' : s.projection > B_ABOVE ? 'B' : null;
	}

	// ---- cross-check against device logs (read-only) -------------------------
	// Independent of the fingerprint: where a device log shows a barcode scan
	// shortly before the sweep, say what it named.
	const scansByDevice = new Map<string, MagnetometerScan[]>();
	for (const s of sweeps) {
		if (!s.particleDeviceId) continue;
		let scans = scansByDevice.get(s.particleDeviceId);
		if (!scans) {
			scans = [];
			const logs = await db.collection('device_logs')
				.find({ deviceId: s.particleDeviceId, 'logLines.message': /MAG-\d{3}/i })
				.project({ uploadedAt: 1, logLines: 1 }).toArray();
			for (const l of logs) scans.push(...extractMagnetometerScans(l.logLines, new Date(l.uploadedAt)));
			const events = await db.collection('device_events')
				.find({ deviceId: s.particleDeviceId, eventType: 'device-log' })
				.project({ createdAt: 1, eventData: 1 }).toArray();
			for (const e of events) scans.push(...extractMagnetometerScans(decodeDeviceLogEvent(e.eventData), new Date(e.createdAt)));
			scansByDevice.set(s.particleDeviceId, scans);
		}
		s.logMatch = chooseScan(scans, s.testRanAt ?? s.createdAt, SCAN_WINDOWS.mag_sweep);
	}

	// ---- per-sweep table ------------------------------------------------------
	console.log('\ndev   created (UTC)      proj   group  assign    existing             device log   file');
	for (const s of sweeps) {
		const proj = s.projection != null ? s.projection.toFixed(2).padStart(6) : '     -';
		const grp = s.skip ? 'skip ' : s.group ?? '?    ';
		const assign = s.skip ? '-' : s.group === 'A' ? 'MAG-001' : s.group === 'B' ? 'MAG-002' : 'unassigned';
		const ex = s.existing ? `${s.existing.label ?? s.existing.barcode} (${s.existing.source})` : '-';
		const log = s.logMatch ? s.logMatch.label : '-';
		console.log(
			`${s.udi.padEnd(5)} ${s.createdAt.toISOString().slice(0, 16).replace('T', ' ')}  ${proj}   ${String(grp).padEnd(5)}  ${assign.padEnd(9)} ${ex.padEnd(20)} ${log.padEnd(12)} ${s.file}${s.skip ? `   [${s.skip}]` : ''}`
		);
	}

	const A = good.filter((s) => s.group === 'A');
	const B = good.filter((s) => s.group === 'B');
	const U = good.filter((s) => s.group === null);
	const range = (a: Sweep[]) => a.length ? `${Math.min(...a.map((s) => s.projection!)).toFixed(2)} .. ${Math.max(...a.map((s) => s.projection!)).toFixed(2)}` : '-';
	console.log(`\nGroup A (MAG-001): ${A.length}   projection ${range(A)}`);
	console.log(`Group B (MAG-002): ${B.length}   projection ${range(B)}`);
	console.log(`Unassigned (${A_BELOW} .. ${B_ABOVE}): ${U.length}${U.length ? '   ' + U.map((s) => `${s.udi} ${s.date} ${s.projection!.toFixed(2)}`).join('; ') : ''}`);
	console.log(`Skipped: ${sweeps.length - good.length}`);

	// ---- does group B reproduce the expected list? ----------------------------
	const gotB = B.filter((s) => s.createdAt <= EXPECTED_AS_OF).map((s) => `${s.udi} ${s.date}`).sort();
	const laterB = B.filter((s) => s.createdAt > EXPECTED_AS_OF);
	const want = EXPECTED_B.slice().sort();
	const missing = want.slice();
	const extra: string[] = [];
	for (const g of gotB) {
		const i = missing.indexOf(g);
		if (i >= 0) missing.splice(i, 1);
		else extra.push(g);
	}
	console.log(`\nExpected group B list (${want.length} sweeps, stored up to ${EXPECTED_AS_OF.toISOString()}):`);
	if (missing.length === 0 && extra.length === 0) {
		console.log(`  REPRODUCED: all ${want.length} expected sweeps are group B and no other sweep is.`);
	} else {
		console.log('  NOT REPRODUCED.');
		if (missing.length) console.log(`  expected in group B but not classified B: ${missing.join('; ')}`);
		if (extra.length) console.log(`  classified B but not expected: ${extra.join('; ')}`);
		problems.push('group B does not match the expected list');
	}
	if (laterB.length) console.log(`  group B sweeps stored after that time: ${laterB.map((s) => `${s.udi} ${s.createdAt.toISOString().slice(0, 16)}`).join('; ')}`);

	// ---- device-log agreement -------------------------------------------------
	const withLog = good.filter((s) => s.logMatch && s.group);
	const disagree = withLog.filter((s) => s.logMatch!.label !== (s.group === 'A' ? 'MAG-001' : 'MAG-002'));
	console.log(`\nDevice-log cross-check: ${withLog.length} classified sweeps have a barcode scan in a device log within ${SCAN_WINDOWS.mag_sweep.beforeMs / 60000} min before them; ${withLog.length - disagree.length} agree, ${disagree.length} disagree.`);
	for (const s of disagree) console.log(`  DISAGREE ${s.udi} ${s.createdAt.toISOString()} fingerprint ${s.group} vs log ${s.logMatch!.barcode}`);
	if (disagree.length) problems.push('fingerprint and device log disagree on at least one sweep');

	// ---- what would be written -----------------------------------------------
	const todo: { s: Sweep; id: { barcode: string; label: string }; source: 'inferred' | 'device' }[] = [];
	let keptOther = 0, unchanged = 0;
	for (const s of sweeps) {
		if (s.existing && s.existing.source !== 'inferred') { keptOther++; continue; }
		// The device's own header beats the fingerprint, usable sweep or not.
		if (s.metaMag) { todo.push({ s, id: s.metaMag, source: 'device' }); continue; }
		if (!s.features || !s.group) continue;
		const id = s.group === 'A' ? MAG_001 : MAG_002;
		if (s.existing && s.existing.barcode === id.barcode) { unchanged++; continue; }
		todo.push({ s, id, source: 'inferred' });
	}
	const nDevice = todo.filter((t) => t.source === 'device').length;
	console.log(`\nTo write: ${todo.length - nDevice} as 'inferred', ${nDevice} promoted from the stored header (rawData.meta.mag) as 'device'   already inferred with the same value: ${unchanged}   left alone (identity from another source): ${keptOther}`);
	const metaDisagree = good.filter((s) => s.metaMag && s.group && s.metaMag.label !== (s.group === 'A' ? 'MAG-001' : 'MAG-002'));
	for (const s of metaDisagree) console.log(`  NOTE ${s.udi} ${s.createdAt.toISOString()}: header says ${s.metaMag!.barcode}, fingerprint says group ${s.group}`);
	if (metaDisagree.length) problems.push('fingerprint and a sweep header (meta.mag) disagree on at least one sweep');

	if (problems.length) {
		console.log('\nPROBLEMS:');
		for (const p of problems) console.log('  - ' + p);
	}

	if (!apply) {
		console.log('\nReport only. Re-run with --apply to write.');
		await mongoose.disconnect();
		return;
	}
	if (problems.length) {
		console.error('\nRefusing to --apply while the problems above stand.');
		await mongoose.disconnect();
		process.exit(1);
	}

	let written = 0;
	const now = new Date();
	for (const { s, id, source } of todo) {
		const record = { barcode: id.barcode, label: id.label, source, recordedAt: now, recordedBy: 'script:backfill-sweep-magnetometer' };
		// Guarded again at write time: never replace an identity from another source.
		const res = await ValidationSession.updateOne(
			{
				_id: s.id,
				type: 'mag_sweep',
				$or: [{ magnetometer: null }, { 'magnetometer.barcode': { $in: [null, ''] } }, { 'magnetometer.source': 'inferred' }]
			},
			{ $set: { magnetometer: record } }
		);
		if (!res.modifiedCount) continue;
		written++;
		await AuditLog.create({
			_id: generateId(),
			tableName: 'validation_sessions',
			recordId: s.id,
			action: 'UPDATE',
			oldData: { magnetometer: s.existing },
			newData: { magnetometer: record, projection: s.projection != null ? Number(s.projection.toFixed(3)) : null },
			changedAt: now,
			changedBy: 'script:backfill-sweep-magnetometer',
			reason: source === 'device'
				? `Magnetometer ${id.label} taken from the sweep's own header (rawData.meta.mag)`
				: `Magnetometer ${id.label} inferred from the sweep's sensor resting offsets (projection ${s.projection!.toFixed(2)})`
		});
	}
	console.log(`\nWrote ${written} of ${todo.length}.`);
	await mongoose.disconnect();
}

main().catch(async (e) => {
	console.error(e);
	await mongoose.disconnect();
	process.exit(1);
});
