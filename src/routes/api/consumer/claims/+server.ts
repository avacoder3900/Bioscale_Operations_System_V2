/**
 * Consumer API — link a scanned cartridge to an app account (the first step
 * of "start a new test" in the app, 2026-10-19).
 *
 *   POST /api/consumer/claims
 *   Header: x-consumer-api-key
 *   Body: {
 *     cartridgeId: string,
 *     accountId: string,          // app_users._id
 *     accountLabel: string,       // sign-in email, for audit display
 *     customerIds?: string[],     // the account's active customer links
 *     overwrite?: boolean         // the person confirmed taking it from another account
 *   }
 *
 * 200 { ok: true, status: 'already_yours' }  |  201 { ok: true, status: 'linked' | 'overwritten' }
 * 409 { ok: false, reason: 'owned_by_other' } → the app asks, then retries with overwrite: true
 * 404/409/403 { ok: false, reason, reasonText } for every other refusal
 */
import { json } from '@sveltejs/kit';
import { requireConsumerApiKey } from '$lib/server/consumer/api-auth';
import { readJson, requireCartridgeId, requireString, stringArray } from '$lib/server/consumer/http';
import { claimForAccount, type AppClaimReason } from '$lib/server/consumer/ownership';
import { connectDB } from '$lib/server/db';
import type { RequestHandler } from './$types';

const STATUS: Record<AppClaimReason, number> = {
	not_found: 404, voided: 409, qc_cartridge: 409, research: 409,
	owned_by_other: 409, has_results: 409, guessable_id_needs_match: 403
};

export const POST: RequestHandler = async ({ request }) => {
	requireConsumerApiKey(request);
	const body = await readJson(request);
	const input = {
		cartridgeId: requireCartridgeId(requireString(body, 'cartridgeId')),
		accountId: requireString(body, 'accountId'),
		accountLabel: requireString(body, 'accountLabel'),
		customerIds: stringArray(body, 'customerIds'),
		overwrite: body.overwrite === true
	};
	await connectDB();
	const outcome = await claimForAccount(input);
	if (!outcome.ok) return json(outcome, { status: STATUS[outcome.reason] });
	return json(outcome, { status: outcome.status === 'already_yours' ? 200 : 201 });
};
