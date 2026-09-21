import { json } from '@sveltejs/kit';
import { connectDB } from '$lib/server/db';
import { checkCartridgeScans, type ScanContext } from '$lib/server/manufacturing/cartridge-scan-check';
import type { RequestHandler } from './$types';

/** Hard ceiling — a deck is 24 slots; anything larger is a malformed client. */
const MAX_BATCH = 200;

/**
 * SCAN-THEN-CHECK batch validation.
 *
 * The deck grid accepts scans locally and calls this once at the deferred
 * boundary instead of hitting /api/dev/validate-equipment per scan.
 * Read-only: no writes, no audit entry. The commit path that follows is what
 * mutates and audits.
 */
export const POST: RequestHandler = async ({ request, locals }) => {
	if (!locals.user) return json({ error: 'Unauthorized' }, { status: 401 });

	let body: unknown;
	try {
		body = await request.json();
	} catch {
		return json({ error: 'Invalid JSON body' }, { status: 400 });
	}

	const { barcodes, context } = (body ?? {}) as { barcodes?: unknown; context?: unknown };

	if (!Array.isArray(barcodes)) {
		return json({ error: 'barcodes must be an array' }, { status: 400 });
	}
	if (barcodes.length > MAX_BATCH) {
		return json({ error: `Too many barcodes (max ${MAX_BATCH})` }, { status: 400 });
	}
	if (!barcodes.every((b) => typeof b === 'string')) {
		return json({ error: 'barcodes must be an array of strings' }, { status: 400 });
	}
	if (context !== undefined && context !== 'wax' && context !== 'reagent') {
		return json({ error: `Unknown context: ${String(context)}` }, { status: 400 });
	}

	await connectDB();
	const results = await checkCartridgeScans(barcodes as string[], (context as ScanContext) ?? 'wax');

	return json({
		results,
		allValid: results.every((r) => r.ok),
		failedCount: results.filter((r) => !r.ok).length
	});
};
