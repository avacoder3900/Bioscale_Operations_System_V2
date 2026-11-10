/**
 * Arm Pi drive steps in the Movement Log (2026-11-10). Pure: no DB.
 *
 * The 2026-11-10 loop 4aXs4KTxC2kwMqX_zLN-p failed with the Pi's
 * "ReadTimeout" on awaitParked although BIMS had finished that step (its
 * run_parked audit) 76 s before the Pi gave up. Nothing recorded whether BIMS
 * sent its answer, so these rows do, on both sides, matched by the Pi's
 * request id (`reqId`):
 *
 *   drive_received   BIMS got the step               (device 'link', at = received)
 *   drive_answered   BIMS sent its answer            (durationMs = time in BIMS)
 *   pi_drive_step    the Pi's own view of that step  (at = sent, durationMs = round trip, wifi)
 *   pi_drive_note    the Pi driver's notes           ("grab failed: …")
 *
 * A received row with no answered row: BIMS stalled. An answered row and a Pi
 * timeout on the same reqId: the answer was lost between Vercel and the Pi.
 */

export const DRIVE_KINDS = ['drive_received', 'drive_answered', 'pi_drive_step', 'pi_drive_note'] as const;

/** The Pi's Wi-Fi at the step, from /proc/net/wireless. */
export interface PiWifi {
	iface?: string | null;
	link?: number | null;
	level?: number | null;
}

/** One event from the Pi driver's log (loop_driver.py `events`). */
export interface PiDriveEvent {
	at?: number;
	sent_at?: number;
	action?: string;
	note?: string;
	ok?: boolean;
	ms?: number;
	error?: string | null;
	req?: string | null;
	attempt?: number | null;
	status?: number | null;
	vercel_id?: string | null;
	wifi?: PiWifi | null;
}

export interface DriveRow {
	_id: string;
	device: 'link';
	kind: string;
	at: Date;
	endAt: Date | null;
	durationMs: number | null;
	what: string | null;
	line: string;
	ok: boolean;
	error: string | null;
	from: string;
	loopId: string;
	reqId?: string;
	detail?: Record<string, unknown>;
}

const cut = (s: unknown, n: number): string | null => (s == null || s === '' ? null : String(s).slice(0, n));
const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);

export function wifiText(w: PiWifi | null | undefined): string {
	if (!w || (w.level == null && w.link == null)) return '';
	const parts = [w.level != null ? `${w.level} dBm` : null, w.link != null ? `link ${w.link}` : null].filter(Boolean);
	return `  Wi-Fi ${parts.join(' ')}`;
}

/** BIMS's own rows: the step arrived, and (later) its answer went out. */
export function receivedRow(o: { loopId: string; action: string; reqId: string | null; attempt: number | null; receivedAt: Date; vercelId: string | null }): DriveRow {
	return {
		_id: `drv-${o.reqId ?? `${o.loopId}-${o.receivedAt.getTime()}`}-in`,
		device: 'link',
		kind: 'drive_received',
		at: o.receivedAt,
		endAt: null,
		durationMs: null,
		what: o.action,
		line: `Arm Pi Step  ${o.action}  Received${o.reqId ? `  req ${o.reqId}` : ''}${o.attempt && o.attempt > 1 ? `  try ${o.attempt}` : ''}`,
		ok: true,
		error: null,
		from: 'Arm Pi Driver',
		loopId: o.loopId,
		...(o.reqId ? { reqId: o.reqId } : {}),
		detail: { attempt: o.attempt, vercelId: o.vercelId }
	};
}

export function answeredRow(o: {
	loopId: string;
	action: string;
	reqId: string | null;
	attempt: number | null;
	receivedAt: Date;
	answeredAt: Date;
	status: number;
	error: string | null;
	vercelId: string | null;
	region: string | null;
}): DriveRow {
	const ms = Math.max(0, o.answeredAt.getTime() - o.receivedAt.getTime());
	return {
		_id: `drv-${o.reqId ?? `${o.loopId}-${o.receivedAt.getTime()}`}-out`,
		device: 'link',
		kind: 'drive_answered',
		at: o.receivedAt,
		endAt: o.answeredAt,
		durationMs: ms,
		what: o.action,
		line: `Arm Pi Step  ${o.action}  Answered ${o.status}  ${ms} ms${o.reqId ? `  req ${o.reqId}` : ''}`,
		ok: o.status < 400,
		error: cut(o.error, 500),
		from: 'Arm Pi Driver',
		loopId: o.loopId,
		...(o.reqId ? { reqId: o.reqId } : {}),
		detail: { attempt: o.attempt, status: o.status, vercelId: o.vercelId, region: o.region }
	};
}

/**
 * The Pi's log for a loop, as rows. Ids are fixed by the request id (steps) or
 * the Pi's timestamp (notes), so the Pi sending its log twice adds nothing.
 */
export function piEventRows(loopId: string, events: unknown[], max = 400): DriveRow[] {
	const rows: DriveRow[] = [];
	for (const raw of events.slice(0, max)) {
		if (!raw || typeof raw !== 'object') continue;
		const e = raw as PiDriveEvent;
		const at = num(e.at);
		if (at == null) continue;
		if (e.action) {
			const ms = num(e.ms);
			const sent = num(e.sent_at) ?? (ms != null ? at - ms / 1000 : at);
			const ok = e.ok === true;
			const action = cut(e.action, 40)!;
			const req = cut(e.req, 64);
			const status = num(e.status);
			rows.push({
				_id: `pidrv-${req ?? `${loopId}-${Math.round(at * 1000)}`}`,
				device: 'link',
				kind: 'pi_drive_step',
				at: new Date(sent * 1000),
				endAt: new Date(at * 1000),
				durationMs: ms != null ? Math.round(ms) : null,
				what: action,
				line: `Pi Step  ${action}  ${ok ? `ok ${status ?? ''}`.trim() : 'failed'}${ms != null ? `  ${Math.round(ms)} ms` : ''}${req ? `  req ${req}` : ''}${wifiText(e.wifi)}`.slice(0, 500),
				ok,
				error: cut(e.error, 500),
				from: 'Arm Pi Driver',
				loopId,
				...(req ? { reqId: req } : {}),
				detail: { attempt: num(e.attempt), status, vercelId: cut(e.vercel_id, 120), wifi: e.wifi ?? null }
			});
		} else if (e.note) {
			rows.push({
				_id: `pidrv-${loopId}-${Math.round(at * 1000)}-note`,
				device: 'link',
				kind: 'pi_drive_note',
				at: new Date(at * 1000),
				endAt: null,
				durationMs: null,
				what: null,
				line: `Pi Note  ${cut(e.note, 400)}`,
				ok: true,
				error: null,
				from: 'Arm Pi Driver',
				loopId
			});
		}
	}
	return rows;
}
