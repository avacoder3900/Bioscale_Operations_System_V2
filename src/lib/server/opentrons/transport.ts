/**
 * Server-side Ot2Transport: the shared robot protocol (src/lib/opentrons/ot2-protocol.ts)
 * running over proxy.ts — i.e. the direct LAN IP in local dev, the Ot2BridgeCommand
 * queue on Vercel. Behaviour is exactly what robotGet/robotPost already do.
 */
import { json } from '@sveltejs/kit';
import { runVerb, type Ot2Transport, type Ot2Verb } from '$lib/opentrons/ot2-protocol';
import { robotGet, robotPost } from './proxy';

export function serverTransport(robot: { ip: string; port?: number | null }): Ot2Transport {
	return {
		get: (path) => robotGet(robot as any, path),
		post: (path, body, opts) => robotPost(robot as any, path, body, opts)
	};
}

/**
 * Run a shared verb through the queue line and answer with the route's JSON.
 * The browser's tailnet line runs the same `runVerb` against the robot, so the
 * two lines return identical status + body for the same robot response.
 */
export async function verbResponse(
	robot: { ip: string; port?: number | null },
	verb: Ot2Verb,
	args: Record<string, unknown>
): Promise<Response> {
	const r = await runVerb(serverTransport(robot), verb, args);
	if (r.status >= 500) console.error(`[API] ${verb} error:`, (r.body as any)?.message ?? (r.body as any)?.detail);
	return json(r.body, { status: r.status });
}
