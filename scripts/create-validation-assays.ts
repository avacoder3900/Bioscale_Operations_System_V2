/**
 * Create the three new validation assays (Jacob's plan, 2026-09-15).
 *
 * The Lambda compiles `BCODE.code` (JSON steps) into BCODE and computes the
 * checksum when a device loads the assay, so an assay is just a document in
 * assay_definitions with the same shape as A9EB41AD. Each one still has to be
 * pushed to the units from the research app's Devices page.
 *
 *  1. PHOTOBLEACH — "Gen 5 Optical Photobleach - 10x Coarse Scans"
 *     Based on A9EB41AD. Ten coarse sweeps of the SAME 4.1 mm the 42-position
 *     scan covers, 10 read positions per sweep (455 µm apart instead of 100),
 *     30 s pause between sweeps, stage returned to the start each time. Every
 *     sweep is 30 readings (10 positions × A/B/C) → 300 total = the firmware's
 *     SPECTRO_MAX_READINGS cap exactly, uploaded as one test. BIMS treats each
 *     sweep as one point per channel.
 *  2. BLANK — "Gen 5 Optical Blank Cartridge"
 *     The A9EB41AD scan verbatim under its own id, so blank-cartridge runs never
 *     mix with validation runs. Triggered by the BLANK- barcode type (firmware
 *     v95) and reported to BIMS over a Particle webhook, never via a cartridge
 *     record.
 *  3. SONIC — "Sonic Fingerprint - Cortisol 5.6 Moves"
 *     A67AC662's MOTION only: wax-melt delay and both sensor-read blocks removed,
 *     every move and wait kept, every oscillation's cycle count scaled by one
 *     factor so the whole run lands near 5 minutes. No readings, nothing to
 *     upload. Triggered by the SONIC- barcode type; a phone recording is
 *     uploaded to BIMS by hand.
 *
 *   npx tsx scripts/create-validation-assays.ts            # dry run: prints steps + durations
 *   npx tsx scripts/create-validation-assays.ts --apply
 */
import mongoose from 'mongoose';
import * as dotenv from 'dotenv';
dotenv.config();

const APPLY = process.argv.includes('--apply');
const SKIP_SONIC = process.argv.includes('--skip-sonic');
const targetArg = process.argv.indexOf('--sonic-target-s');
const SONIC_TARGET_S = targetArg >= 0 ? Number(process.argv[targetArg + 1]) : 300;

// ---- timing model (ported from the Lambda; READ SENSOR is charged 5 s there,
// which overstates real time — we report both) ----
function stepMs(cmd: string, p: any, realReads = false): number {
	switch (cmd) {
		case 'DELAY': return +p.delay_ms;
		case 'MOVE MICRONS': return Math.floor((2 * Math.abs(+p.microns) * +p.step_delay_us) / 25000);
		case 'SINUSOIDAL OSCILLATE': {
			const m = Math.abs(+p.microns), pd = +p.peak_delay_us, sh = +p.shape_pct / 100, c = +p.cycles, N = Math.floor(m / 25);
			let s = 0; for (let i = 0; i < N; i++) s += 1 / Math.pow(Math.sin((Math.PI * (i + 0.5)) / N), sh);
			return Math.floor((pd * s * 2 * c) / 1000);
		}
		case 'READ SENSOR': return realReads ? 500 : 5000;
		case 'START TEST': return 9000;
		case 'FINISH TEST': return 8000;
	}
	return 0;
}
function durationMs(code: any[], realReads = false): number {
	return code.reduce((d, b) => {
		const c = b.command.toUpperCase();
		return d + (c === 'REPEAT' ? durationMs(b.code, realReads) * +b.count : stepMs(c, b.params, realReads));
	}, 0);
}
function print(code: any[], depth = 0) {
	for (const s of code) {
		const keys = Object.keys(s).filter((k) => k !== 'code');
		console.log('  '.repeat(depth) + JSON.stringify(Object.fromEntries(keys.map((k) => [k, s[k]]))));
		if (Array.isArray(s.code)) print(s.code, depth + 1);
	}
}
function newId(existing: Set<string>): string {
	const hex = '0123456789ABCDEF';
	for (;;) {
		let id = 'A';
		for (let i = 0; i < 7; i++) id += hex[Math.floor(Math.random() * 16)];
		if (!existing.has(id)) return id;
	}
}

async function main() {
	await mongoose.connect(process.env.MONGODB_URI!);
	const db = mongoose.connection.db!;
	const assays = db.collection('assay_definitions');
	const optical: any = await assays.findOne({ _id: 'A9EB41AD' });
	const cortisol: any = await assays.findOne({ _id: 'A67AC662' });
	if (!optical || !cortisol) throw new Error('source assays missing');
	const existing = new Set((await assays.find({}).project({ _id: 1 }).toArray()).map((a: any) => String(a._id)));

	// Refuse to create twice.

	// ---------------- 1. PHOTOBLEACH ----------------
	const READ = { command: 'Read Sensor', params: { channel: 0, gain: 7, step: 499, time: 49 } };
	const SWEEPS = 10, POSITIONS = 10, STEP_UM = 455; // 9 × 455 = 4095 µm ≈ the 41 × 100 of the full scan
	const sweep = [
		{ command: 'Repeat', count: POSITIONS, params: {}, code: [READ, { command: 'Move Microns', params: { microns: STEP_UM, step_delay_us: 350 } }] },
		{ command: 'Move Microns', params: { comment: 'Back to the first read position', microns: -(STEP_UM * POSITIONS), step_delay_us: 350 } }
	];
	const photobleachCode: any[] = [
		{ command: 'Start Test', params: {} },
		{ command: 'Move Microns', params: { comment: 'Move to Read Position', microns: 475, step_delay_us: 500 } }
	];
	for (let i = 0; i < SWEEPS; i++) {
		photobleachCode.push(...JSON.parse(JSON.stringify(sweep)));
		if (i < SWEEPS - 1) photobleachCode.push({ command: 'Delay', params: { comment: `Photobleach pause ${i + 1}/${SWEEPS - 1}`, delay_ms: 30000 } });
	}
	photobleachCode.push({ command: 'Finish Test', params: {} });

	// ---------------- 2. BLANK ----------------
	const blankCode = JSON.parse(JSON.stringify(optical.BCODE.code));

	// ---------------- 3. SONIC ----------------
	const motion = (cortisol.BCODE.code as any[]).filter((s) => {
		const c = s.command.toUpperCase();
		if (c === 'DELAY' && +s.params.delay_ms >= 200000) return false; // wax melt
		if (c === 'REPEAT' && s.code.some((x: any) => x.command.toUpperCase() === 'READ SENSOR')) return false; // read blocks
		return true;
	});
	const fixedMs = durationMs(motion.map((s) => (s.command.toUpperCase() === 'SINUSOIDAL OSCILLATE' ? { ...s, params: { ...s.params, cycles: 0 } } : s)));
	const oscMs = durationMs(motion) - fixedMs;
	const k = Math.max(0.01, (SONIC_TARGET_S * 1000 - fixedMs) / oscMs);
	const sonicCode = motion.map((s) =>
		s.command.toUpperCase() === 'SINUSOIDAL OSCILLATE'
			? { ...s, params: { ...s.params, cycles: Math.max(1, Math.round(+s.params.cycles * k)) } }
			: JSON.parse(JSON.stringify(s))
	);

	const allDefs = [
		{ name: 'Gen 5 Optical Photobleach - 10x Coarse Scans', code: photobleachCode, base: optical,
		  description: `Photobleach test: ${SWEEPS} coarse sweeps (${POSITIONS} positions, ${STEP_UM} µm apart, same 4.1 mm as the 42-position scan) with 30 s pauses; each sweep = one point per channel. Based on A9EB41AD.` },
		{ name: 'Gen 5 Optical Blank Cartridge', code: blankCode, base: optical,
		  description: 'Blank-cartridge noise study: the Gen 5 optical scan verbatim, under its own id so blank runs never mix with validation runs. Triggered by a BLANK- barcode (firmware v95); results reach BIMS over a webhook.' },
		{ name: 'Sonic Fingerprint - Cortisol 5.6 Moves', code: sonicCode, base: cortisol,
		  description: `Sonic fingerprint: the motion of A67AC662 (no wax wait, no sensor reads), every oscillation's cycles × ${k.toFixed(3)} to run ≈ ${SONIC_TARGET_S / 60} min. Triggered by a SONIC- barcode (firmware v95); the recording is uploaded by hand.` }
	];
	const defs = SKIP_SONIC ? allDefs.filter((d) => !d.name.startsWith('Sonic')) : allDefs;

	for (const d of defs) {
		const dup = await assays.findOne({ name: d.name });
		if (dup) throw new Error(`"${d.name}" already exists as ${dup._id}`);
	}
	for (const d of defs) {
		const ms = durationMs(d.code), real = durationMs(d.code, true);
		console.log(`\n===== ${d.name}\n  steps (top level): ${d.code.length} | Lambda-model duration ${(ms / 1000 / 60).toFixed(1)} min | with realistic 0.5 s reads ${(real / 1000 / 60).toFixed(1)} min`);
		if (d.code.length <= 60) print(d.code); else { print(d.code.slice(0, 8)); console.log('  …'); print(d.code.slice(-4)); }
	}
	const reads = (code: any[]): number => code.reduce((n, s) => n + (s.command.toUpperCase() === 'REPEAT' ? reads(s.code) * +s.count : s.command.toUpperCase() === 'READ SENSOR' ? 3 : 0), 0);
	console.log(`\nphotobleach readings: ${reads(photobleachCode)} (firmware cap 300) | sonic cycle factor k = ${k.toFixed(3)} | sonic fixed motion ${(fixedMs / 1000).toFixed(0)} s`);

	if (!APPLY) { console.log('\nDry run — re-run with --apply to insert.'); await mongoose.disconnect(); return; }

	const now = new Date();
	for (const d of defs) {
		const _id = newId(existing); existing.add(_id);
		const doc: any = {
			...JSON.parse(JSON.stringify(d.base)),
			_id,
			name: d.name,
			description: d.description,
			duration: Math.round(durationMs(d.code, true) / 1000),
			BCODE: { deviceParams: d.base.BCODE.deviceParams ?? {}, code: d.code },
			versionHistory: [],
			corrections: [],
			createdAt: now,
			updatedAt: now
		};
		delete doc.__v; delete doc.lockedAt; delete doc.lockedBy;
		await assays.insertOne(doc);
		console.log(`inserted ${_id}  ${d.name}`);
	}
	await mongoose.disconnect();
}

main().catch((e) => { console.error(e); process.exit(1); });
