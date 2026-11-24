/**
 * The arm Pi's GPIO pin changes in the Movement Log (2026-11-24) — pure: no DB.
 *
 * The Pi keeps every change of its output pins (services/robot-arm
 * gpio_events.py): Trapdoor A = GPIO 17, Trapdoor B = GPIO 27, the Conveyor
 * Belt = GPIO 22 (physical Pin 15). BIMS reads them from GET /gpio/events and
 * writes each as a robot_arm_moves row with device 'gpio', so "was A on, when,
 * and what turned it on" can be answered after the fact, not only by the
 * Pi's state at the instant a page asked.
 *
 * Why: on 2026-11-24 the Teach page showed A high while nothing was pulsing,
 * and nothing BIMS logged could say why.
 */

/** One event as the Pi reports it. */
export interface PiGpioEvent {
	id: string;
	at: string;
	pin: number;
	/** 0 | 1; null on a boot row the Pi could not read. */
	state: number | null;
	source: string;
	ms?: number;
	held_ms?: number;
	run_id?: string;
	loop_id?: string;
	note?: string;
	/** Boot and unknown rows: what the pin is driven to (0 | 1), null when not an output. */
	driven?: number | null;
	/** Unknown rows that count a stretch of reads: how many of them differed from the drive. */
	odd_reads?: number;
	reads?: number;
}

export interface PiGpioEventsReply {
	events: PiGpioEvent[];
	boot_id?: string;
	now?: string;
	/** Each pin's level now; null while the Pi service has not claimed it. */
	pins?: Record<string, number | null>;
	/** Each pin's newest event, boot included. */
	last?: Record<string, PiGpioEvent | null>;
}

export const GPIO_PINS: { pin: number; title: string }[] = [
	{ pin: 17, title: 'Trapdoor A · GPIO 17' },
	{ pin: 27, title: 'Trapdoor B · GPIO 27' },
	{ pin: 22, title: 'Conveyor Belt · GPIO 22 · Pin 15' }
];

export const gpioPinTitle = (pin: number): string => GPIO_PINS.find((p) => p.pin === pin)?.title ?? `GPIO ${pin}`;

const SOURCE_TITLES: Record<string, string> = {
	'bims-pulse': 'BIMS Pulse',
	'replay-fire': 'Replay Fire',
	'loop-driver': 'Loop Driver',
	'all-off': 'All Off',
	shutdown: 'Service Stop',
	boot: 'Service Start',
	unknown: 'Unknown'
};

/** "Replay Fire" for 'replay-fire'; an unlisted source as the Pi sent it. */
export const gpioSourceTitle = (source: string | null | undefined): string => (source ? (SOURCE_TITLES[source] ?? source) : 'Unknown');

export const GPIO_EVENT_KINDS = ['gpio_on', 'gpio_off', 'gpio_boot'] as const;
export const GPIO_WARNING_KINDS = ['gpio_unexplained', 'gpio_stuck'] as const;

/** A held-on pin past its pulse by more than this is stuck (ms). */
export const STUCK_GRACE_MS = 3000;

/** The kind a Pi event's row gets. */
export function gpioEventKind(e: PiGpioEvent): 'gpio_on' | 'gpio_off' | 'gpio_boot' {
	if (e.source === 'boot') return 'gpio_boot';
	return e.state === 1 ? 'gpio_on' : 'gpio_off';
}

const join = (...parts: (string | null | undefined | false)[]) => parts.filter(Boolean).join('  ');

/** "Trapdoor A · GPIO 17 On  Replay Fire  100 ms  Run R42". */
export function gpioEventLine(e: PiGpioEvent): string {
	const pin = gpioPinTitle(e.pin);
	if (e.source === 'boot') {
		const found = e.state === 1 ? 'High' : e.state === 0 ? 'Low' : null;
		return join(`${pin} ${found ? `Found ${found} At Service Start` : 'Not Read At Service Start'}`);
	}
	if (e.source === 'unknown' && e.driven != null) {
		const hl = (v: number | null | undefined) => (v === 1 ? 'High' : 'Low');
		const count = e.odd_reads != null && e.reads != null ? `${e.odd_reads} Of ${e.reads} Reads ${hl(e.driven === 1 ? 0 : 1)}` : null;
		if (e.note?.startsWith('still')) return join(`${pin} Still Reads ${hl(e.state)} While Driven ${hl(e.driven)}`, count);
		if (e.note?.includes('again')) return join(`${pin} Reads As Driven Again`, count);
		return join(`${pin} Reads ${hl(e.state)} While Driven ${hl(e.driven)}`);
	}
	return join(
		`${pin} ${e.state === 1 ? 'On' : 'Off'}`,
		gpioSourceTitle(e.source),
		e.state === 1 && e.ms != null ? `${e.ms} ms` : null,
		e.state !== 1 && e.held_ms != null ? `Held ${e.held_ms} ms` : null,
		e.loop_id ? `Loop ${e.loop_id}` : e.run_id ? `Run ${e.run_id}` : null
	);
}

export interface GpioRowDoc {
	_id: string;
	device: 'gpio';
	at: Date;
	kind: string;
	servo: null;
	goal: null;
	delta: null;
	goals: null;
	what: string;
	line: string;
	ok: boolean;
	error: string | null;
	durationMs: number | null;
	from: string;
	movedBy: { _id?: string; username?: string } | null;
	runId?: string;
	loopId?: string;
	detail: Record<string, unknown>;
}

/** The robot_arm_moves row for one Pi event. Its _id comes from the Pi's event id, so a re-read never doubles it. */
export function gpioEventRow(e: PiGpioEvent, who: { from?: string | null; movedBy?: { _id?: string; username?: string } | null } = {}): GpioRowDoc | null {
	const at = new Date(e.at);
	if (!e?.id || !Number.isFinite(e.pin) || Number.isNaN(at.getTime())) return null;
	return {
		_id: `gpio-${e.id}`,
		device: 'gpio',
		at,
		kind: gpioEventKind(e),
		servo: null,
		goal: null,
		delta: null,
		goals: null,
		what: gpioPinTitle(e.pin),
		line: gpioEventLine(e),
		// An outside change is a row to look at.
		ok: e.source !== 'unknown',
		error: e.source === 'unknown' ? (e.note ?? 'Changed With No Write From The Pi Service') : null,
		durationMs: e.held_ms ?? null,
		from: who.from ?? `Arm Pi ${gpioSourceTitle(e.source)}`,
		movedBy: who.movedBy ?? null,
		...(e.run_id ? { runId: e.run_id } : {}),
		...(e.loop_id ? { loopId: e.loop_id } : {}),
		detail: { pin: e.pin, state: e.state, driven: e.driven ?? null, source: e.source, ms: e.ms ?? null, heldMs: e.held_ms ?? null, oddReads: e.odd_reads ?? null, reads: e.reads ?? null, note: e.note ?? null, eventId: e.id }
	};
}

export interface GpioWarning {
	pin: number;
	kind: 'gpio_unexplained' | 'gpio_stuck';
	line: string;
	/** The newest event the warning is about, or null when the pin has none. */
	lastEventId: string | null;
}

/**
 * Pins that read high with nothing to explain it: no "on" event as the pin's
 * newest (gpio_unexplained), or an "on" whose pulse should have ended well
 * before now (gpio_stuck). A boot row that found the pin high counts as
 * unexplained: something outside this service drove it.
 */
export function gpioWarnings(reply: Pick<PiGpioEventsReply, 'pins' | 'last' | 'now'>, nowMs: number = Date.now()): GpioWarning[] {
	const out: GpioWarning[] = [];
	const piNow = reply.now ? new Date(reply.now).getTime() : nowMs;
	for (const [k, level] of Object.entries(reply.pins ?? {})) {
		if (level !== 1) continue;
		const pin = Number(k);
		const last = reply.last?.[k] ?? null;
		const title = gpioPinTitle(pin);
		if (!last || last.state !== 1 || last.source === 'boot' || last.source === 'unknown') {
			const why = !last
				? 'No Event'
				: last.source === 'unknown' && last.driven === 0
					? 'Reads High While Driven Low'
					: last.source === 'boot'
						? 'Found High At Service Start'
						: last.source === 'unknown'
							? 'Turned On Outside The Pi Service'
							: 'No On Event';
			out.push({ pin, kind: 'gpio_unexplained', line: `⚠ ${title} High  ${why}`, lastEventId: last?.id ?? null });
			continue;
		}
		const onAt = new Date(last.at).getTime();
		if (last.ms != null && Number.isFinite(onAt) && piNow - onAt > last.ms + STUCK_GRACE_MS) {
			const s = ((piNow - onAt) / 1000).toFixed(1);
			out.push({ pin, kind: 'gpio_stuck', line: `⚠ ${title} Still High ${s} s After A ${last.ms} ms Pulse  ${gpioSourceTitle(last.source)}`, lastEventId: last.id });
		}
	}
	return out;
}

/** A warning's row. One row per pin per newest event, so polling never repeats it. */
export function gpioWarningRow(w: GpioWarning, at: Date, bootId: string | null | undefined): GpioRowDoc {
	return {
		_id: `gpio-warn-${w.kind}-${w.pin}-${w.lastEventId ?? `none-${bootId ?? 'x'}`}`,
		device: 'gpio',
		at,
		kind: w.kind,
		servo: null,
		goal: null,
		delta: null,
		goals: null,
		what: gpioPinTitle(w.pin),
		line: w.line,
		ok: false,
		error: w.line.replace(/^⚠ /, ''),
		durationMs: null,
		from: 'BIMS GPIO Check',
		movedBy: null,
		detail: { pin: w.pin, lastEventId: w.lastEventId, bootId: bootId ?? null }
	};
}

/** A Movement Log fire row as the BIMS pulse match needs it. */
export interface FireRowRef {
	at: Date | string;
	what?: string | null;
	from?: string | null;
	movedBy?: { _id?: string; username?: string } | null;
}

/**
 * The BIMS fire row a 'bims-pulse' event came from: the nearest one sent at
 * most 10 s before (or 3 s after, clock skew) the pin went on. Its user and
 * page are who turned the pin on.
 */
export function matchBimsPulse(e: PiGpioEvent, rows: FireRowRef[]): FireRowRef | null {
	if (e.source !== 'bims-pulse') return null;
	const t = new Date(e.at).getTime();
	let best: FireRowRef | null = null;
	let bestD = Infinity;
	for (const r of rows) {
		const d = t - new Date(r.at).getTime();
		if (d < -3000 || d > 10_000) continue;
		if (Math.abs(d) < bestD) {
			best = r;
			bestD = Math.abs(d);
		}
	}
	return best;
}
