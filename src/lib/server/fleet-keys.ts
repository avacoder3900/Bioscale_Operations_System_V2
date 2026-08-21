/**
 * PERM-05 §D: per-fleet device keys.
 *
 * Today every non-human caller — scanner bridges, OT-2 pollers, Mocreo, Particle,
 * the agent API and the MCP server — presents the same `AGENT_API_KEY`. A key
 * leaked from a Raspberry Pi on the bench is therefore also a key that can read
 * the whole database. Fleet keys fix that: each device family gets its own
 * secret that is valid ONLY on its own endpoints.
 *
 * ROLLOUT IS ADDITIVE AND REVERSIBLE. `verifyFleetKey` accepts the fleet's own
 * key OR the shared agent key, so nothing breaks the day this ships. Per fleet,
 * in order:
 *   1. set the fleet's env var in Vercel (this module starts accepting it)
 *   2. update that fleet's devices to send it
 *   3. confirm traffic (audit rows show keyIdentity = the fleet)
 *   4. set <FLEET>_STRICT=true to stop accepting the shared key there
 * Only after every fleet is strict is it worth rotating AGENT_API_KEY itself.
 *
 * Devices never carry permissions. A fleet key proves "this is the scanner
 * fleet", nothing more — it can never satisfy an admin gate, because the machine
 * surface has no admin gates (see machine-actor.ts).
 */
import { error } from '@sveltejs/kit';
import { env } from '$env/dynamic/private';

export type FleetId = 'scanner' | 'ot2' | 'mocreo' | 'particle' | 'station';

interface FleetSpec {
	/** Env var holding this fleet's dedicated key. */
	envVar: string;
	/** Env var that, when 'true', stops accepting the shared agent key. */
	strictVar: string;
	/** Headers a device of this fleet may present its key in. */
	headers: string[];
	label: string;
}

const FLEETS: Record<FleetId, FleetSpec> = {
	scanner: {
		envVar: 'SCANNER_FLEET_KEY',
		strictVar: 'SCANNER_FLEET_STRICT',
		headers: ['x-fleet-key', 'x-api-key'],
		label: 'scanner-fleet'
	},
	ot2: {
		envVar: 'OT2_BRIDGE_KEY',
		strictVar: 'OT2_BRIDGE_STRICT',
		headers: ['x-fleet-key', 'x-api-key'],
		label: 'ot2-fleet'
	},
	mocreo: {
		envVar: 'MOCREO_FLEET_KEY',
		strictVar: 'MOCREO_FLEET_STRICT',
		headers: ['x-fleet-key', 'x-api-key'],
		label: 'mocreo-fleet'
	},
	particle: {
		envVar: 'PARTICLE_WEBHOOK_KEY',
		strictVar: 'PARTICLE_WEBHOOK_STRICT',
		headers: ['x-fleet-key', 'x-api-key'],
		label: 'particle-fleet'
	},
	station: {
		envVar: 'STATION_AGENT_KEY',
		strictVar: 'STATION_AGENT_STRICT',
		headers: ['x-station-agent-key', 'x-fleet-key'],
		label: 'station-fleet'
	}
};

/** Constant-time compare. Returns false on length mismatch (the usual caveat). */
function keyMatches(presented: string, expected: string): boolean {
	if (!presented || !expected || presented.length !== expected.length) return false;
	let mismatch = 0;
	for (let i = 0; i < expected.length; i++) {
		mismatch |= presented.charCodeAt(i) ^ expected.charCodeAt(i);
	}
	return mismatch === 0;
}

function presentedKeys(request: Request, spec: FleetSpec): string[] {
	const out: string[] = [];
	for (const h of spec.headers) {
		const v = request.headers.get(h);
		if (v) out.push(v);
	}
	const auth = request.headers.get('authorization');
	if (auth) out.push(auth.replace(/^bearer\s+/i, ''));
	return out;
}

export interface FleetAuthResult {
	/** Which credential actually authenticated — recorded in the audit trail. */
	keyIdentity: string;
	/** True when the caller used the legacy shared key rather than the fleet key. */
	usedSharedKey: boolean;
}

/**
 * Authenticate a device request for `fleet`. Throws 401 if neither the fleet key
 * nor (unless the fleet is strict) the shared agent key is presented.
 */
export function verifyFleetKey(request: Request, fleet: FleetId): FleetAuthResult {
	const spec = FLEETS[fleet];
	const presented = presentedKeys(request, spec);
	const fleetKey = (env as Record<string, string | undefined>)[spec.envVar];

	if (fleetKey && presented.some((p) => keyMatches(p, fleetKey))) {
		return { keyIdentity: spec.label, usedSharedKey: false };
	}

	const strict = (env as Record<string, string | undefined>)[spec.strictVar] === 'true';
	if (!strict) {
		const shared = env.AGENT_API_KEY;
		if (shared && presented.some((p) => keyMatches(p, shared))) {
			return { keyIdentity: 'agent-shared', usedSharedKey: true };
		}
	}

	throw error(401, `Invalid or missing key for the ${spec.label}`);
}

/** Fleets that have their own key configured — for diagnostics/reporting. */
export function fleetKeyStatus(): { fleet: FleetId; configured: boolean; strict: boolean }[] {
	return (Object.keys(FLEETS) as FleetId[]).map((f) => ({
		fleet: f,
		configured: Boolean((env as Record<string, string | undefined>)[FLEETS[f].envVar]),
		strict: (env as Record<string, string | undefined>)[FLEETS[f].strictVar] === 'true'
	}));
}
