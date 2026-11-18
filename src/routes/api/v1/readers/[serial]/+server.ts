/**
 * BIMS API v1 — a reader this holder holds. Contract: docs/BIMS-API-V1.md, "Readers".
 *
 *   GET /api/v1/readers/{serial}?holderRef=h_…
 *   Authorization: Bearer <app key>
 *
 * 200 { serial, online, firmware, wifiSupported, since }
 * 404 { reason: 'not_found' } when the reader does not exist or another holder (or none) holds it.
 * Reads only; writes nothing but a rate-limit counter.
 */
import { requireApp } from '$lib/server/bims-api/auth';
import { guarded, requireHolderRef, requireReaderSerial, respond } from '$lib/server/bims-api/http';
import { enforceRateLimit } from '$lib/server/bims-api/rate-limit';
import { heldReader, readerView } from '$lib/server/bims-api/readers';
import { connectDB } from '$lib/server/db';
import type { RequestHandler } from './$types';

export const GET: RequestHandler = ({ request, params, url }) =>
	guarded('reader_get', async () => {
		const app = requireApp(request);
		const serial = requireReaderSerial(params.serial);
		const holderRef = requireHolderRef(url.searchParams.get('holderRef'));
		await connectDB();
		await enforceRateLimit('reader_get', app, holderRef);
		const doc = await heldReader(serial, holderRef);
		return doc ? respond(await readerView(doc)) : respond({ reason: 'not_found' }, 404);
	});
