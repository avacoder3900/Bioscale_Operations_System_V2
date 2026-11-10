/**
 * An OT-2 run's own history in the Movement Log (2026-11-10). Pure: no DB.
 *
 * The robot keeps, on each run, every play / pause / stop it was given
 * (`actions`, with the robot's time) and the run-level errors (`errors`).
 * BIMS logs each run action it sends (kind run_action_sent, from robotPost),
 * so each robot action can be told apart: sent by BIMS, or not (the robot's
 * screen, the Opentrons App, another client). Monday 2026-11-09's 10:00 CT
 * "run ended stopped" could not be explained for want of this.
 *
 *   run_action   one robot action: "Run Action  Stop  Sent By BIMS (Giovanni Victorio)"
 *   run_error    one run-level error
 *
 * Row ids are fixed by the robot's action / error id: a repeated sync adds nothing.
 * An action younger than SETTLE_MS is `deferred`: the caller keeps the run open for the next sync.
 */

export const RUN_HISTORY_KINDS = ['run_action', 'run_action_sent', 'run_error'] as const;

/** How far apart a robot action and BIMS's send may be (the queue can hold a send for a while). */
export const MATCH_BEFORE_MS = 120_000;
/** Clock slack: a robot action may read slightly before the send that caused it. */
export const MATCH_AFTER_MS = 3_000;
/** An action this young is left for the next sync, so BIMS's send row is surely written first. */
export const SETTLE_MS = 10_000;

export interface RunAction {
	id?: string;
	createdAt?: string;
	actionType?: string;
}

export interface RunError {
	id?: string;
	createdAt?: string;
	errorType?: string;
	errorCode?: string;
	detail?: string;
}

/** BIMS's own send of a run action (a run_action_sent row). */
export interface SentAction {
	at: Date;
	actionType: string;
	ok: boolean;
	username: string | null;
	from: string | null;
}

export interface HistoryRow {
	_id: string;
	device: 'ot2';
	kind: string;
	at: Date;
	endAt: Date | null;
	durationMs: null;
	what: string | null;
	line: string;
	ok: boolean;
	error: string | null;
	from: string;
	movedBy: null;
	robot: { _id: string; name: string };
	runId: string;
	detail: Record<string, unknown>;
	clockOffsetMs: number | null;
}

const title = (s: string) =>
	s
		.replace(/([a-z])([A-Z])/g, '$1 $2')
		.split(/[-_\s]+/)
		.filter(Boolean)
		.map((w) => w[0].toUpperCase() + w.slice(1))
		.join(' ');

const shift = (iso: string, offsetMs: number | null) => new Date(new Date(iso).getTime() - (offsetMs && Number.isFinite(offsetMs) ? offsetMs : 0));

/** The run action BIMS sends: POST /runs/{id}/actions { data: { actionType } }. */
export function runActionOf(path: string, body: unknown): { runId: string; actionType: string } | null {
	const m = /^\/runs\/([^/?]+)\/actions$/.exec(path.split('?')[0]);
	if (!m) return null;
	let b: any = body;
	if (typeof b === 'string') {
		try {
			b = JSON.parse(b);
		} catch {
			b = null;
		}
	}
	const t = b?.data?.actionType;
	return { runId: decodeURIComponent(m[1]), actionType: typeof t === 'string' && t ? t : 'unknown' };
}

/**
 * The robot's actions and errors as rows. `sentSince` is when BIMS began
 * logging its sends: an action before it has no known source.
 */
export function runHistoryRows(o: {
	robot: { _id: string; name: string };
	runId: string;
	from: string;
	run: { actions?: RunAction[]; errors?: RunError[] };
	sent: SentAction[];
	sentSince: Date | null;
	clockOffsetMs: number | null;
	now: Date;
}): { rows: HistoryRow[]; deferred: number } {
	const rows: HistoryRow[] = [];
	let deferred = 0;
	const base = { device: 'ot2' as const, endAt: null, durationMs: null, from: o.from, movedBy: null, robot: o.robot, runId: o.runId, clockOffsetMs: o.clockOffsetMs ?? null };
	const unused = [...o.sent].sort((a, b) => a.at.getTime() - b.at.getTime());

	const actions = (o.run.actions ?? []).filter((a) => a?.id && a.createdAt).sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt)));
	for (const a of actions) {
		const at = shift(String(a.createdAt), o.clockOffsetMs);
		if (o.now.getTime() - at.getTime() < SETTLE_MS) {
			deferred++;
			continue;
		}
		const type = String(a.actionType ?? 'unknown');
		let source: string;
		let sentBy: SentAction | null = null;
		if (!o.sentSince || at < o.sentSince) source = 'Source Not Recorded';
		else {
			// The latest BIMS send of this type before the action (within the window), used once.
			let best = -1;
			for (let i = 0; i < unused.length; i++) {
				const d = at.getTime() - unused[i].at.getTime();
				if (unused[i].actionType === type && d >= -MATCH_AFTER_MS && d <= MATCH_BEFORE_MS) best = i;
			}
			if (best >= 0) {
				sentBy = unused.splice(best, 1)[0];
				source = sentBy.username ? `Sent By BIMS (${sentBy.username})` : 'Sent By BIMS';
			} else source = 'Not Sent By BIMS';
		}
		rows.push({
			...base,
			_id: `ot2act-${o.runId}-${a.id}`,
			kind: 'run_action',
			at,
			what: type,
			line: `Run Action  ${title(type)}  ${source}`,
			ok: true,
			error: null,
			detail: { actionId: a.id, actionType: type, source, sentAt: sentBy?.at ?? null, sentFrom: sentBy?.from ?? null }
		});
	}

	for (const e of o.run.errors ?? []) {
		if (!e?.id || !e.createdAt) continue;
		const kind = e.errorType ? title(e.errorType) : 'Error';
		rows.push({
			...base,
			_id: `ot2err-${o.runId}-${e.id}`,
			kind: 'run_error',
			at: shift(String(e.createdAt), o.clockOffsetMs),
			what: e.errorType ?? null,
			line: `Run Error  ${kind}${e.errorCode ? `  ${e.errorCode}` : ''}`.slice(0, 500),
			ok: false,
			error: e.detail ? String(e.detail).slice(0, 500) : null,
			detail: { errorId: e.id, errorType: e.errorType ?? null, errorCode: e.errorCode ?? null }
		});
	}
	return { rows, deferred };
}
