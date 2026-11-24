/**
 * Reads the arm Pi's GPIO pin changes into the Movement Log (2026-11-24) — see
 * $lib/robot-arm/gpio-events for the rows.
 *
 * syncGpioEvents() asks the Pi for every change since the newest one already
 * logged (GET /gpio/events?since=), writes each as a device 'gpio' row, and
 * writes a warning row for a pin that reads high with no "on" to explain it.
 * Called when the Movement Log or a Trapdoor Solenoids card reads, and when a
 * wax-fill loop ends. At most one read per few seconds per server; a Pi
 * without the route, or one that does not answer, costs the caller nothing.
 * Never throws.
 */
import { connectDB } from './db/connection';
import { RobotArmMove } from './db/models';
import { insertOt2Docs } from './ot2-move-log';
import { robotArmFetchRaw } from './robot-arm-client';
import { FIRE_KINDS } from '$lib/robot-arm/move-log';
import {
	GPIO_EVENT_KINDS,
	gpioEventRow,
	gpioWarningRow,
	gpioWarnings,
	matchBimsPulse,
	type FireRowRef,
	type GpioRowDoc,
	type PiGpioEventsReply
} from '$lib/robot-arm/gpio-events';

export interface GpioSyncResult {
	ok: boolean;
	/** Rows written this time (events and warnings). */
	rows: number;
	warnings: string[];
	error: string | null;
	/** True when a read inside the last few seconds made this one unnecessary. */
	skipped?: boolean;
}

const MIN_GAP_MS = 4000;
/** Read back this far before the newest logged event: the _id stops doubles, and a late write is not missed. */
const OVERLAP_MS = 5000;

let lastRun: { at: number; result: Promise<GpioSyncResult> } | null = null;

/** The newest Pi event already in the log, as the Pi's since= wants it. */
async function cursor(): Promise<string | null> {
	const row = (await RobotArmMove.findOne({ device: 'gpio', kind: { $in: [...GPIO_EVENT_KINDS] } })
		.sort({ at: -1 })
		.select('at')
		.lean()) as { at?: Date } | null;
	return row?.at ? new Date(new Date(row.at).getTime() - OVERLAP_MS).toISOString() : null;
}

async function run(timeoutMs: number): Promise<GpioSyncResult> {
	if (process.env.VITEST) return { ok: true, rows: 0, warnings: [], error: null };
	try {
		await connectDB();
		const since = await cursor();
		const r = await robotArmFetchRaw(`/gpio/events?limit=2000${since ? `&since=${encodeURIComponent(since)}` : ''}`, { timeoutMs });
		if (r.status === 404 || r.status === 501) return { ok: false, rows: 0, warnings: [], error: 'The Pi has no GPIO event log yet' };
		if (!r.ok) return { ok: false, rows: 0, warnings: [], error: `Pi answered ${r.status}` };
		const reply = JSON.parse(r.text) as PiGpioEventsReply;
		const events = Array.isArray(reply.events) ? reply.events : [];

		// Who sent each BIMS pulse: the Movement Log's own fire row for it.
		let fireRows: FireRowRef[] = [];
		const pulses = events.filter((e) => e.source === 'bims-pulse');
		if (pulses.length) {
			const times = pulses.map((e) => new Date(e.at).getTime()).filter(Number.isFinite);
			fireRows = (await RobotArmMove.find({
				device: { $nin: ['ot2', 'link', 'gpio'] },
				kind: { $in: [...FIRE_KINDS] },
				at: { $gte: new Date(Math.min(...times) - 10_000), $lte: new Date(Math.max(...times) + 3000) }
			})
				.select('at what from movedBy')
				.lean()) as FireRowRef[];
		}
		const docs: GpioRowDoc[] = [];
		for (const e of events) {
			const m = matchBimsPulse(e, fireRows);
			const row = gpioEventRow(e, m ? { from: m.from ?? null, movedBy: m.movedBy ?? null } : {});
			if (row) docs.push(row);
		}
		const warnings = gpioWarnings(reply);
		const at = reply.now ? new Date(reply.now) : new Date();
		for (const w of warnings) docs.push(gpioWarningRow(w, at, reply.boot_id));
		const rows = docs.length ? await insertOt2Docs(docs) : 0;
		return { ok: true, rows, warnings: warnings.map((w) => w.line), error: null };
	} catch (err) {
		const msg = err instanceof Error ? err.message : String(err);
		return { ok: false, rows: 0, warnings: [], error: /robot-arm 404|404/.test(msg) ? 'The Pi has no GPIO event log yet' : msg.slice(0, 200) };
	}
}

/** Read the Pi's new pin changes into the log. A call within a few seconds of the last shares its result. */
export function syncGpioEvents(o: { timeoutMs?: number; force?: boolean } = {}): Promise<GpioSyncResult> {
	const now = Date.now();
	if (!o.force && lastRun && now - lastRun.at < MIN_GAP_MS) return lastRun.result.then((r) => ({ ...r, skipped: true }));
	const result = run(o.timeoutMs ?? 4000);
	lastRun = { at: now, result };
	return result;
}
