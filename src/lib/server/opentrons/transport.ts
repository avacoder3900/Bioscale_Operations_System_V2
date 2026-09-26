/**
 * Server-side Ot2Transport: the shared robot protocol (src/lib/opentrons/ot2-protocol.ts)
 * running over proxy.ts — i.e. the direct LAN IP in local dev, the Ot2BridgeCommand
 * queue on Vercel. Behaviour is exactly what robotGet/robotPost/robotDelete already do.
 */
import { json } from '@sveltejs/kit';
import { runVerb, maintenanceRecordFor, type Ot2Transport, type Ot2Verb } from '$lib/opentrons/ot2-protocol';
import { robotGet, robotPost, robotDelete, robotPostMultipart } from './proxy';
import { applyMaintenanceRecord } from './maintenance-records';

export function serverTransport(robot: { ip: string; port?: number | null }): Ot2Transport {
	return {
		get: (path) => robotGet(robot as any, path),
		// A FormData body is the protocol upload ('run.uploadProtocol'): it goes to
		// proxy.ts's multipart path, which on Vercel is the same `upload_protocol`
		// bridge job the queue always used — never JSON-stringified into kind:'http'.
		post: (path, body, opts) =>
			typeof FormData !== 'undefined' && body instanceof FormData
				? robotPostMultipart(robot as any, path, body, opts)
				: robotPost(robot as any, path, body, opts),
		delete: (path) => robotDelete(robot as any, path)
	};
}

/**
 * Run a shared verb through the queue line and answer with the route's JSON.
 * The browser's tailnet line runs the same `runVerb` against the robot, so the
 * two lines return identical status + body for the same robot response. When
 * the verb has a BIMS half (audit, tip cursor), it is written here — the
 * tailnet line writes the same record via POST /direct-record.
 */
export async function verbResponse(
	robot: { _id?: unknown; ip: string; port?: number | null },
	verb: Ot2Verb,
	args: Record<string, unknown>,
	user?: { username: string }
): Promise<Response> {
	const r = await runVerb(serverTransport(robot), verb, args);
	if (r.status >= 500) console.error(`[API] ${verb} error:`, (r.body as any)?.message ?? (r.body as any)?.detail);
	const rec = maintenanceRecordFor(verb, args, r);
	if (rec) {
		if (!user) throw new Error(`${verb} records to BIMS and needs the acting user`);
		const extra = await applyMaintenanceRecord(String(robot._id), user.username, rec, 'queue');
		return json({ ...(r.body as object), ...extra }, { status: r.status });
	}
	return json(r.body, { status: r.status });
}
