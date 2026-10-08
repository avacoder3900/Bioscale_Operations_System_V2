/**
 * OT-2 simulator daemon (ROBOT-OVERHAUL test rig, 2026-10-08) — REMOVE BEFORE
 * FINAL SHIP.
 *
 * Impersonates N robots AND their bridge daemons so the Robots page can be
 * driven end to end without a real OT-2 moving:
 *
 *   • BIMS queue line (Vercel previews, production): for each sim robot this
 *     long-polls POST /api/agent/ot2/poll as its bridge device
 *     (ot2-s0N-bridge), executes http / upload_protocol / sweep / deck_scan /
 *     tip_swap_request / restart_robot_server / auto_resume_run commands
 *     against the in-memory FakeOt2, and posts a heartbeat every 10 s so the
 *     board shows Ready / Running.
 *   • Direct line (local `npm run dev`, where the server calls robots over
 *     HTTP): the same FakeOt2 is served at http://127.0.0.1:<port> — the port
 *     the seed wrote on the robot record (31950 + N).
 *
 * Sweeps answer with the seed's SIM-W-… (backing) or SIM-R-… (wax_filled)
 * cartridge barcodes, chosen by which process has a run open on that robot;
 * the deck scan answers SIM-DECK-001. Analyses echo the live Mongo labware
 * definitions, so the run-start freshness gate passes without a re-upload
 * (and a re-upload works too: the bundled defs are parsed and echoed back).
 *
 *   BIMS_BASE_URL=https://…vercel.app AGENT_API_KEY=… MONGODB_URI=… \
 *     npx tsx scripts/ot2-sim/daemon.ts [--robots 3] [--run-seconds 60]
 *   npx tsx scripts/ot2-sim/daemon.ts --selftest        # no BIMS, no Mongo
 */
import http from 'node:http';
import mongoose from 'mongoose';
import { FakeOt2, type LabwareDef, waxWellsForCart } from './fake-ot2.ts';

const argv = process.argv.slice(2);
const flag = (name: string, dflt: string): string => {
	const i = argv.indexOf(`--${name}`);
	return i >= 0 && argv[i + 1] ? argv[i + 1] : dflt;
};
const ROBOTS = Math.max(1, Math.min(9, Number(flag('robots', process.env.SIM_ROBOTS ?? '3')) || 3));
const RUN_SECONDS = Math.max(5, Number(flag('run-seconds', process.env.SIM_RUN_SECONDS ?? '60')) || 60);
const SELFTEST = argv.includes('--selftest');
const BIMS = (process.env.BIMS_BASE_URL ?? '').replace(/\/+$/, '');
const KEY = process.env.AGENT_API_KEY ?? '';
const MONGO = process.env.MONGODB_URI ?? '';
const BASE_PORT = Number(process.env.SIM_BASE_PORT ?? 31950);
const DECK_BARCODE = process.env.SIM_DECK_BARCODE ?? 'SIM-DECK-001';
const HEARTBEAT_MS = 10_000;

const log = (msg: string) => console.log(`${new Date().toISOString().slice(11, 19)} ${msg}`);

export const simRobot = (n: number) => ({
	id: `sim-robot-s0${n}`,
	name: `SIM Robot S0${n}`,
	deviceId: `ot2-s0${n}-bridge`,
	port: BASE_PORT + n,
	waxProtocolId: `sim-proto-wax-s0${n}`,
	reagentProtocolId: `sim-proto-reagent-s0${n}`
});

// ── Mongo helpers (optional: without MONGODB_URI the sim still answers) ──────
let mongoReady = false;
let labwareCache: { at: number; defs: LabwareDef[] } = { at: 0, defs: [] };

async function connectMongo() {
	if (!MONGO) return;
	await mongoose.connect(MONGO);
	mongoReady = true;
	log(`mongo connected (${mongoose.connection.name})`);
}

/** Every BIMS-managed labware definition's wells — what the freshness gate expects. */
async function liveLabware(): Promise<LabwareDef[]> {
	if (!mongoReady) return [];
	if (Date.now() - labwareCache.at < 30_000) return labwareCache.defs;
	const docs = await mongoose.connection.collection<any>('labware_definitions').find({}, { projection: { loadName: 1, definition: 1 } }).toArray();
	const defs: LabwareDef[] = [];
	for (const d of docs) {
		const wells: LabwareDef['wells'] = {};
		for (const [wn, w] of Object.entries((d.definition?.wells ?? {}) as Record<string, any>)) wells[wn] = { x: w?.x, y: w?.y, z: w?.z };
		if (d.loadName) defs.push({ loadName: String(d.loadName), wells });
	}
	labwareCache = { at: Date.now(), defs };
	return defs;
}

const WAX_PAGE_OWNED = ['Setup', 'Loading', 'Running', 'Awaiting Removal', 'setup', 'loading', 'running', 'awaiting_removal', 'cooling'];

/** Which fill the robot is doing right now, by the BIMS run record that owns it. */
async function processFor(robotId: string): Promise<'wax' | 'reagent'> {
	if (!mongoReady) return 'wax';
	const wax = await mongoose.connection.collection<any>('wax_filling_runs').findOne({ 'robot._id': robotId, status: { $in: WAX_PAGE_OWNED } }, { projection: { _id: 1 } });
	return wax ? 'wax' : 'reagent';
}

const handedOut = new Set<string>();
/** Barcodes a sweep "reads": unconsumed sim carts of the right stage, in order. */
async function cartBarcodes(process: 'wax' | 'reagent', count: number): Promise<string[]> {
	const prefix = process === 'wax' ? 'SIM-W-' : 'SIM-R-';
	const status = process === 'wax' ? 'backing' : 'wax_filled';
	if (!mongoReady) return Array.from({ length: count }, (_, i) => `${prefix}${String(i + 1).padStart(4, '0')}`);
	const docs = await mongoose.connection
		.collection<any>('cartridge_records')
		.find({ _id: { $regex: `^${prefix}` }, status }, { projection: { _id: 1 } })
		.sort({ _id: 1 })
		.limit(count + handedOut.size)
		.toArray();
	const out: string[] = [];
	for (const d of docs) {
		const id = String(d._id);
		if (handedOut.has(id)) continue;
		out.push(id);
		handedOut.add(id);
		if (out.length >= count) break;
	}
	return out;
}

// ── BIMS agent API ──────────────────────────────────────────────────────────
async function bims(path: string, body: unknown): Promise<any> {
	const res = await fetch(`${BIMS}${path}`, {
		method: 'POST',
		headers: { 'content-type': 'application/json', 'x-agent-api-key': KEY },
		body: JSON.stringify(body)
	});
	const text = await res.text();
	let json: any = null;
	try {
		json = text ? JSON.parse(text) : null;
	} catch {
		json = { raw: text };
	}
	if (!res.ok) throw new Error(`${path} → ${res.status} ${JSON.stringify(json).slice(0, 200)}`);
	return json;
}

// ── multipart parsing for the direct line's POST /protocols ─────────────────
function parseMultipart(buf: Buffer, contentType: string): { fileName: string; labware: LabwareDef[] } {
	const m = /boundary=("?)([^";]+)\1/i.exec(contentType);
	const out = { fileName: 'protocol.py', labware: [] as LabwareDef[] };
	if (!m) return out;
	const boundary = `--${m[2]}`;
	for (const part of buf.toString('latin1').split(boundary)) {
		const hdrEnd = part.indexOf('\r\n\r\n');
		if (hdrEnd < 0) continue;
		const headers = part.slice(0, hdrEnd);
		const fn = /filename="([^"]*)"/i.exec(headers)?.[1];
		if (!fn) continue;
		const content = Buffer.from(part.slice(hdrEnd + 4).replace(/\r\n$/, ''), 'latin1').toString('utf8');
		if (/\.py$/i.test(fn)) out.fileName = fn;
		else if (/\.json$/i.test(fn)) {
			try {
				const def = JSON.parse(content);
				const loadName = def?.parameters?.loadName;
				if (loadName) out.labware.push({ loadName, wells: slimWells(def.wells) });
			} catch {
				/* not a labware def */
			}
		}
	}
	return out;
}
const slimWells = (wells: any): LabwareDef['wells'] => {
	const o: LabwareDef['wells'] = {};
	for (const [k, w] of Object.entries((wells ?? {}) as Record<string, any>)) o[k] = { x: w?.x, y: w?.y, z: w?.z };
	return o;
};
function labwareFromB64List(list: any[]): LabwareDef[] {
	const out: LabwareDef[] = [];
	for (const lw of list ?? []) {
		try {
			const def = JSON.parse(Buffer.from(String(lw?.b64 ?? ''), 'base64').toString('utf8'));
			if (def?.parameters?.loadName) out.push({ loadName: def.parameters.loadName, wells: slimWells(def.wells) });
		} catch {
			/* skip */
		}
	}
	return out;
}

// ── one simulated robot ─────────────────────────────────────────────────────
class SimRobot {
	readonly meta: ReturnType<typeof simRobot>;
	readonly ot2: FakeOt2;
	private server: http.Server | null = null;
	private stopped = false;

	constructor(n: number) {
		this.meta = simRobot(n);
		this.ot2 = new FakeOt2({
			name: this.meta.name,
			runSeconds: RUN_SECONDS,
			defaultLabware: () => labwareCache.defs,
			protocols: [
				{ id: this.meta.waxProtocolId, fileName: 'Wax_Filling_SIM.py' },
				{ id: this.meta.reagentProtocolId, fileName: 'Reagent_Filling_SIM.py' }
			],
			log
		});
	}

	/** Direct line: the robot's HTTP API on 127.0.0.1:<port>. */
	listen() {
		this.server = http.createServer(async (req, res) => {
			const chunks: Buffer[] = [];
			for await (const c of req) chunks.push(c as Buffer);
			const raw = Buffer.concat(chunks);
			const ct = String(req.headers['content-type'] ?? '');
			let body: any = null;
			if (ct.includes('multipart/form-data')) body = parseMultipart(raw, ct);
			else if (raw.length) {
				try {
					body = JSON.parse(raw.toString('utf8'));
				} catch {
					body = null;
				}
			}
			const r = this.ot2.handle(req.method ?? 'GET', req.url ?? '/', body);
			res.writeHead(r.status, { 'content-type': 'application/json' });
			res.end(JSON.stringify(r.body));
		});
		this.server.listen(this.meta.port, '127.0.0.1', () => log(`${this.meta.name}: HTTP on http://127.0.0.1:${this.meta.port}`));
	}

	/** Queue line: heartbeat + command loop against BIMS. */
	async serveQueue() {
		void this.heartbeats();
		while (!this.stopped) {
			try {
				const r = await bims('/api/agent/ot2/poll', { deviceId: this.meta.deviceId, waitMs: 20_000 });
				const cmd = r?.command;
				if (cmd?._id) await this.execute(cmd);
			} catch (e) {
				log(`${this.meta.name}: poll error — ${(e as Error).message}`);
				await sleep(3000);
			}
		}
	}

	private async heartbeats() {
		while (!this.stopped) {
			try {
				this.ot2.tickAll();
				await bims('/api/agent/scanner/event', {
					deviceId: this.meta.deviceId,
					eventType: 'heartbeat',
					metadata: {
						health: this.ot2.handle('GET', '/health', null).body,
						engine: this.ot2.engineHealth(),
						version: 'ot2-sim 1.0 (scripts/ot2-sim) — not a real robot',
						serialOpen: true,
						serialPort: 'sim'
					}
				});
			} catch (e) {
				log(`${this.meta.name}: heartbeat error — ${(e as Error).message}`);
			}
			await sleep(HEARTBEAT_MS);
		}
	}

	private async result(id: string, payload: unknown) {
		try {
			await bims(`/api/agent/ot2/commands/${encodeURIComponent(id)}/result`, payload);
		} catch (e) {
			log(`${this.meta.name}: result post failed — ${(e as Error).message}`);
		}
	}
	private async progress(id: string, payload: unknown): Promise<{ pause: boolean; cancel: boolean }> {
		try {
			const r = await bims(`/api/agent/ot2/commands/${encodeURIComponent(id)}/progress`, payload);
			return { pause: !!r?.pauseRequested, cancel: !!r?.cancelRequested };
		} catch (e) {
			log(`${this.meta.name}: progress post failed — ${(e as Error).message}`);
			return { pause: false, cancel: false };
		}
	}

	private async execute(cmd: any) {
		const id = String(cmd._id);
		const kind = String(cmd.kind);
		log(`${this.meta.name}: ${kind} ${cmd.request ? `${cmd.request.method} ${cmd.request.path}` : ''}`);
		switch (kind) {
			case 'http': {
				const req = cmd.request ?? {};
				const r = this.ot2.handle(String(req.method ?? 'GET'), String(req.path ?? '/'), req.body ?? null);
				return this.result(id, { ok: true, status: r.status, body: r.body });
			}
			case 'upload_protocol': {
				const p = cmd.payload ?? {};
				const labware = labwareFromB64List(p.labware ?? []);
				const proto = this.ot2.registerUpload(String(p.fileName ?? 'protocol.py'), labware);
				const schema = /wax/i.test(proto.fileName) ? WAX_SCHEMA : REAGENT_SCHEMA;
				proto.runTimeParameters = schema;
				return this.result(id, {
					ok: true,
					status: 200,
					body: {
						opentronsProtocolId: proto.id,
						analysisStatus: 'completed',
						parametersSchema: schema,
						labwareDefinitions: labware.map((l) => ({ loadName: l.loadName })),
						pipettesRequired: [{ pipetteName: 'p20_single_gen2', mount: 'left' }]
					}
				});
			}
			case 'deck_scan': {
				this.ot2.busyWith = 'deck_scan';
				await sleep(1500);
				this.ot2.busyWith = null;
				return this.result(id, { ok: true, status: 200, body: { barcode: DECK_BARCODE, rawPayload: DECK_BARCODE } });
			}
			case 'sweep':
				return this.sweep(id, cmd.payload ?? {});
			case 'restart_robot_server': {
				this.ot2.reboot();
				await sleep(2000);
				return this.result(id, { ok: true, status: 200, body: { restarted: true } });
			}
			case 'tip_swap_request': {
				const p = cmd.payload ?? {};
				if (p.cancel) return this.result(id, { ok: true, status: 200, body: { cancelled: true } });
				return this.result(id, { ok: true, status: 200, body: { mode: p.mode === 'hand' ? 'hand' : 'rack', path: '/sim/tip_swap_request.json' } });
			}
			case 'auto_resume_run': {
				const rid = String(cmd.payload?.runId ?? '');
				const r = this.ot2.handle('POST', `/runs/${rid}/actions`, { data: { actionType: 'play' } });
				return this.result(id, { ok: r.status < 400, status: r.status, body: r.body, ...(r.status >= 400 ? { error: 'could not resume' } : {}) });
			}
			case 'calibrate_tip':
				return this.result(id, { ok: true, status: 200, body: { probed: true, zAdjustMm: 0.0, note: 'sim: no probe' } });
			default:
				return this.result(id, { ok: false, error: `sim: unknown command kind ${kind}` });
		}
	}

	private async sweep(id: string, payload: any) {
		const positions: any[] = [...(payload.positions ?? [])].sort((a, b) => (a.slotIndex ?? 0) - (b.slotIndex ?? 0));
		const sweepRunId = String(payload.sweepRunId ?? '');
		const process = await processFor(this.meta.id);
		const barcodes = await cartBarcodes(process, positions.length);
		log(`${this.meta.name}: sweep ${positions.length} slots as ${process} (${barcodes.length} carts available)`);
		this.ot2.busyWith = 'sweep';
		let done = 0;
		let scans = 0;
		let errors = 0;
		let final: { status: string; abortReason?: string } = { status: 'completed' };
		let paused = false;
		for (let i = 0; i < positions.length; i++) {
			const pos = positions[i];
			const slotIndex = Number(pos.slotIndex ?? i);
			await sleep(400);
			const barcode = barcodes[i];
			done += 1;
			let ctl: { pause: boolean; cancel: boolean };
			if (barcode) {
				scans += 1;
				ctl = await this.progress(id, { sweepRunId, slotsDone: done, currentSlotIndex: slotIndex, scan: { slotIndex, barcode, rawPayload: barcode, x: pos.x, y: pos.y, z: pos.z, attempts: 1 } });
			} else {
				errors += 1;
				ctl = await this.progress(id, { sweepRunId, slotsDone: done, currentSlotIndex: slotIndex, slotError: { slotIndex, message: 'sim: no cartridge left to hand out (after 1 attempts)', attempts: 1 } });
			}
			if (ctl.cancel) {
				final = { status: 'cancelled', abortReason: 'cancelled by operator' };
				break;
			}
			while (ctl.pause && !ctl.cancel) {
				if (!paused) log(`${this.meta.name}: sweep paused`);
				paused = true;
				await sleep(1000);
				ctl = await this.progress(id, { sweepRunId, slotsDone: done, currentSlotIndex: slotIndex });
			}
			if (ctl.cancel) {
				final = { status: 'cancelled', abortReason: 'cancelled by operator' };
				break;
			}
		}
		this.ot2.busyWith = null;
		await this.progress(id, { sweepRunId, slotsDone: done, final, log: [{ level: final.status === 'completed' ? 'info' : 'warn', message: `Sweep ${final.status}. ${scans} scan(s), ${errors} error(s). (sim)` }] });
		await this.result(id, { ok: true, status: 200, body: { slotsDone: done, scanCount: scans, errorCount: errors, status: final.status } });
	}

	stop() {
		this.stopped = true;
		this.server?.close();
	}
}

/** The RTP schemas the seed also writes on the robot doc (keep in sync). */
export const WAX_SCHEMA = [
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
export const REAGENT_SCHEMA = [
	{ variableName: 'cartridges', displayName: 'Cartridges', description: 'How many deck positions to fill (1-24)', type: 'int', default: 24, min: 1, max: 24 },
	{ variableName: 'well_2', displayName: 'Fill well 2 (beads)', type: 'bool', default: true },
	{ variableName: 'well_3', displayName: 'Fill well 3 (tracer)', type: 'bool', default: true },
	{ variableName: 'well_4', displayName: 'Fill well 4 (wash)', type: 'bool', default: true },
	{ variableName: 'well_5', displayName: 'Fill well 5 (elution)', type: 'bool', default: true },
	{ variableName: 'use_tip_calibration', displayName: 'Use tip calibration', type: 'bool', default: false },
	{ variableName: 'tiprack_refilled', displayName: 'Tip rack refilled', type: 'bool', default: false }
];

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// ── self-test: exercise the fake robot the way BIMS does, no network ────────
async function selftest() {
	const fake = new FakeOt2({ name: 'SIM selftest', runSeconds: 1, defaultLabware: () => [{ loadName: 'sim_deck', wells: { A1: { x: 1, y: 2, z: 3 } } }], protocols: [{ id: 'p-wax', fileName: 'Wax_Filling_SIM.py' }], log });
	const assert = (cond: unknown, what: string) => {
		if (!cond) throw new Error(`selftest failed: ${what}`);
		log(`ok — ${what}`);
	};
	assert(fake.handle('GET', '/health', null).status === 200, 'GET /health');
	assert((fake.handle('GET', '/maintenance_runs/current', null)).status === 404, 'no maintenance run → 404');
	const an = fake.handle('GET', '/protocols/p-wax/analyses', null);
	assert(an.status === 200 && (an.body as any).data[0].status === 'completed', 'analyses list completed');
	const det = fake.handle('GET', '/protocols/p-wax/analyses/p-wax-analysis', null);
	const ll = (det.body as any).data.commands.find((c: any) => c.commandType === 'loadLabware');
	assert(ll?.result?.definition?.wells?.A1?.z === 3, 'analysis echoes live labware wells');
	const created = fake.handle('POST', '/runs', { data: { protocolId: 'p-wax', runTimeParameterValues: { cartridges: 3 } } });
	const rid = (created.body as any).data.id;
	assert(created.status === 201 && rid, 'POST /runs creates');
	assert((fake.handle('GET', '/runs', null).body as any).links.current.href === `/runs/${rid}`, 'links.current points at the run');
	assert(fake.handle('POST', `/runs/${rid}/actions`, { data: { actionType: 'play' } }).status === 201, 'play');
	assert((fake.handle('GET', `/runs/${rid}`, null).body as any).data.status === 'running', 'running');
	await sleep(1300);
	assert((fake.handle('GET', `/runs/${rid}`, null).body as any).data.status === 'succeeded', 'succeeded after runSeconds');
	const cmds = (fake.handle('GET', `/runs/${rid}/commands?cursor=0&pageLength=10000`, null).body as any).data as any[];
	const wells = new Set(cmds.filter((c) => c.commandType === 'comment').map((c) => /Dispensed [\d.]+uL into well ([A-X]\d+)/.exec(c.params.message)?.[1]).filter(Boolean));
	assert(wells.size === 3 * 12, `3 carts × 12 wax wells dispensed (${wells.size})`);
	assert(waxWellsForCart(1)[0] === 'X2' && waxWellsForCart(9)[0] === 'X10' && waxWellsForCart(24)[11] === 'A24', 'well mapping matches cartsFilledFromWells');
	assert(cmds.some((c) => /TIP TRACKER:.*\(index \d+\)/.test(c.params?.message ?? '')), 'tip tracker comment present');
	assert(fake.handle('POST', `/runs/${rid}/actions`, { data: { actionType: 'play' } }).status === 409, 'play on a terminal run → 409');
	const ct = 'multipart/form-data; boundary=XX';
	const def = JSON.stringify({ parameters: { loadName: 'sim_deck' }, wells: { A1: { x: 9, y: 9, z: 9 } } });
	const multipart = Buffer.from(`--XX\r\nContent-Disposition: form-data; name="files"; filename="wax.py"\r\n\r\nprint(1)\r\n--XX\r\nContent-Disposition: form-data; name="files"; filename="sim_deck.json"\r\n\r\n${def}\r\n--XX--\r\n`);
	const parsed = parseMultipart(multipart, ct);
	assert(parsed.fileName === 'wax.py' && parsed.labware[0]?.wells.A1?.z === 9, 'multipart upload parsed');
	const up = fake.handle('POST', '/protocols', parsed);
	const pid = (up.body as any).data.id;
	const det2 = fake.handle('GET', `/protocols/${pid}/analyses/x`, null);
	assert((det2.body as any).data.commands[0].result.definition.wells.A1.z === 9, 'uploaded bundle echoed by its analysis');
	log('selftest passed');
}

async function main() {
	if (SELFTEST) {
		await selftest();
		return;
	}
	if (!BIMS || !KEY) {
		console.error('Set BIMS_BASE_URL and AGENT_API_KEY (and MONGODB_URI so sweeps hand out seeded carts and analyses echo live labware).');
		process.exit(1);
	}
	await connectMongo();
	await liveLabware();
	setInterval(() => void liveLabware().catch(() => {}), 30_000).unref();
	const robots = Array.from({ length: ROBOTS }, (_, i) => new SimRobot(i + 1));
	for (const r of robots) r.listen();
	log(`simulating ${ROBOTS} robot(s) against ${BIMS}; runs take ${RUN_SECONDS}s. Ctrl-C to stop.`);
	process.on('SIGINT', () => {
		for (const r of robots) r.stop();
		void mongoose.disconnect().finally(() => process.exit(0));
	});
	await Promise.all(robots.map((r) => r.serveQueue()));
}

main().catch((e) => {
	console.error(e);
	process.exit(1);
});
