/**
 * Consumer API — assign a clinic-owned cartridge to a patient (or unassign).
 *
 *   POST /api/consumer/claims/assign
 *   Body: { cartridgeId, accountId, accountLabel, customerId, subjectId: string | null, customerIds: string[] }
 *
 * Only moves the subject on an OPEN row scoped to `customerId`, and only when
 * the acting account belongs to that customer. Moving a cartridge between
 * customers is a release followed by a new claim.
 */
import { json } from '@sveltejs/kit';
import { requireConsumerApiKey } from '$lib/server/consumer/api-auth';
import { optionalString, readJson, requireCartridgeId, requireString, stringArray } from '$lib/server/consumer/http';
import { assignSubject } from '$lib/server/consumer/ownership';
import { connectDB } from '$lib/server/db';
import type { RequestHandler } from './$types';

export const POST: RequestHandler = async ({ request }) => {
	requireConsumerApiKey(request);
	const body = await readJson(request);
	const input = {
		cartridgeId: requireCartridgeId(requireString(body, 'cartridgeId')),
		customerId: requireString(body, 'customerId'),
		subjectId: optionalString(body, 'subjectId'),
		customerIds: stringArray(body, 'customerIds'),
		actor: { kind: 'account' as const, id: requireString(body, 'accountId'), label: requireString(body, 'accountLabel') }
	};
	await connectDB();
	const outcome = await assignSubject(input);
	if (!outcome.ok) return json(outcome, { status: outcome.reason === 'not_found' ? 404 : 403 });
	return json(outcome);
};
