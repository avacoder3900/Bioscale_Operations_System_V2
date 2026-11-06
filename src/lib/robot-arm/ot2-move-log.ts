/**
 * Opentrons rows in the Movement Log (2026-11-06) — how an OT-2 command reads
 * and how the two machines' timing compares. Pure: no DB, no robot.
 *
 * Every command an OT-2 run executed (GET /runs/{id}/commands) becomes one
 * robot_arm_moves row with device 'ot2': its own startedAt / completedAt, so
 * an aspirate, a move or a pause carries the seconds it really took. The arm
 * side's measured rows are the loop steps (Grab, Withdraw, Fail: play sent →
 * arrival checked). $lib/server/ot2-move-log reads the robot and writes them.
 */
import type { Ot2CommandSummary } from './run-profile';

export type MoveDevice = 'arm' | 'ot2' | 'link';

/** Ids → names from GET /runs/{id}: labware by slot and load name, pipettes by name and mount. */
export interface Ot2RunNames {
	labware: Record<string, string>;
	pipettes: Record<string, string>;
}

export function runNames(run: unknown): Ot2RunNames {
	const r = (run && typeof run === 'object' ? run : {}) as Record<string, unknown>;
	const labware: Record<string, string> = {};
	for (const l of Array.isArray(r.labware) ? r.labware : []) {
		if (!l || typeof l.id !== 'string') continue;
		const slot = l.location?.slotName ?? l.location?.addressableAreaName;
		const name = String(l.displayName ?? l.loadName ?? 'Labware');
		labware[l.id] = slot ? `Slot ${slot} ${name}` : name;
	}
	const pipettes: Record<string, string> = {};
	for (const p of Array.isArray(r.pipettes) ? r.pipettes : []) {
		if (p && typeof p.id === 'string') pipettes[p.id] = [p.pipetteName, p.mount].filter(Boolean).join(' ');
	}
	return { labware, pipettes };
}

/** "moveToWell" → "Move To Well". */
export function camelTitle(s: string): string {
	return s
		.replace(/([a-z0-9])([A-Z])/g, '$1 $2')
		.replace(/[_-]+/g, ' ')
		.split(' ')
		.filter(Boolean)
		.map((w) => w.charAt(0).toUpperCase() + w.slice(1))
		.join(' ');
}

const n1 = (v: unknown): string | null => {
	const x = Number(v);
	return v != null && v !== '' && Number.isFinite(x) ? String(Math.round(x * 10) / 10) : null;
};

function wellOf(p: Record<string, unknown>, names: Ot2RunNames): string | null {
	const lw = typeof p.labwareId === 'string' ? (names.labware[p.labwareId] ?? 'Labware') : null;
	const well = typeof p.wellName === 'string' ? p.wellName : null;
	if (!lw && !well) return null;
	const loc = (p.wellLocation ?? null) as { origin?: string; offset?: { z?: number } } | null;
	const z = n1(loc?.offset?.z);
	const where = loc?.origin ? ` ${camelTitle(loc.origin)}${z && z !== '0' ? ` ${Number(z) > 0 ? '+' : ''}${z} mm` : ''}` : '';
	return `${[lw, well].filter(Boolean).join(' ')}${where}`;
}

const join = (...parts: (string | null | undefined | false)[]) => parts.filter(Boolean).join('  ');

/** One line for an OT-2 command: "Aspirate 50 µL  Slot 3 Wax Tube A1 Bottom +1 mm  92 µL/s". */
export function ot2CommandLine(c: Ot2CommandSummary, names: Ot2RunNames = { labware: {}, pipettes: {} }): string {
	const p = (c.params ?? {}) as Record<string, any>;
	const t = c.commandType;
	const vol = n1(p.volume) ? `${n1(p.volume)} µL` : null;
	const flow = n1(p.flowRate) ? `${n1(p.flowRate)} µL/s` : null;
	const xyz = (o: any) => (o ? `X ${n1(o.x) ?? '?'} Y ${n1(o.y) ?? '?'} Z ${n1(o.z) ?? '?'}` : null);
	switch (t) {
		case 'custom':
			// Protocols below API 2.14 report every step as a legacy command with its own text.
			return String(p.legacyCommandText ?? camelTitle(String(p.legacyCommandType ?? 'Custom')));
		case 'aspirate':
		case 'dispense':
			return join(camelTitle(t), vol, wellOf(p, names), flow);
		case 'aspirateInPlace':
		case 'dispenseInPlace':
			return join(camelTitle(t), vol, flow);
		case 'blowOut':
		case 'blowout':
		case 'touchTip':
		case 'pickUpTip':
		case 'dropTip':
		case 'moveToWell':
			return join(camelTitle(t), wellOf(p, names));
		case 'moveToCoordinates':
			return join('Move To', xyz(p.coordinates), n1(p.minimumZHeight) ? `Min Z ${n1(p.minimumZHeight)}` : null, p.forceDirect ? 'Direct' : null);
		case 'moveRelative': {
			const d = Number(p.distance);
			return `Move ${String(p.axis ?? '').toUpperCase()} ${d > 0 ? '+' : ''}${n1(d) ?? '?'} mm`;
		}
		case 'moveToAddressableArea':
		case 'moveToAddressableAreaForDropTip':
			return join('Move To', camelTitle(String(p.addressableAreaName ?? 'Area')));
		case 'home':
			return Array.isArray(p.axes) && p.axes.length ? `Home ${p.axes.map((a: unknown) => camelTitle(String(a))).join(', ')}` : 'Home All';
		case 'retractAxis':
			return `Retract ${camelTitle(String(p.axis ?? ''))}`;
		case 'waitForResume':
			return join('Pause', typeof p.message === 'string' ? p.message.trim() : null);
		case 'waitForDuration':
			return join('Delay', n1(p.seconds) ? `${n1(p.seconds)} s` : null, typeof p.message === 'string' ? p.message.trim() : null);
		case 'comment':
			return join('Comment', typeof p.message === 'string' ? p.message.trim() : null);
		case 'loadLabware':
			return join('Load Labware', String(p.displayName ?? p.loadName ?? ''), p.location?.slotName ? `Slot ${p.location.slotName}` : null);
		case 'loadPipette':
			return join('Load Pipette', p.pipetteName, p.mount);
		case 'loadModule':
			return join('Load Module', p.model, p.location?.slotName ? `Slot ${p.location.slotName}` : null);
		case 'setRailLights':
			return `Rail Lights ${p.on ? 'On' : 'Off'}`;
		case 'configureForVolume':
			return join('Configure For Volume', vol);
		default: {
			const pip = typeof p.pipetteId === 'string' ? names.pipettes[p.pipetteId] : null;
			return join(camelTitle(t), vol, wellOf(p, names), pip);
		}
	}
}

/** The OT-2 command's error, one line. */
export function ot2CommandError(c: { error?: unknown }): string | null {
	const e = c.error as { detail?: unknown; errorType?: unknown } | null | undefined;
	if (!e) return null;
	return String(e.detail ?? e.errorType ?? 'failed').slice(0, 300);
}

/** Params kept on the row, capped so one command never bloats the log. */
export function keptParams(params: unknown): Record<string, unknown> | null {
	if (!params || typeof params !== 'object') return null;
	const s = JSON.stringify(params);
	return s.length <= 2000 ? (params as Record<string, unknown>) : { truncated: s.slice(0, 2000) };
}

const DONE = new Set(['succeeded', 'failed']);
const TERMINAL_RUN = new Set(['succeeded', 'failed', 'stopped']);

export interface Ot2RowDraft {
	seq: number;
	command: Ot2CommandSummary & { error?: unknown; intent?: string };
}

/**
 * Which commands of one page to log, starting at `cursor` (the run's index of
 * the page's first row). Commands are logged in order once they have ended;
 * the first one still running or queued stops the page, so the next read
 * resumes there. In an ended run a queued command never ran: skipped.
 * Returns the drafts and the new cursor.
 */
export function pickLoggable(page: Ot2CommandSummary[], cursor: number, runStatus: string | null): { rows: Ot2RowDraft[]; cursor: number; blocked: boolean } {
	const rows: Ot2RowDraft[] = [];
	const ended = !!runStatus && TERMINAL_RUN.has(runStatus);
	for (let i = 0; i < page.length; i++) {
		const c = page[i] as Ot2RowDraft['command'];
		if (DONE.has(String(c.status)) && (c.startedAt || c.completedAt)) rows.push({ seq: cursor + i, command: c });
		else if (!(ended && c.status !== 'running')) return { rows, cursor: cursor + i, blocked: true };
	}
	return { rows, cursor: cursor + page.length, blocked: false };
}

export const isRunEnded = (status: string | null | undefined): boolean => !!status && TERMINAL_RUN.has(status);

const msOf = (iso: unknown): number | null => {
	if (!iso) return null;
	const t = new Date(iso as string).getTime();
	return Number.isFinite(t) ? t : null;
};

/** Start, end and milliseconds of a command from its own timestamps. */
export function commandTiming(c: Ot2CommandSummary): { at: Date; endAt: Date | null; durationMs: number | null } | null {
	const a = msOf(c.startedAt) ?? msOf(c.completedAt);
	if (a == null) return null;
	const b = msOf(c.completedAt);
	return { at: new Date(a), endAt: b != null ? new Date(b) : null, durationMs: b != null && b >= a ? b - a : null };
}

export interface TimingRow {
	device: MoveDevice;
	kind: string;
	count: number;
	totalS: number;
	avgS: number;
	maxS: number;
}

type TimedRow = { device?: string | null; kind: string; durationMs: number | null; endAt?: string | Date | null; ok?: boolean };

/**
 * Seconds per device and type, for rows that carry a measured start and end
 * (every OT-2 command, the arm's loop steps, every BIMS→OT-2 hop with device
 * 'link'). The arm's single commands carry only the time the Pi took to
 * answer, not how long it moved: left out. Longest total first within each
 * device; the arm first, then the OT-2, then the link.
 */
export function summarizeTiming(rows: TimedRow[]): TimingRow[] {
	const m = new Map<string, TimingRow>();
	for (const r of rows) {
		if (!r.endAt || r.durationMs == null) continue;
		const device: MoveDevice = r.device === 'ot2' ? 'ot2' : r.device === 'link' ? 'link' : 'arm';
		const key = `${device}|${r.kind}`;
		const t = m.get(key) ?? { device, kind: r.kind, count: 0, totalS: 0, avgS: 0, maxS: 0 };
		const s = r.durationMs / 1000;
		t.count++;
		t.totalS += s;
		t.maxS = Math.max(t.maxS, s);
		m.set(key, t);
	}
	const out = [...m.values()].map((t) => ({ ...t, totalS: Math.round(t.totalS * 10) / 10, avgS: Math.round((t.totalS / t.count) * 100) / 100, maxS: Math.round(t.maxS * 100) / 100 }));
	const order: Record<MoveDevice, number> = { arm: 0, ot2: 1, link: 2 };
	return out.sort((a, b) => (a.device === b.device ? b.totalS - a.totalS : order[a.device] - order[b.device]));
}

export type LoopStep = 'grab' | 'withdraw' | 'withdraw_grab' | 'fail';

const STEP_TITLES: Record<LoopStep, string> = { grab: 'Grab', withdraw: 'Withdraw', withdraw_grab: 'Withdraw + Grab', fail: 'Fail' };

/** "Grab Cart 2  Planned 38.0 s", "Withdraw + Grab Cart 1 To 2". */
export function loopStepLine(step: LoopStep, cart: number, plannedS: number | null, animation: string | null): string {
	const carts = step === 'withdraw_grab' ? `Cart ${cart} To ${cart + 1}` : `Cart ${cart}`;
	return join(`${STEP_TITLES[step]} ${carts}`, animation, plannedS != null && Number.isFinite(plannedS) ? `Planned ${plannedS.toFixed(1)} s` : null);
}

/**
 * An OT-2 home or rail-lights request outside a run (2026-11-06) — the kind
 * and line its Movement Log row gets, or null for anything else. `body` may be
 * the JSON object or its text (the browser's direct line reports the text).
 */
export function ot2ActionOf(method: string, path: string, body: unknown): { kind: string; line: string } | null {
	if (method.toUpperCase() !== 'POST') return null;
	const p = path.split('?')[0];
	let b: any = body;
	if (typeof b === 'string') {
		try {
			b = JSON.parse(b);
		} catch {
			b = null;
		}
	}
	if (p === '/robot/home') {
		const target = typeof b?.target === 'string' ? b.target : 'robot';
		if (target === 'pipette') return { kind: 'home', line: join('Home', b?.mount ? camelTitle(String(b.mount)) : null, 'Pipette') };
		return { kind: 'home', line: 'Home All' };
	}
	if (p === '/robot/lights') {
		if (typeof b?.on !== 'boolean') return { kind: 'lights', line: 'Rail Lights' };
		return { kind: b.on ? 'lights_on' : 'lights_off', line: `Rail Lights ${b.on ? 'On' : 'Off'}` };
	}
	return null;
}
