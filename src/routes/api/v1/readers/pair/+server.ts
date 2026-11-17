/**
 * BIMS API v1 — pair a reader with a holder. Contract: docs/BIMS-API-V1.md, "Readers".
 *
 *   POST /api/v1/readers/pair
 *   Authorization: Bearer <app key>
 *   Body: { "holderRef": "h_…", "code": "<scanned or typed>" }
 *
 * 201 { ok: true, status: 'paired', reader }  |  200 { ok: true, status: 'already', reader }
 * 404 { ok: false, reason: 'not_found' }  |  409 { ok: false, reason: 'held_by_other' | 'not_available' }
 * Writes spus.holder, one journal entry and one audit_log row.
 */
import { requireApp } from '$lib/server/bims-api/auth';
import { ApiError, guarded, readJsonBody, requireHolderRef, respond } from '$lib/server/bims-api/http';
import { enforceRateLimit } from '$lib/server/bims-api/rate-limit';
import { MAX_CODE_LENGTH, codeValues } from '$lib/server/bims-api/reader-rules';
import { pairReader } from '$lib/server/bims-api/readers';
import { connectDB } from '$lib/server/db';
import type { RequestHandler } from './$types';

export const POST: RequestHandler = ({ request }) =>
	guarded('reader_pair', async () => {
		const app = requireApp(request);
		const body = await readJsonBody(request, ['holderRef', 'code'], 'Only holderRef and code are accepted in the body');
		const holderRef = requireHolderRef(body.holderRef);
		const values = codeValues(body.code);
		if (!values) throw new ApiError(400, `code is required (at most ${MAX_CODE_LENGTH} characters)`);
		await connectDB();
		await enforceRateLimit('reader_pair', app, holderRef);
		const outcome = await pairReader(values, holderRef, app);
		if (!outcome.ok) return respond(outcome, outcome.reason === 'not_found' ? 404 : 409);
		return respond(outcome, outcome.status === 'paired' ? 201 : 200);
	});
