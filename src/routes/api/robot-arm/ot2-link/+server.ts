/**
 * The arm Pi's cable link to the OT-2 (2026-11-06).
 *
 *   GET /api/robot-arm/ot2-link            header x-api-key = agent key (or a logged-in user)
 *     → { link: ArmLinkView, calls: [...the Pi's last robot calls, ms each], events: [...the protocol's announcements] }
 *   GET /api/robot-arm/ot2-link?fresh=1    probe the Pi again instead of the 20 s cache
 *
 * Same read the Run tab makes for its link chip, plus the Pi's own journal
 * (GET /ot2/calls, GET /ot2/loop/events) so a slow handshake can be traced
 * hop by hop.
 */
import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { isAgentApiKey } from '$lib/server/api-auth';
import { connectDB, ArmWaxFillSettings, OpentronsRobot } from '$lib/server/db';
import { armLinkFor } from '$lib/server/ot2-arm-link';
import { robotArmFetchRaw } from '$lib/server/robot-arm-client';

export const GET: RequestHandler = async ({ request, url, locals }) => {
	if (!isAgentApiKey(request) && !locals.user) return json({ error: 'Unauthorized' }, { status: 401 });
	await connectDB();
	const settings = (await ArmWaxFillSettings.findById('default').select('robotId').lean()) as { robotId?: string } | null;
	const robot = settings?.robotId ? await OpentronsRobot.findById(settings.robotId).select('_id name').lean() : null;
	const link = await armLinkFor(robot as any, { fresh: url.searchParams.get('fresh') === '1' });
	const read = async (path: string) => {
		try {
			const r = await robotArmFetchRaw(path, { timeoutMs: 4000 });
			return r.ok ? JSON.parse(r.text) : { error: `robot-arm ${r.status}` };
		} catch (e) {
			return { error: e instanceof Error ? e.message : String(e) };
		}
	};
	const [calls, events] = link.status ? await Promise.all([read('/ot2/calls?limit=100'), read('/ot2/loop/events?limit=100')]) : [null, null];
	return json({ link, calls: calls?.calls ?? null, events: events?.events ?? null, error: calls?.error ?? events?.error ?? null }, { headers: { 'Cache-Control': 'no-store' } });
};
