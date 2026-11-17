/**
 * BIMS API v1 — check a cartridge. Contract: docs/BIMS-API-V1.md.
 *
 *   GET /api/v1/cartridges/{id}[?holderRef=h_…]
 *   Authorization: Bearer <app key>
 *
 * 200 { cartridgeId, usable, reason, state, assay, analyte, expiresOn, lot }
 * 404 { cartridgeId, usable: false, reason: 'not_found' }
 * Reads only; writes nothing but a rate-limit counter.
 */
import { requireApp } from '$lib/server/bims-api/auth';
import { guarded, optionalHolderRef, requireCartridgeId, respond } from '$lib/server/bims-api/http';
import { enforceRateLimit } from '$lib/server/bims-api/rate-limit';
import { checkCartridge } from '$lib/server/bims-api/service';
import { connectDB } from '$lib/server/db';
import type { RequestHandler } from './$types';

export const GET: RequestHandler = ({ request, params, url }) =>
	guarded('check', async () => {
		const app = requireApp(request);
		const id = requireCartridgeId(params.id);
		const holderRef = optionalHolderRef(url.searchParams.get('holderRef'));
		await connectDB();
		await enforceRateLimit('check', app, holderRef);
		const body = await checkCartridge(id, holderRef);
		return respond(body, body.reason === 'not_found' ? 404 : 200);
	});
