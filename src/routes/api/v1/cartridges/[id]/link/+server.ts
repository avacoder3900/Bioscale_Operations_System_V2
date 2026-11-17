/**
 * BIMS API v1 — link a cartridge to a holder. Contract: docs/BIMS-API-V1.md.
 *
 *   POST /api/v1/cartridges/{id}/link
 *   Authorization: Bearer <app key>
 *   Body: { "holderRef": "h_…" }
 *
 * 201 { ok: true, status: 'linked', linkedAt }  |  200 { ok: true, status: 'already' }
 * 404 { ok: false, reason: 'not_found' }  |  409 { ok: false, reason }
 * Writes status, statusUpdatedOn, priorStatus, checkpoints.linked and one audit_log row.
 */
import { requireApp } from '$lib/server/bims-api/auth';
import { guarded, readHolderRefBody, requireCartridgeId, respond } from '$lib/server/bims-api/http';
import { enforceRateLimit } from '$lib/server/bims-api/rate-limit';
import { linkCartridge } from '$lib/server/bims-api/service';
import { connectDB } from '$lib/server/db';
import type { RequestHandler } from './$types';

export const POST: RequestHandler = ({ request, params }) =>
	guarded('link', async () => {
		const app = requireApp(request);
		const id = requireCartridgeId(params.id);
		const holderRef = await readHolderRefBody(request);
		await connectDB();
		await enforceRateLimit('link', app, holderRef);
		const outcome = await linkCartridge(id, holderRef, app);
		if (!outcome.ok) return respond(outcome, outcome.reason === 'not_found' ? 404 : 409);
		return respond(outcome, outcome.status === 'linked' ? 201 : 200);
	});
