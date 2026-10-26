/**
 * Row validation for POST /api/agent/robot-link/samples (OT2-LOG-1 L2b): the
 * iMac link monitor's bulk upload, and the daemon's journal replay. Pure —
 * robotId resolution from deviceId happens in the route.
 */
export const MAX_SAMPLE_ROWS = 500;
export const MAX_AT_SKEW_MS = 24 * 3600_000;
export const PATH_NAMES = ['wifi', 'wired', 'tailnet'] as const;
export const SAMPLE_SOURCES = ['imac', 'daemon'] as const;

export interface ValidPath {
	name: (typeof PATH_NAMES)[number];
	ip: string;
	lossPct: number | null;
	rttMs: number | null;
	healthMs: number | null;
	healthErr: string | null;
}

export interface ValidSampleRow {
	robotId: string | null;
	deviceId: string | null;
	at: Date;
	source: (typeof SAMPLE_SOURCES)[number];
	paths: ValidPath[];
}

export type RowResult = { ok: true; row: ValidSampleRow } | { ok: false; reason: string };

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const nullableNum = (v: unknown): number | null | undefined => {
	if (v === null || v === undefined) return null;
	return typeof v === 'number' && Number.isFinite(v) ? v : undefined;
};

export function validateSampleRow(raw: unknown, now: Date): RowResult {
	if (!isObj(raw)) return { ok: false, reason: 'row must be an object' };

	const robotId = typeof raw.robotId === 'string' && raw.robotId.trim() ? raw.robotId.trim().slice(0, 64) : null;
	const deviceId = typeof raw.deviceId === 'string' && raw.deviceId.trim() ? raw.deviceId.trim().slice(0, 100) : null;
	if (!robotId && !deviceId) return { ok: false, reason: 'robotId or deviceId is required' };

	if (typeof raw.at !== 'string') return { ok: false, reason: 'at must be an ISO string' };
	const at = new Date(raw.at);
	if (Number.isNaN(at.getTime())) return { ok: false, reason: 'at is not a valid date' };
	if (Math.abs(at.getTime() - now.getTime()) > MAX_AT_SKEW_MS) return { ok: false, reason: 'at must be within 1 day of now' };

	const source = raw.source;
	if (source !== 'imac' && source !== 'daemon') return { ok: false, reason: "source must be 'imac' or 'daemon'" };

	if (!Array.isArray(raw.paths) || raw.paths.length === 0) return { ok: false, reason: 'paths must be a non-empty array' };
	const paths: ValidPath[] = [];
	for (let i = 0; i < raw.paths.length; i++) {
		const p = raw.paths[i];
		if (!isObj(p)) return { ok: false, reason: `paths[${i}] must be an object` };
		if (!(PATH_NAMES as readonly unknown[]).includes(p.name)) return { ok: false, reason: `paths[${i}].name must be one of ${PATH_NAMES.join(', ')}` };
		if (typeof p.ip !== 'string') return { ok: false, reason: `paths[${i}].ip must be a string` };
		const lossPct = nullableNum(p.lossPct);
		if (lossPct === undefined || (lossPct !== null && (lossPct < 0 || lossPct > 100))) return { ok: false, reason: `paths[${i}].lossPct must be 0..100 or null` };
		const rttMs = nullableNum(p.rttMs);
		if (rttMs === undefined) return { ok: false, reason: `paths[${i}].rttMs must be a number or null` };
		const healthMs = nullableNum(p.healthMs);
		if (healthMs === undefined) return { ok: false, reason: `paths[${i}].healthMs must be a number or null` };
		const healthErr = p.healthErr === null || p.healthErr === undefined ? null : typeof p.healthErr === 'string' ? p.healthErr.slice(0, 200) : undefined;
		if (healthErr === undefined) return { ok: false, reason: `paths[${i}].healthErr must be a string or null` };
		paths.push({ name: p.name as ValidPath['name'], ip: p.ip.slice(0, 64), lossPct, rttMs, healthMs, healthErr });
	}

	return { ok: true, row: { robotId, deviceId, at, source, paths } };
}
