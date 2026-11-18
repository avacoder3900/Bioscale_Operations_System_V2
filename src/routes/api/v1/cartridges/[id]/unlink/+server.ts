/**
 * BIMS API v1 — undo a link. Contract: docs/BIMS-API-V1.md.
 *
 *   POST /api/v1/cartridges/{id}/unlink
 *   Authorization: Bearer <app key>
 *   Body: { "holderRef": "h_…" }
 *
 * 200 { ok: true, status: 'unlinked', restoredStatus }  |  200 { ok: true, status: 'not_linked' }
 * 404 { ok: false, reason: 'not_found' }  |  409 { ok: false, reason: 'has_results' | 'linked_by_other' }
 * Restores status from priorStatus, clears priorStatus and checkpoints.linked, one audit_log row.
 */
import { requireApp } from '$lib/server/bims-api/auth';
import { guarded, readHolderRefBody, requireCartridgeId, respond } from '$lib/server/bims-api/http';
import { enforceRateLimit } from '$lib/server/bims-api/rate-limit';
import { unlinkCartridge } from '$lib/server/bims-api/service';
import { connectDB } from '$lib/server/db';
import type { RequestHandler } from './$types';

export const POST: RequestHandler = ({ request, params }) =>
	guarded('unlink', async () => {
		const app = requireApp(request);
		const id = requireCartridgeId(params.id);
		const holderRef = await readHolderRefBody(request);
		await connectDB();
		await enforceRateLimit('unlink', app, holderRef);
		const outcome = await unlinkCartridge(id, holderRef, app);
		if (!outcome.ok) return respond(outcome, outcome.reason === 'not_found' ? 404 : 409);
		return respond(outcome, 200);
	});
