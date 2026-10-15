/**
 * Consumer API — claim a cartridge for an account.
 *
 *   POST /api/consumer/claims
 *   Header: x-consumer-api-key
 *   Body: {
 *     cartridgeId: string,
 *     accountId: string,          // app_users._id
 *     accountLabel: string,       // sign-in email, for audit display
 *     customerIds?: string[],     // the account's active customer links
 *     customerId?: string,        // clinic claim: claim under this customer
 *     subjectId?: string          // clinic claim: the patient (omit = unassigned)
 *   }
 *
 * 201 { ok: true, row }  |  409/400 { ok: false, reason, reasonText }
 */
import { json } from '@sveltejs/kit';
import { requireConsumerApiKey } from '$lib/server/consumer/api-auth';
import { optionalString, readJson, requireCartridgeId, requireString, stringArray } from '$lib/server/consumer/http';
import { claimCartridge, type ClaimReason } from '$lib/server/consumer/ownership';
import { connectDB } from '$lib/server/db';
import type { RequestHandler } from './$types';

const STATUS: Record<ClaimReason, number> = {
	not_found: 404, voided: 409, qc_cartridge: 409, research: 409,
	already_owned: 409, guessable_id_needs_match: 403, rate_limited: 429
};

export const POST: RequestHandler = async ({ request }) => {
	requireConsumerApiKey(request);
	const body = await readJson(request);
	const input = {
		cartridgeId: requireCartridgeId(requireString(body, 'cartridgeId')),
		accountId: requireString(body, 'accountId'),
		accountLabel: requireString(body, 'accountLabel'),
		customerIds: stringArray(body, 'customerIds'),
		customerId: optionalString(body, 'customerId'),
		subjectId: optionalString(body, 'subjectId')
	};
	await connectDB();
	const outcome = await claimCartridge(input);
	if (!outcome.ok) return json(outcome, { status: STATUS[outcome.reason] });
	return json(outcome, { status: 201 });
};
