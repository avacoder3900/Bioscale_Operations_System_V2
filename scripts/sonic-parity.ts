/**
 * VALIDATION-08 parity check: run the BIMS sonic engine on local recordings and
 * print the numbers the prototype (spu_audio.py) reports, to compare by eye.
 *
 *   npx tsx scripts/sonic-parity.ts <file> <file> [...] [--sections "110-130"]
 *
 * No database, no R2 — files come straight from disk.
 */
import { readFileSync } from 'node:fs';
import { basename } from 'node:path';
import { decodeRecording } from '../src/lib/server/sonic/decode';
import { fingerprint } from '../src/lib/server/sonic/features';
import { compareFingerprints } from '../src/lib/server/sonic/compare';

const args = process.argv.slice(2);
const si = args.indexOf('--sections');
const sections = si >= 0 ? args.splice(si, 2)[1] : null;

function label(file: string): string {
	const stem = basename(file).replace(/\.[^.]+$/, '');
	const m = stem.match(/spu[\s_-]*(\d+)/i) ?? stem.match(/^(\d{2,4})\b/);
	return m ? `SPU ${m[1]}` : stem;
}

const items = [];
for (const file of args) {
	const t0 = Date.now();
	const { samples, decoder, sourceRate } = await decodeRecording(new Uint8Array(readFileSync(file)), file);
	const t1 = Date.now();
	const fp = fingerprint(samples);
	const t2 = Date.now();
	console.log(
		`${label(file).padEnd(9)} ${decoder} ${sourceRate}Hz ${fp.durationS.toFixed(1)}s  rms ${fp.summary.rmsDb} dBFS  ` +
			`events ${fp.events.length}  tones ${fp.summary.tones.map((t) => t[0]).join(',')}  ` +
			`decode ${t1 - t0}ms fingerprint ${t2 - t1}ms  json ${(JSON.stringify(fp).length / 1024).toFixed(0)}KB`
	);
	items.push({ id: file, label: label(file), fp });
}

const c = compareFingerprints(items, { sections });
console.log(`\nmode ${c.mode} · window ${c.window[0].toFixed(1)}–${c.window[1].toFixed(1)}s`);
console.log('offsets: ' + items.map((it, i) => `${it.label} ${c.offsets[i] >= 0 ? '+' : ''}${c.offsets[i].toFixed(2)}s`).join(', '));
console.log('\nSPU       freqHz |Δf|Hz |Δf|%  |ΔdB| shape  peak@s        min@s');
c.sim.forEach((s, i) => {
	const f = (v: number | null, d = 1) => (v == null ? '  -' : v.toFixed(d));
	console.log(
		`${items[i].label.padEnd(9)} ${String(s.medianHz ?? '-').padStart(5)} ${f(s.avgAbsHz).padStart(6)} ${f(s.avgAbsPct).padStart(5)} ` +
			`${f(s.avgAbsLvl).padStart(5)} ${f(s.avgShape).padStart(5)}  ${s.peakDb.toFixed(1)}@${s.peakT.toFixed(1)}  ${s.minDb.toFixed(1)}@${s.minT.toFixed(1)}`
	);
});
console.log('\nsections: ' + c.sections.map((s) => `${s.name}=${s.a.toFixed(0)}-${s.b.toFixed(0)}`).join(' '));
c.scores.forEach((row, i) => {
	const marks = row.map((s) => (s == null ? '  -' : s.pass ? '  ✓' : '  x')).join('');
	const passed = row.filter((s) => s?.pass).length;
	console.log(`${items[i].label.padEnd(9)}${marks}   ${passed}/${row.length}`);
});
console.log('\ntones above the others: ' + c.tones.map((t, i) => `${items[i].label}: ${t.map((x) => `${x[0]}Hz+${x[1]}`).join(' ') || '—'}`).join(' | '));
