/**
 * Where an operator script reaches an OT-2's robot API (OT2-TAILNET-5 §7.7, S9).
 *
 * Two lines, one rule:
 *   - a bare host or IP (today's form: `hidden-leaf.local`, `172.16.x.y`)
 *       → http://<host>:31950            (lab LAN; unchanged default)
 *   - a full URL (`https://ot2-b14.tailf65a70.ts.net`)
 *       → used as-is: https, NO port     (Tailscale serve terminates TLS on 443
 *                                          and forwards to localhost:31950)
 *   - `tailnet` with a slot (b07 / b14 / r04)
 *       → https://ot2-<slot>.tailf65a70.ts.net
 *
 * The `opentrons-version` header is identical on both lines, so callers keep
 * their own headers and only swap `http://${host}:31950${path}` for
 * `robotUrl(host, path)`.
 *
 * Usage (any script):
 *   ROBOT_HOST=https://ot2-b14.tailf65a70.ts.net node scripts/deploy-wax-tipcal-guards.cjs
 *   ROBOT=b14 ROBOT_HOST=tailnet                  node scripts/deploy-wax-tipcal-guards.cjs
 *
 * CommonJS so both the .cjs scripts (require) and the tsx .ts scripts
 * (import … from './ot2-robot-host.cjs') can use it. No dependencies.
 */
'use strict';

const ROBOT_API_PORT = 31950;
const TAILNET_SUFFIX = 'tailf65a70.ts.net';

/** @param {string | null | undefined} slot */
function tailnetUrlForSlot(slot) {
	const s = String(slot || '').trim().toLowerCase();
	if (!/^[a-z][0-9]{2}$/.test(s)) {
		throw new Error(`ROBOT_HOST=tailnet needs a robot slot like b14 (got "${slot || ''}")`);
	}
	return `https://ot2-${s}.${TAILNET_SUFFIX}`;
}

/**
 * The robot-API base URL (no trailing slash) for a host value.
 * @param {string} host  bare host/IP, a full http(s) URL, or 'tailnet'
 * @param {{ slot?: string | null }} [opts]  slot for the 'tailnet' shorthand
 * @returns {string}
 */
function robotBaseUrl(host, opts) {
	const h = String(host || '').trim();
	if (!h) throw new Error('robot host is empty');
	if (h.toLowerCase() === 'tailnet') return tailnetUrlForSlot(opts && opts.slot);
	if (/^https?:\/\//i.test(h)) {
		const u = new URL(h);
		if (u.pathname !== '/' && u.pathname !== '') {
			throw new Error(`ROBOT_HOST must be an origin with no path (got "${h}")`);
		}
		return `${u.protocol}//${u.host}`;
	}
	return `http://${h}:${ROBOT_API_PORT}`;
}

/**
 * Full URL for a robot-API path on that host.
 * @param {string} host
 * @param {string} path  e.g. '/protocols'
 * @param {{ slot?: string | null }} [opts]
 */
function robotUrl(host, path, opts) {
	const p = String(path || '');
	return `${robotBaseUrl(host, opts)}${p.startsWith('/') ? p : `/${p}`}`;
}

/** true for a value that points at the tailnet line (https URL or 'tailnet'). */
function isTailnetHost(host) {
	const h = String(host || '').trim().toLowerCase();
	return h === 'tailnet' || h.startsWith('https://');
}

/**
 * Does an opentrons_robots record answer at this host? True when the host is
 * the record's LAN `ip`, or the same origin as its `connection.directUrl`
 * (the tailnet URL BIMS stores). For scripts that walk Mongo's robot list.
 * @param {string} host
 * @param {{ ip?: string, connection?: { directUrl?: string | null } | null }} record
 */
function matchesRobotRecord(host, record) {
	const h = String(host || '').trim();
	if (!h || !record) return false;
	if (record.ip && record.ip === h) return true;
	const direct = record.connection && record.connection.directUrl;
	if (!direct || !/^https?:\/\//i.test(h)) return false;
	try {
		return robotBaseUrl(direct).toLowerCase() === robotBaseUrl(h).toLowerCase();
	} catch {
		return false;
	}
}

/** ROBOT_HOST from the environment, trimmed, or null. */
function robotHostFromEnv(env) {
	const v = ((env || process.env).ROBOT_HOST || '').trim();
	return v || null;
}

module.exports = {
	ROBOT_API_PORT,
	TAILNET_SUFFIX,
	robotBaseUrl,
	robotUrl,
	isTailnetHost,
	matchesRobotRecord,
	robotHostFromEnv,
	tailnetUrlForSlot
};
