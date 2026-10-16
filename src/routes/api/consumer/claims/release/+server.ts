/**
 * Consumer API — release a cartridge from an account ("remove from my tests").
 *
 *   POST /api/consumer/claims/release
 *   Body: { cartridgeId, accountId, accountLabel, customerIds?: string[], note?: string }
 *
 * The account may only release rows it can see: its own, or one scoped to a
 * customer it belongs to. The row is closed, never deleted.
 */
import { json } from '@sveltejs/kit';
import { requireConsumerApiKey } from '$lib/server/consumer/api-auth';
import { optionalString, readJson, requireCartridgeId, requireString, stringArray } from '$lib/server/consumer/http';
import { releaseOwnership } from '$lib/server/consumer/ownership';
import { connectDB } from '$lib/server/db';
import type { RequestHandler } from './$types';

export const POST: RequestHandler = async ({ request }) => {
	requireConsumerApiKey(request);
	const body = await readJson(request);
	const cartridgeId = requireCartridgeId(requireString(body, 'cartridgeId'));
	const accountId = requireString(body, 'accountId');
	const accountLabel = requireString(body, 'accountLabel');
	const customerIds = stringArray(body, 'customerIds');
	const note = optionalString(body, 'note', 500);
	await connectDB();
	const outcome = await releaseOwnership({
		cartridgeId, reason: 'user', note,
		actor: { kind: 'account', id: accountId, label: accountLabel },
		scope: { accountId, customerIds }
	});
	if (!outcome.ok) return json(outcome, { status: outcome.reason === 'not_found' ? 404 : 403 });
	return json(outcome);
};
