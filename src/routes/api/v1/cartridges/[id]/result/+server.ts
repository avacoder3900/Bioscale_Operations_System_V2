/**
 * BIMS API v1 — a linked cartridge's run state and result. Contract: docs/BIMS-API-V1.md.
 *
 *   GET /api/v1/cartridges/{id}/result?holderRef=h_…
 *   Authorization: Bearer <app key>
 *
 * 200 { cartridgeId, state: 'linked' | 'running' | 'cancelled', startedAt[, detail] }
 * 200 { cartridgeId, state: 'completed', startedAt, completedAt, assay, result, provenance }
 * 404 { reason: 'not_found' } when the record does not exist or this holder did not link it.
 * Reads only; writes nothing but a rate-limit counter.
 */
import { requireApp } from '$lib/server/bims-api/auth';
import { guarded, requireCartridgeId, requireHolderRef, respond } from '$lib/server/bims-api/http';
import { enforceRateLimit } from '$lib/server/bims-api/rate-limit';
import { cartridgeResult } from '$lib/server/bims-api/service';
import { connectDB } from '$lib/server/db';
import type { RequestHandler } from './$types';

export const GET: RequestHandler = ({ request, params, url }) =>
	guarded('result', async () => {
		const app = requireApp(request);
		const id = requireCartridgeId(params.id);
		const holderRef = requireHolderRef(url.searchParams.get('holderRef'));
		await connectDB();
		await enforceRateLimit('result', app, holderRef);
		const body = await cartridgeResult(id, holderRef);
		return body ? respond(body) : respond({ reason: 'not_found' }, 404);
	});
