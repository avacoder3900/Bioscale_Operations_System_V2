/**
 * Shape checks for POST /api/robot-arm/changes (the Pi reporting to the
 * Change Log), kept out of +server.ts because SvelteKit refuses non-handler
 * exports from route files at build time. See +server.ts for what the route does.
 *
 * Rows are judged one by one: a bad row is listed in `rejected` with its index
 * and reason so the Pi can drop it and still deliver the good ones; the Pi's
 * pending queue would otherwise stick on the first bad label for ever.
 */
import { error } from '@sveltejs/kit';
import { isArmHardware, isArmKey, isArmPage, type ArmChangeLabel, type ArmPage, type ArmSource } from '$lib/robot-arm/change-labels';
import type { ArmChangeInput } from '$lib/server/robot-arm-change-log';

export const MAX_ROWS = 50;
/** A row may be dated this far back (an install done while BIMS was unreachable, flushed later). */
export const MAX_AGE_MS = 30 * 24 * 3600 * 1000;
/** Clock slack: a Pi a little ahead of us still counts as "now". */
export const MAX_AHEAD_MS = 5 * 60 * 1000;
const MAX_DETAILS_CHARS = 4000;
/** Sources a Pi may claim. 'ui' and 'test' belong to BIMS's own writers. */
const PI_SOURCES: ArmSource[] = ['pi', 'hand', 'code'];

export interface ParsedChanges {
	host: string | null;
	changes: { index: number; change: ArmChangeInput }[];
	rejected: { index: number; reason: string }[];
}

const str = (v: unknown, max: number): string | null => (typeof v === 'string' && v.trim() ? v.trim().slice(0, max) : null);

function value(v: unknown): unknown {
	if (v === null || v === undefined) return null;
	if (typeof v === 'boolean' || (typeof v === 'number' && Number.isFinite(v))) return v;
	if (typeof v === 'string') return v.slice(0, 200);
	return null;
}

function when(raw: unknown, now: number): Date {
	const d = typeof raw === 'string' || typeof raw === 'number' ? new Date(raw) : new Date(now);
	const t = d.getTime();
	if (isNaN(t) || t > now + MAX_AHEAD_MS || now - t > MAX_AGE_MS) return new Date(now);
	return d;
}

export function parseChangeRow(raw: unknown, now = Date.now()): { change?: ArmChangeInput; reason?: string } {
	if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { reason: 'not an object' };
	const r = raw as Record<string, unknown>;
	if (!isArmHardware(r.hardware)) return { reason: `unknown hardware "${String(r.hardware)}"` };
	if (!isArmKey(r.key)) return { reason: `bad key "${String(r.key)}"` };
	const page: ArmPage = r.page === undefined || r.page === null ? 'pi' : isArmPage(r.page) ? r.page : 'pi';
	const source = PI_SOURCES.includes(r.source as ArmSource) ? (r.source as ArmSource) : 'pi';
	let details: unknown = null;
	if (r.details && typeof r.details === 'object') {
		const txt = JSON.stringify(r.details);
		details = txt.length <= MAX_DETAILS_CHARS ? r.details : { truncated: txt.slice(0, MAX_DETAILS_CHARS) };
	}
	const label: ArmChangeLabel = {
		page,
		hardware: r.hardware,
		key: r.key,
		target: str(r.target, 120),
		unit: str(r.unit, 20),
		oldValue: value(r.oldValue),
		newValue: value(r.newValue)
	};
	return { change: { ...label, source, note: str(r.note, 300), details, at: when(r.at, now) } };
}

export function parseChangesBody(raw: unknown, now = Date.now()): ParsedChanges {
	if (!raw || typeof raw !== 'object' || Array.isArray(raw)) error(400, 'Body must be a JSON object');
	const b = raw as Record<string, unknown>;
	if (!Array.isArray(b.changes)) error(400, 'Body needs `changes` (an array)');
	if (!b.changes.length) error(400, '`changes` is empty');
	if (b.changes.length > MAX_ROWS) error(400, `At most ${MAX_ROWS} changes per request`);
	const out: ParsedChanges = { host: str(b.host, 64), changes: [], rejected: [] };
	b.changes.forEach((row, index) => {
		const p = parseChangeRow(row, now);
		if (p.change) out.changes.push({ index, change: p.change });
		else out.rejected.push({ index, reason: p.reason ?? 'invalid' });
	});
	return out;
}
