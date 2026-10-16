/**
 * Consumer API — cartridge lookup (the preview before a claim).
 *
 *   GET /api/consumer/cartridges/:id?accountId=<app_users._id>&customerIds=a,b
 *   Header: x-consumer-api-key
 *
 * Returns only what the app may show a person: assay, expiry, stage, whether
 * it is owned (never by whom), whether THEY own it, and whether a claim would
 * succeed. See docs/CONSUMER-OWNERSHIP.md.
 */
import { json } from '@sveltejs/kit';
import { requireConsumerApiKey } from '$lib/server/consumer/api-auth';
import { csv, requireCartridgeId } from '$lib/server/consumer/http';
import { lookupCartridge } from '$lib/server/consumer/ownership';
import { connectDB } from '$lib/server/db';
import type { RequestHandler } from './$types';

export const GET: RequestHandler = async ({ request, params, url }) => {
	requireConsumerApiKey(request);
	const cartridgeId = requireCartridgeId(params.id);
	const accountId = url.searchParams.get('accountId')?.trim() ?? '';
	const customerIds = csv(url.searchParams.get('customerIds'));
	await connectDB();
	const result = await lookupCartridge(cartridgeId, { accountId, customerIds });
	return json(result);
};
