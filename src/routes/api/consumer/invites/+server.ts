/**
 * Consumer API — a clinic admin invites a colleague from inside the app.
 *
 *   POST /api/consumer/invites
 *   Body: { customerId, email, role: 'admin' | 'staff', accountId, accountLabel }
 *
 * The acting account must hold the `admin` role on that customer. BIMS stores
 * only the token's hash and returns the token once; the app sends the email.
 *
 *   GET /api/consumer/invites?customerId=…&accountId=…
 *   Pending invites for a customer the account administers.
 */
import { json, error } from '@sveltejs/kit';
import { requireConsumerApiKey } from '$lib/server/consumer/api-auth';
import { readJson, requireString } from '$lib/server/consumer/http';
import { createInvite, isCustomerAdmin } from '$lib/server/consumer/ownership';
import { ConsumerInvite, connectDB } from '$lib/server/db';
import type { RequestHandler } from './$types';

const ROLES = new Set(['admin', 'staff']);

export const POST: RequestHandler = async ({ request }) => {
	requireConsumerApiKey(request);
	const body = await readJson(request);
	const customerId = requireString(body, 'customerId');
	const email = requireString(body, 'email');
	const role = requireString(body, 'role');
	const accountId = requireString(body, 'accountId');
	const accountLabel = requireString(body, 'accountLabel');
	if (!ROLES.has(role)) throw error(400, 'role must be admin or staff');
	await connectDB();
	if (!(await isCustomerAdmin(accountId, customerId))) throw error(403, 'Not an admin of this customer');
	const invite = await createInvite({
		customerId, email, role: role as 'admin' | 'staff',
		actor: { kind: 'account', id: accountId, label: accountLabel }
	});
	return json({ ok: true, ...invite }, { status: 201 });
};

export const GET: RequestHandler = async ({ request, url }) => {
	requireConsumerApiKey(request);
	const customerId = url.searchParams.get('customerId')?.trim() ?? '';
	const accountId = url.searchParams.get('accountId')?.trim() ?? '';
	if (!customerId || !accountId) throw error(400, 'customerId and accountId are required');
	await connectDB();
	if (!(await isCustomerAdmin(accountId, customerId))) throw error(403, 'Not an admin of this customer');
	const invites = await ConsumerInvite.find({ customerId, status: 'pending' })
		.select('email role expiresAt createdAt').sort({ createdAt: -1 }).lean();
	return json({ invites: JSON.parse(JSON.stringify(invites)) });
};
