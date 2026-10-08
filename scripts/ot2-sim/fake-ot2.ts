/**
 * Fake OT-2 (ROBOT-OVERHAUL test rig, 2026-10-08) — REMOVE BEFORE FINAL SHIP.
 *
 * An in-memory stand-in for one robot's HTTP API, covering exactly the surface
 * the wax/reagent wizards touch (see $lib/opentrons/ot2-protocol runVerb and
 * the bridge daemon's engine_health):
 *
 *   GET  /health · /server/version · /pipettes · /instruments · /modules
 *   GET  /runs                      list + links.current
 *   POST /runs                      create (idle)
 *   GET  /runs/:id                  status, actions
 *   POST /runs/:id/actions          play | pause | stop
 *   DELETE /runs/:id
 *   GET  /runs/:id/commands         paged, the comments the finish parsers read
 *   GET  /protocols · /protocols/:id · /protocols/:id/analyses[/:aid]
 *   POST /protocols                 multipart upload (direct line) → new id
 *   GET  /maintenance_runs/current  404 when none · POST / DELETE maintenance runs
 *   POST /maintenance_runs/:id/commands   accepted, no motion
 *   GET/POST /robot/lights · POST /identify · POST /robot/home
 *
 * A played run "fills" over `runSeconds`: it emits pickUpTip commands and the
 * exact comment lines the real protocols log ("Dispensed 2.2uL into well X2",
 * "TIP TRACKER: … (index N)") so BIMS's finish step counts carts and tips the
 * way it does for a real run. Then it lands `succeeded`.
 *
 * No I/O here: daemon.ts wraps this in an HTTP server (local dev, where BIMS
 * calls robots directly) and in the BIMS command queue (Vercel previews).
 */

export type LabwareWells = Record<string, { x?: number; y?: number; z?: number }>;
export interface LabwareDef { loadName: string; wells: LabwareWells }

export interface FakeProtocol {
	id: string;
	fileName: string;
	createdAt: string;
	labware: LabwareDef[];
	runTimeParameters: unknown[];
}

export interface FakeCommand {
	id: string;
	commandType: string;
	status: 'succeeded';
	params: Record<string, unknown>;
	createdAt: string;
}

export interface FakeRun {
	id: string;
	protocolId: string;
	status: 'idle' | 'running' | 'paused' | 'succeeded' | 'stopped' | 'failed';
	createdAt: string;
	startedAt: string | null;
	completedAt: string | null;
	actions: { id: string; actionType: string; createdAt: string }[];
	runTimeParameterValues: Record<string, unknown>;
	commands: FakeCommand[];
	/** Planned command list for this run, revealed as time passes. */
	plan: FakeCommand[];
	/** ms of run time already elapsed when paused (play resumes from here). */
	elapsedMs: number;
	lastPlayAt: number | null;
}

export interface FakeOt2Options {
	name: string;
	/** How long a played run takes to finish. */
	runSeconds: number;
	/** Labware the "robot" resolves for any protocol it did not receive by upload. */
	defaultLabware: () => LabwareDef[];
	/** Pre-registered protocol ids (the seed's entries on the robot doc). */
	protocols?: { id: string; fileName: string; runTimeParameters?: unknown[] }[];
	now?: () => number;
	log?: (msg: string) => void;
}

export interface FakeResponse { status: number; body: unknown }

const ROWS = 'XWVUTSRQPONMLKJIHGFEDCBA';
let seq = 0;
export const fakeId = (prefix: string) => `${prefix}-${Date.now().toString(36)}-${(++seq).toString(36)}`;

/**
 * The wells the WAX protocol dispenses into for deck position `cart` (1..24):
 * the inverse of cartsFilledFromWells — carrier = floor((col-1)/8), band from
 * the row letter (X,W,V = band 0 … C,B,A = band 7), wax columns are the even
 * columns of the carrier.
 */
export function waxWellsForCart(cart: number, rowPatterns = [true, true, true]): string[] {
	const carrier = Math.floor((cart - 1) / 8);
	const band = (cart - 1) % 8;
	const out: string[] = [];
	for (let r = 0; r < 3; r++) {
		if (rowPatterns[r] === false) continue;
		const row = ROWS[band * 3 + r];
		for (const c of [2, 4, 6, 8]) out.push(`${row}${carrier * 8 + c}`);
	}
	return out;
}

export class FakeOt2 {
	readonly name: string;
	private readonly opts: FakeOt2Options;
	protocols = new Map<string, FakeProtocol>();
	runs = new Map<string, FakeRun>();
	runOrder: string[] = [];
	maintenanceRunId: string | null = null;
	lightsOn = false;
	/** Set by the daemon while a sweep / deck scan "holds the gantry". */
	busyWith: string | null = null;

	constructor(opts: FakeOt2Options) {
		this.opts = opts;
		this.name = opts.name;
		for (const p of opts.protocols ?? []) {
			this.protocols.set(p.id, {
				id: p.id,
				fileName: p.fileName,
				createdAt: new Date().toISOString(),
				labware: [],
				runTimeParameters: p.runTimeParameters ?? []
			});
		}
	}

	private now(): number {
		return this.opts.now ? this.opts.now() : Date.now();
	}
	private log(msg: string) {
		this.opts.log?.(`[${this.name}] ${msg}`);
	}
	private iso(): string {
		return new Date(this.now()).toISOString();
	}

	/** The newest run that has not been deleted — what the robot calls "current". */
	currentRun(): FakeRun | null {
		for (let i = this.runOrder.length - 1; i >= 0; i--) {
			const r = this.runs.get(this.runOrder[i]);
			if (r) return r;
		}
		return null;
	}

	/** Engine-health view the heartbeat reports (mirrors ot2-bridge.py engine_health). */
	engineHealth() {
		const cur = this.currentRun();
		return { engineOk: true, protocolRun: cur ? cur.status : null, maintenanceRun: this.maintenanceRunId ? 'open' : null };
	}

	/** Register an uploaded protocol (direct multipart or the queue's upload_protocol job). */
	registerUpload(fileName: string, labware: LabwareDef[], runTimeParameters: unknown[] = []): FakeProtocol {
		const id = fakeId('sim-proto');
		const p: FakeProtocol = { id, fileName, createdAt: this.iso(), labware, runTimeParameters };
		this.protocols.set(id, p);
		this.log(`protocol uploaded: ${fileName} → ${id} (${labware.length} labware defs)`);
		return p;
	}

	/** Reset to a freshly booted robot (restart_robot_server). */
	reboot() {
		this.runs.clear();
		this.runOrder = [];
		this.maintenanceRunId = null;
		this.busyWith = null;
		this.log('robot server restarted');
	}

	// ── run progression ──────────────────────────────────────────────────────

	private buildPlan(run: FakeRun): FakeCommand[] {
		const proto = this.protocols.get(run.protocolId);
		const isWax = /wax/i.test(proto?.fileName ?? '') || Object.keys(run.runTimeParameterValues).some((k) => /gate|row_pattern/.test(k));
		const rtp = run.runTimeParameterValues;
		const count = Math.max(1, Math.min(24, Number(rtp.cartridges ?? 24) || 24));
		const t = this.iso();
		const cmd = (commandType: string, params: Record<string, unknown> = {}): FakeCommand => ({
			id: fakeId('cmd'),
			commandType,
			status: 'succeeded',
			params,
			createdAt: t
		});
		const plan: FakeCommand[] = [cmd('home'), cmd('comment', { message: `SIM ${isWax ? 'wax' : 'reagent'} fill: ${count} cartridges` })];
		let tipIndex = Number(rtp.tiprack_refilled) ? 0 : 3;
		plan.push(cmd('comment', { message: `TIP TRACKER: starting from tip A${tipIndex + 1} (index ${tipIndex})` }));
		plan.push(cmd('pickUpTip', { pipetteId: 'sim-pipette', labwareId: 'sim-tiprack', wellName: `A${tipIndex + 1}` }));
		if (isWax) {
			const patterns = [rtp.row_pattern_0 !== false, rtp.row_pattern_1 !== false, rtp.row_pattern_2 !== false];
			for (let c = 1; c <= count; c++) {
				plan.push(cmd('aspirate', { pipetteId: 'sim-pipette', volume: 8.4 }));
				for (const well of waxWellsForCart(c, patterns)) {
					plan.push(cmd('dispense', { pipetteId: 'sim-pipette', wellName: well, volume: 2.2 }));
					plan.push(cmd('comment', { message: `Dispensed 2.2uL into well ${well}` }));
				}
			}
		} else {
			const wells = [2, 3, 4, 5].filter((w) => rtp[`well_${w}`] !== false);
			for (const w of wells) {
				plan.push(cmd('comment', { message: `Filling well ${w} on ${count} cartridges` }));
				for (let c = 1; c <= count; c++) {
					plan.push(cmd('aspirate', { pipetteId: 'sim-pipette', volume: 10 }));
					plan.push(cmd('dispense', { pipetteId: 'sim-pipette', cartridge: c, well: w, volume: 10 }));
				}
			}
		}
		tipIndex += 1;
		plan.push(cmd('comment', { message: `TIP TRACKER: consumed tip A${tipIndex} — next tip will be A${tipIndex + 1} (index ${tipIndex})` }));
		plan.push(cmd('dropTip', { pipetteId: 'sim-pipette' }));
		plan.push(cmd('home'));
		return plan;
	}

	/** Reveal the commands the elapsed run time has reached; land terminal when done. */
	tick(run: FakeRun) {
		if (run.status !== 'running' || run.lastPlayAt == null) return;
		const elapsed = run.elapsedMs + (this.now() - run.lastPlayAt);
		const total = Math.max(1, this.opts.runSeconds * 1000);
		const frac = Math.min(1, elapsed / total);
		const reveal = Math.floor(run.plan.length * frac);
		while (run.commands.length < reveal) run.commands.push(run.plan[run.commands.length]);
		if (frac >= 1) {
			run.commands = run.plan.slice();
			run.status = 'succeeded';
			run.completedAt = this.iso();
			run.lastPlayAt = null;
			run.elapsedMs = total;
			this.log(`run ${run.id} succeeded`);
		}
	}

	tickAll() {
		for (const r of this.runs.values()) this.tick(r);
	}

	// ── request handler ──────────────────────────────────────────────────────

	private runView(run: FakeRun) {
		return {
			id: run.id,
			protocolId: run.protocolId,
			status: run.status,
			current: this.currentRun()?.id === run.id,
			createdAt: run.createdAt,
			startedAt: run.startedAt,
			completedAt: run.completedAt,
			actions: run.actions,
			errors: [],
			pipettes: [{ id: 'sim-pipette', pipetteName: 'p20_single_gen2', mount: 'left' }],
			labware: [],
			modules: [],
			liquids: [],
			runTimeParameters: Object.entries(run.runTimeParameterValues).map(([variableName, value]) => ({ variableName, value })),
			labwareOffsets: []
		};
	}

	private analysisFor(p: FakeProtocol) {
		const labware = p.labware.length ? p.labware : this.opts.defaultLabware();
		return {
			id: `${p.id}-analysis`,
			status: 'completed',
			result: 'ok',
			errors: [],
			runTimeParameters: p.runTimeParameters,
			pipettes: [{ id: 'sim-pipette', pipetteName: 'p20_single_gen2', mount: 'left' }],
			labware: labware.map((l, i) => ({ id: `lw-${i}`, loadName: l.loadName, definitionUri: `sim/${l.loadName}/1`, location: { slotName: String(i + 1) } })),
			liquids: [],
			commands: labware.map((l, i) => ({
				id: `load-${i}`,
				commandType: 'loadLabware',
				status: 'succeeded',
				params: { loadName: l.loadName, namespace: 'sim', version: 1, location: { slotName: String(i + 1) } },
				result: { labwareId: `lw-${i}`, definition: { parameters: { loadName: l.loadName }, wells: l.wells } }
			}))
		};
	}

	/**
	 * Handle one robot-API request. `body` is the parsed JSON body (or, for a
	 * multipart /protocols upload, the labware defs the daemon already parsed).
	 */
	handle(method: string, rawPath: string, body: any): FakeResponse {
		this.tickAll();
		const url = new URL(rawPath, 'http://sim.invalid');
		const path = url.pathname.replace(/\/+$/, '') || '/';
		const m = method.toUpperCase();
		const seg = path.split('/').filter(Boolean);
		const t = this.iso();

		if (m === 'GET' && path === '/health') {
			return { status: 200, body: { name: this.name, api_version: '7.3.1', fw_version: 'sim', system_version: '7.3.1', robot_model: 'OT-2 Standard', logs: [], links: {} } };
		}
		if (m === 'GET' && path === '/server/version') return { status: 200, body: { version: '7.3.1', name: this.name } };
		if (m === 'GET' && path === '/pipettes') {
			return { status: 200, body: { left: { id: 'sim-pipette', name: 'p20_single_gen2', model: 'p20_single_v2.2', mount_axis: 'z', plunger_axis: 'b', tip_length: 0, has_tip: false }, right: { id: null, name: null, model: null } } };
		}
		if (m === 'GET' && path === '/instruments') {
			return { status: 200, body: { data: [{ mount: 'left', instrumentType: 'pipette', instrumentName: 'p20_single_gen2', instrumentModel: 'p20_single_v2.2', serialNumber: 'SIM-P20', ok: true }] } };
		}
		if (m === 'GET' && path === '/modules') return { status: 200, body: { data: [] } };
		if (m === 'GET' && path === '/robot/lights') return { status: 200, body: { on: this.lightsOn } };
		if (m === 'POST' && path === '/robot/lights') {
			this.lightsOn = !!body?.on;
			return { status: 200, body: { on: this.lightsOn } };
		}
		if (m === 'POST' && (path === '/identify' || path === '/robot/home')) return { status: 200, body: { message: 'ok' } };
		if (m === 'GET' && path.startsWith('/calibration')) return { status: 200, body: { data: [], deckCalibration: { status: 'OK' } } };
		if (m === 'GET' && path === '/labwareOffsets') return { status: 200, body: { data: [] } };
		if (m === 'GET' && path === '/settings') return { status: 200, body: { settings: [] } };

		// ── protocols ──
		if (path === '/protocols' && m === 'GET') {
			return { status: 200, body: { data: [...this.protocols.values()].map((p) => this.protocolView(p)) } };
		}
		if (path === '/protocols' && m === 'POST') {
			const labware: LabwareDef[] = Array.isArray(body?.labware) ? body.labware : [];
			const p = this.registerUpload(String(body?.fileName ?? 'protocol.py'), labware, body?.runTimeParameters ?? []);
			return { status: 201, body: { data: this.protocolView(p) } };
		}
		if (seg[0] === 'protocols' && seg[1]) {
			const p = this.protocols.get(decodeURIComponent(seg[1]));
			if (!p) return { status: 404, body: { errors: [{ id: 'ProtocolNotFound', detail: `Protocol ${seg[1]} not found` }] } };
			if (seg.length === 2 && m === 'GET') return { status: 200, body: { data: this.protocolView(p) } };
			if (seg.length === 2 && m === 'DELETE') {
				this.protocols.delete(p.id);
				return { status: 200, body: {} };
			}
			if (seg[2] === 'analyses' && seg.length === 3 && m === 'GET') {
				return { status: 200, body: { data: [{ id: `${p.id}-analysis`, status: 'completed' }], meta: { cursor: 0, totalLength: 1 } } };
			}
			if (seg[2] === 'analyses' && seg.length === 4 && m === 'GET') return { status: 200, body: { data: this.analysisFor(p) } };
		}

		// ── runs ──
		if (path === '/runs' && m === 'GET') {
			const cur = this.currentRun();
			return {
				status: 200,
				body: {
					data: this.runOrder.map((id) => this.runs.get(id)).filter(Boolean).map((r) => this.runView(r as FakeRun)),
					links: cur ? { current: { href: `/runs/${cur.id}` } } : {},
					meta: { cursor: 0, totalLength: this.runOrder.length }
				}
			};
		}
		if (path === '/runs' && m === 'POST') {
			const protocolId = String(body?.data?.protocolId ?? '');
			if (!this.protocols.has(protocolId)) {
				return { status: 404, body: { errors: [{ id: 'ProtocolNotFound', detail: `Protocol ${protocolId} was not found` }] } };
			}
			const cur = this.currentRun();
			if (cur && (cur.status === 'running' || cur.status === 'paused')) {
				return { status: 409, body: { errors: [{ id: 'RunAlreadyActive', detail: `Run ${cur.id} is ${cur.status}; stop it first` }] } };
			}
			const run: FakeRun = {
				id: fakeId('sim-run'),
				protocolId,
				status: 'idle',
				createdAt: t,
				startedAt: null,
				completedAt: null,
				actions: [],
				runTimeParameterValues: (body?.data?.runTimeParameterValues ?? {}) as Record<string, unknown>,
				commands: [],
				plan: [],
				elapsedMs: 0,
				lastPlayAt: null
			};
			run.plan = this.buildPlan(run);
			this.runs.set(run.id, run);
			this.runOrder.push(run.id);
			this.log(`run created ${run.id} (${run.plan.length} planned commands)`);
			return { status: 201, body: { data: this.runView(run) } };
		}
		if (seg[0] === 'runs' && seg[1]) {
			const run = this.runs.get(decodeURIComponent(seg[1]));
			if (!run) return { status: 404, body: { errors: [{ id: 'RunNotFound', detail: `Run ${seg[1]} was not found` }] } };
			if (seg.length === 2 && m === 'GET') return { status: 200, body: { data: this.runView(run) } };
			if (seg.length === 2 && m === 'DELETE') {
				if (run.status === 'running' || run.status === 'paused') {
					return { status: 409, body: { errors: [{ id: 'RunNotIdle', detail: 'Run is still active' }] } };
				}
				this.runs.delete(run.id);
				this.runOrder = this.runOrder.filter((id) => id !== run.id);
				return { status: 200, body: {} };
			}
			if (seg[2] === 'actions' && m === 'POST') {
				const actionType = String(body?.data?.actionType ?? '');
				const terminal = run.status === 'succeeded' || run.status === 'stopped' || run.status === 'failed';
				if (actionType === 'play') {
					if (terminal) return { status: 409, body: { errors: [{ id: 'RunActionNotAllowed', detail: 'Run is already terminal' }] } };
					if (run.status !== 'running') {
						run.status = 'running';
						run.startedAt ??= t;
						run.lastPlayAt = this.now();
						this.log(`run ${run.id} playing`);
					}
				} else if (actionType === 'pause') {
					if (run.status !== 'running') return { status: 409, body: { errors: [{ id: 'RunActionNotAllowed', detail: 'Run is not running' }] } };
					run.elapsedMs += this.now() - (run.lastPlayAt ?? this.now());
					run.lastPlayAt = null;
					run.status = 'paused';
				} else if (actionType === 'stop') {
					if (terminal) return { status: 409, body: { errors: [{ id: 'RunActionNotAllowed', detail: 'Run is already terminal' }] } };
					run.status = 'stopped';
					run.completedAt = t;
					run.lastPlayAt = null;
					this.log(`run ${run.id} stopped`);
				} else {
					return { status: 400, body: { errors: [{ id: 'BadAction', detail: `Unknown actionType ${actionType}` }] } };
				}
				const action = { id: fakeId('act'), actionType, createdAt: t };
				run.actions.push(action);
				return { status: 201, body: { data: action } };
			}
			if (seg[2] === 'commands' && seg.length === 3 && m === 'GET') {
				const cursor = Math.max(0, Number(url.searchParams.get('cursor') ?? 0) || 0);
				const pageLength = Math.max(1, Math.min(10000, Number(url.searchParams.get('pageLength') ?? 20) || 20));
				const page = run.commands.slice(cursor, cursor + pageLength);
				return { status: 200, body: { data: page, meta: { cursor, totalLength: run.commands.length }, links: {} } };
			}
			if (seg[2] === 'commands' && seg.length === 3 && m === 'POST') {
				const c: FakeCommand = { id: fakeId('cmd'), commandType: String(body?.data?.commandType ?? 'custom'), status: 'succeeded', params: body?.data?.params ?? {}, createdAt: t };
				run.commands.push(c);
				return { status: 201, body: { data: c } };
			}
			if (seg[2] === 'commandErrors') return { status: 200, body: { data: [], meta: { cursor: 0, totalLength: 0 } } };
			if (seg[2] === 'currentState') return { status: 200, body: { data: { status: run.status } } };
			if (seg[2] === 'labware_offsets' && m === 'POST') return { status: 201, body: { data: body?.data ?? {} } };
		}

		// ── maintenance runs (sweeps, jog) — accepted, no motion ──
		if (path === '/maintenance_runs/current' && m === 'GET') {
			if (!this.maintenanceRunId) return { status: 404, body: { errors: [{ id: 'NoCurrentRunFound', detail: 'No maintenance run' }] } };
			return { status: 200, body: { data: { id: this.maintenanceRunId, status: 'open', createdAt: t } } };
		}
		if (path === '/maintenance_runs' && m === 'POST') {
			this.maintenanceRunId = fakeId('sim-mx');
			return { status: 201, body: { data: { id: this.maintenanceRunId, status: 'open', createdAt: t, actions: [], errors: [], pipettes: [], labware: [], modules: [] } } };
		}
		if (seg[0] === 'maintenance_runs' && seg[1]) {
			if (seg.length === 2 && m === 'DELETE') {
				if (this.maintenanceRunId === decodeURIComponent(seg[1])) this.maintenanceRunId = null;
				return { status: 200, body: {} };
			}
			if (seg[2] === 'commands' && m === 'POST') {
				const type = String(body?.data?.commandType ?? 'custom');
				const result: Record<string, unknown> =
					type === 'loadPipette' ? { pipetteId: 'sim-pipette' }
					: type === 'loadLabware' ? { labwareId: fakeId('sim-lw'), definition: { parameters: { loadName: body?.data?.params?.loadName } } }
					: type === 'savePosition' ? { positionId: fakeId('pos'), position: { x: 100, y: 100, z: 50 } }
					: {};
				return { status: 201, body: { data: { id: fakeId('cmd'), commandType: type, status: 'succeeded', params: body?.data?.params ?? {}, result, createdAt: t, completedAt: t } } };
			}
			if (seg[2] === 'labware_definitions' && m === 'POST') return { status: 201, body: { data: { definitionUri: `sim/${body?.data?.parameters?.loadName ?? 'labware'}/1` } } };
		}

		return { status: 404, body: { errors: [{ id: 'NotFound', detail: `sim: no route for ${m} ${path}` }] } };
	}

	private protocolView(p: FakeProtocol) {
		return {
			id: p.id,
			createdAt: p.createdAt,
			protocolType: 'python',
			robotType: 'OT-2 Standard',
			metadata: { protocolName: p.fileName, apiLevel: '2.19', author: 'sim' },
			analysisSummaries: [{ id: `${p.id}-analysis`, status: 'completed' }],
			files: [{ name: p.fileName, role: 'main' }],
			key: null
		};
	}
}
