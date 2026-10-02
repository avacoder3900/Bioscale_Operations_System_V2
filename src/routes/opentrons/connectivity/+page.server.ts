/**
 * Fleet connectivity (OT2-TAILNET-4) — the test-environment view.
 * For every active robot: which line BIMS uses (and why), whether this
 * deployment allows the tailnet, bridge heartbeat age, and the direct-call
 * trace. The page itself probes each tailnet robot FROM THIS BROWSER, because
 * only the browser can tell whether its computer is on the tailnet.
 */
import { redirect } from '@sveltejs/kit';
import { connectDB, OpentronsRobot, Ot2DirectCall } from '$lib/server/db';
import { hasPermission, requirePermission } from '$lib/server/permissions';
import { getRobotsHealth } from '$lib/server/opentrons/health';
import { resolveRobotConnection, tailnetAllowedHere, tailnetRobotTokens } from '$lib/server/opentrons/connection';
import { bridgeJobGate, bridgeTokenSecret } from '$lib/server/opentrons/bridge-token';
import type { PageServerLoad } from './$types';

export const load: PageServerLoad = async ({ locals }) => {
	if (!locals.user) redirect(302, '/login');
	requirePermission(locals.user, 'manufacturing:read');
	await connectDB();

	const robots = (await OpentronsRobot.find({ isActive: { $ne: false } })
		.select('name robotSerial legacyRobotId connection')
		.sort({ name: 1 })
		.lean()) as any[];

	const since = new Date(Date.now() - 24 * 3600 * 1000);
	const [health, stats, recent] = await Promise.all([
		getRobotsHealth(robots.map((r) => ({ _id: String(r._id), name: r.name }))),
		Ot2DirectCall.aggregate([
			{ $match: { at: { $gte: since } } },
			{
				$group: {
					_id: '$robotId',
					calls: { $sum: 1 },
					errors: { $sum: { $cond: ['$ok', 0, 1] } },
					avgLatencyMs: { $avg: '$latencyMs' },
					last: { $max: '$at' }
				}
			}
		]),
		Ot2DirectCall.find({})
			.sort({ at: -1 })
			.limit(25)
			.select('robotId verb method path status ok latencyMs error username at')
			.lean()
	]);
	const statsBy = new Map(stats.map((s: any) => [String(s._id), s]));
	const nameBy = new Map(robots.map((r) => [String(r._id), r.name]));

	return {
		deploymentTokens: [...tailnetRobotTokens()],
		// Daemon column (OT2-TAILNET-5 §8): the page may ask for a health-only
		// /bridge token (manufacturing:write, audit-logged) to read the daemon's
		// version; without one it still shows whether /bridge is served.
		bridge: {
			secretSet: bridgeTokenSecret() !== null,
			canMintTokens: hasPermission(locals.user, 'manufacturing:write')
		},
		robots: robots.map((r) => {
			const id = String(r._id);
			const eff = resolveRobotConnection(r);
			const s = statsBy.get(id) as any;
			const h = health[id];
			return {
				robotId: id,
				name: r.name ?? id,
				mode: r.connection?.mode ?? 'queue',
				directUrl: r.connection?.directUrl ?? null,
				tailnetHostname: r.connection?.tailnetHostname ?? null,
				allowedHere: tailnetAllowedHere(r),
				transport: eff.transport,
				reason: eff.reason,
				// true = the bridge-token route would mint for this robot here.
				bridgeJobsHere: bridgeJobGate(r).ok,
				bridge: h ? { status: h.status, label: h.label, lastBeatMsAgo: h.lastBeatMsAgo } : null,
				calls24h: s ? { calls: s.calls, errors: s.errors, avgLatencyMs: Math.round(s.avgLatencyMs ?? 0), last: s.last } : null
			};
		}),
		recent: JSON.parse(JSON.stringify(recent)).map((c: any) => ({ ...c, robotName: nameBy.get(c.robotId) ?? c.robotId }))
	};
};
