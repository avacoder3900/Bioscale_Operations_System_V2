/**
 * BIMS API v1 — release a reader this holder holds. Contract: docs/BIMS-API-V1.md, "Readers".
 *
 *   POST /api/v1/readers/{serial}/unpair
 *   Authorization: Bearer <app key>
 *   Body: { "holderRef": "h_…" }
 *
 * 200 { ok: true, status: 'unpaired' | 'not_paired' }
 * 404 { ok: false, reason: 'not_found' }  |  409 { ok: false, reason: 'held_by_other' }
 * Removes spus.holder; one journal entry and one audit_log row.
 */
import { requireApp } from '$lib/server/bims-api/auth';
import { guarded, readHolderRefBody, requireReaderSerial, respond } from '$lib/server/bims-api/http';
import { enforceRateLimit } from '$lib/server/bims-api/rate-limit';
import { unpairReader } from '$lib/server/bims-api/readers';
import { connectDB } from '$lib/server/db';
import type { RequestHandler } from './$types';

export const POST: RequestHandler = ({ request, params }) =>
	guarded('reader_unpair', async () => {
		const app = requireApp(request);
		const serial = requireReaderSerial(params.serial);
		const holderRef = await readHolderRefBody(request);
		await connectDB();
		await enforceRateLimit('reader_unpair', app, holderRef);
		const outcome = await unpairReader(serial, holderRef, app);
		if (!outcome.ok) return respond(outcome, outcome.reason === 'not_found' ? 404 : 409);
		return respond(outcome);
	});
