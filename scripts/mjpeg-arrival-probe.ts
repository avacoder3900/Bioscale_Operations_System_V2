/**
 * Live-view lag probe: stream a CV station's /preview.mjpg from this machine
 * and log how each JPEG frame actually ARRIVES — wall-clock gap since the
 * previous frame, frame size, and how far behind a 1/fps cadence we are.
 *
 * Why: the agent pushes a frame every 1/fps s and never drops one, so any
 * slowdown between the Pi and the viewer shows up as a freeze followed by a
 * fast-forward burst. This tells you WHERE the backlog forms:
 *   - gaps of hundreds of ms followed by a flurry of frames a few ms apart
 *     = the network path (Wi-Fi / Tailscale / the Pi's serve proxy) stalled
 *       and then flushed its buffer;
 *   - steady ~66 ms gaps here while the tablet still freezes/bursts
 *     = the tablet's browser is the bottleneck (decode/paint), not the path.
 * Watch the "size" column while you wave a hand: bigger frames per second
 * than the link carries is the usual trigger.
 *
 * Needs MONGODB_URI (from .env) to mint the station JWT, and this machine on
 * the tailnet so https://<station>.ts.net resolves.
 *
 * Run:
 *   npx tsx scripts/mjpeg-arrival-probe.ts "CV Station 1"
 *   npx tsx scripts/mjpeg-arrival-probe.ts <station id | hostname> [--fps 15] [--q 80] [--seconds 60]
 */
import mongoose from 'mongoose';
import jwt from 'jsonwebtoken';
import * as dotenv from 'dotenv';
dotenv.config();

const argv = process.argv.slice(2);
const who = argv.find((a) => !a.startsWith('--'));
const opt = (name: string, dflt: number) => {
	const i = argv.indexOf(`--${name}`);
	return i >= 0 && argv[i + 1] ? Number(argv[i + 1]) : dflt;
};
const FPS = opt('fps', 15);
const Q = opt('q', 80);
const SECONDS = opt('seconds', 60);

if (!who) {
	console.error('usage: npx tsx scripts/mjpeg-arrival-probe.ts <station name|id|hostname> [--fps N] [--q N] [--seconds N]');
	process.exit(2);
}

const fmt = (n: number, w = 6) => n.toFixed(0).padStart(w);

async function main() {
	await mongoose.connect(process.env.MONGODB_URI!);
	const col = mongoose.connection.db!.collection('capture_stations');
	const station = (await col.findOne({
		$or: [{ _id: who as any }, { name: who }, { hostname: who }]
	})) as { _id: string; name: string; hostname: string; jwtSecret?: string } | null;
	await mongoose.disconnect();
	if (!station) throw new Error(`no capture station matching "${who}"`);
	if (!station.jwtSecret) throw new Error(`${station.name} has no jwtSecret — re-register the Pi`);

	const token = jwt.sign(
		{ stationId: station._id, operatorId: 'probe', operatorUsername: 'mjpeg-arrival-probe' },
		station.jwtSecret,
		{ algorithm: 'HS256', expiresIn: '5m' }
	);
	const url = `https://${station.hostname}/preview.mjpg?token=${encodeURIComponent(token)}&fps=${FPS}&q=${Q}`;
	console.log(`station ${station.name} (${station.hostname})  fps=${FPS} q=${Q}  for ${SECONDS}s`);
	console.log('expected cadence %d ms/frame\n', Math.round(1000 / FPS));

	const ctrl = new AbortController();
	const stopAt = setTimeout(() => ctrl.abort(), SECONDS * 1000);
	const t0 = performance.now();
	const res = await fetch(url, { signal: ctrl.signal });
	if (!res.ok || !res.body) throw new Error(`HTTP ${res.status} ${res.statusText}`);
	console.log(`connected after ${fmt(performance.now() - t0, 1)} ms, content-type ${res.headers.get('content-type')}`);
	console.log('   frame      t(ms)   gap(ms)  size(KB)  behind(ms)  note');

	let buf = Buffer.alloc(0);
	let n = 0;
	let lastAt = 0;
	let firstAt = 0;
	const gaps: number[] = [];
	const sizes: number[] = [];
	let bytes = 0;

	const onFrame = (size: number) => {
		const now = performance.now();
		n++;
		if (n === 1) firstAt = now;
		const gap = lastAt ? now - lastAt : 0;
		lastAt = now;
		// Where this frame "should" have arrived if the Pi sent one every 1/fps s
		// from the first one; growing = backlog forming, shrinking fast = burst.
		const behind = n === 1 ? 0 : now - firstAt - ((n - 1) * 1000) / FPS;
		bytes += size;
		if (n > 1) { gaps.push(gap); sizes.push(size); }
		const note = gap > 2.5 * (1000 / FPS) ? 'STALL' : n > 1 && gap < 0.25 * (1000 / FPS) ? 'burst' : '';
		console.log(`${fmt(n, 8)} ${fmt(now - t0, 10)} ${fmt(gap, 9)} ${(size / 1024).toFixed(1).padStart(9)} ${fmt(behind, 11)}  ${note}`);
	};

	try {
		for await (const chunk of res.body as any as AsyncIterable<Uint8Array>) {
			buf = Buffer.concat([buf, Buffer.from(chunk)]);
			// Parse as many complete parts as the buffer holds.
			for (;;) {
				const hdrEnd = buf.indexOf('\r\n\r\n');
				if (hdrEnd < 0) break;
				const header = buf.subarray(0, hdrEnd).toString('latin1');
				const m = /Content-Length:\s*(\d+)/i.exec(header);
				if (!m) { buf = buf.subarray(hdrEnd + 4); continue; }
				const len = Number(m[1]);
				const end = hdrEnd + 4 + len;
				if (buf.length < end) break;
				onFrame(len);
				buf = buf.subarray(end);
			}
		}
	} catch (e) {
		if ((e as Error).name !== 'AbortError') throw e;
	} finally {
		clearTimeout(stopAt);
	}

	const elapsed = (lastAt - firstAt) / 1000;
	const sorted = [...gaps].sort((a, b) => a - b);
	const pct = (p: number) => sorted.length ? sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))] : 0;
	console.log('\nsummary');
	console.log(`  frames ${n}  over ${elapsed.toFixed(1)} s  = ${(n / Math.max(elapsed, 0.001)).toFixed(1)} fps delivered`);
	console.log(`  gap ms  p50 ${fmt(pct(0.5), 1)}  p95 ${fmt(pct(0.95), 1)}  max ${fmt(sorted.at(-1) ?? 0, 1)}  stalls(>${Math.round(2.5 * 1000 / FPS)}ms) ${gaps.filter((g) => g > 2.5 * 1000 / FPS).length}`);
	console.log(`  frame KB  mean ${(bytes / Math.max(n, 1) / 1024).toFixed(1)}  max ${(Math.max(0, ...sizes) / 1024).toFixed(1)}  -> ${(bytes * 8 / Math.max(elapsed, 0.001) / 1e6).toFixed(1)} Mbit/s delivered`);
}

main().catch((e) => { console.error(e); process.exit(1); });
