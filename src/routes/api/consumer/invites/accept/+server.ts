/**
 * Consumer API — accept a customer invite for the signed-in app account.
 *
 *   POST /api/consumer/invites/accept
 *   Body: { token, accountId, email }     // email = the account's sign-in email
 *
 * 200 { ok: true, customerId, customerName, role }
 * 400 { ok: false, reason: 'invalid' | 'expired' | 'email_mismatch' }
 */
import { json } from '@sveltejs/kit';
import { requireConsumerApiKey } from '$lib/server/consumer/api-auth';
import { readJson, requireString } from '$lib/server/consumer/http';
import { acceptInvite } from '$lib/server/consumer/ownership';
import { connectDB } from '$lib/server/db';
import type { RequestHandler } from './$types';

export const POST: RequestHandler = async ({ request }) => {
	requireConsumerApiKey(request);
	const body = await readJson(request);
	const input = {
		token: requireString(body, 'token', 512),
		accountId: requireString(body, 'accountId'),
		email: requireString(body, 'email')
	};
	await connectDB();
	const outcome = await acceptInvite(input);
	return json(outcome, { status: outcome.ok ? 200 : 400 });
};
