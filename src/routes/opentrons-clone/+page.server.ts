import { requirePermission } from '$lib/server/permissions';
import { connectDB } from '$lib/server/db';
import { getRobotsHealth } from '$lib/server/opentrons/health';
import type { PageServerLoad } from './$types';

/**
 * The robot list comes from the layout gate. Health (OT2-TAILNET-5 §7.6):
 *   direct line  the page reads /health from this browser over Tailscale;
 *   queue line   the daemon heartbeat (Mongo) — never a /health poll through
 *                the queue, which would put two serial queue commands per robot
 *                every 15 s in front of real work on B07/R04.
 * The page re-runs just this load (invalidate('clone:heartbeat')) to refresh.
 */
export const load: PageServerLoad = async ({ locals, parent, depends }) => {
	requirePermission(locals.user, 'manufacturing:read');
	depends('clone:heartbeat');
	const { robots } = await parent();
	let heartbeat = {};
	if (robots.length) {
		await connectDB();
		heartbeat = await getRobotsHealth(robots.map((r) => ({ _id: String(r._id), name: r.name })));
	}
	return { robots, heartbeat: JSON.parse(JSON.stringify(heartbeat)) as Awaited<ReturnType<typeof getRobotsHealth>> };
};
