/**
 * Read-only dry run of the SONIC workflow engine on one stored recording:
 * download → decode → fingerprint → fine spectrogram → suggested window →
 * 48-step alignment → anomalies. Prints a summary; writes nothing.
 *   npx tsx scripts/sonic-dryrun.ts <sessionId>
 */
import mongoose from 'mongoose';
import * as dotenv from 'dotenv';
import { decodeRecording } from '../src/lib/server/sonic/decode';
import { fingerprint } from '../src/lib/server/sonic/features';
import { computeSpectrogram, encodeSpectrogram } from '../src/lib/server/sonic/spectrogram';
import { buildTimeline, SONIC_ASSAY_ID } from '../src/lib/server/sonic/timeline';
import { analyzeWindow, suggestWindow } from '../src/lib/server/sonic/window';
dotenv.config();
const WORKER = process.env.R2_WORKER_URL || 'https://brevitest-r2-upload.alejandrov.workers.dev';
async function main() {
	const id = process.argv[2];
	await mongoose.connect(process.env.MONGODB_URI!);
	const db = mongoose.connection.db!;
	const s: any = await db.collection('validation_sessions').findOne({ _id: id as any, type: 'sonic' });
	if (!s) throw new Error('session not found');
	const raw = s.results[0].rawData;
	let t = Date.now();
	const res = await fetch(`${WORKER}/file/${encodeURIComponent(raw.r2Key)}`);
	if (!res.ok) throw new Error(`download HTTP ${res.status}`);
	const bytes = new Uint8Array(await res.arrayBuffer());
	console.log(`download ${(bytes.length / 1048576).toFixed(2)} MB in ${Date.now() - t} ms`);
	t = Date.now();
	const dec = await decodeRecording(bytes, raw.fileName);
	console.log(`decode ${dec.decoder} ${dec.sourceRate} Hz ${dec.channels} ch → ${(dec.samples.length / 48000).toFixed(1)} s in ${Date.now() - t} ms`);
	t = Date.now();
	const fp = fingerprint(dec.samples);
	console.log(`fingerprint in ${Date.now() - t} ms: ${fp.events.length} events, first at ${fp.events[0]?.[0]} s, RMS ${fp.summary.rmsDb} dBFS, tones ${fp.summary.tones.map((x) => x[0]).join(',')} Hz`);
	t = Date.now();
	const sp = computeSpectrogram(dec.samples);
	console.log(`spectrogram ${sp.frames}×${sp.bands} in ${Date.now() - t} ms, stored size ${(encodeSpectrogram(sp).length / 1024).toFixed(0)} KB`);
	const a: any = await db.collection('assay_definitions').findOne({ _id: SONIC_ASSAY_ID as any });
	const tl = buildTimeline(a.BCODE.code);
	const firstMove = tl.steps.find((x) => x.kind !== 'start' && x.moving)!.t0;
	const w = suggestWindow(fp.events, fp.durationS, tl.totalS, firstMove, 1, 1);
	console.log(`plan ${tl.steps.length} steps, ${tl.totalS.toFixed(1)} s; first move at plan ${firstMove.toFixed(1)} s; suggested window ${w.startS}–${w.endS} s`);
	t = Date.now();
	const wa = analyzeWindow(sp, tl, w.startS, w.endS, []);
	console.log(`window analysis in ${Date.now() - t} ms: offset ${wa.alignment.offsetS} s, scale ${wa.alignment.scale}, r = ${wa.alignment.corr} (${wa.alignment.quality})`);
	console.log(`anomalies ${wa.summary.total}`, JSON.stringify(wa.summary.bySeverity), JSON.stringify(wa.summary.byKind), 'steps', wa.summary.stepsWithAnomalies.join(','));
	for (const x of wa.anomalies.slice(0, 12)) console.log(`  ${x.id} ${x.kind.padEnd(10)} t=${x.t}s step ${x.step} ${x.fLo}-${x.fHi} Hz Δ${x.deltaDb} dB z${x.z} ${x.severity}`);
	console.log('step starts:', wa.steps.map((x) => `${x.index}:${x.t0}`).join(' '));
	await mongoose.disconnect();
}
main().catch((e) => { console.error(e); process.exit(1); });
