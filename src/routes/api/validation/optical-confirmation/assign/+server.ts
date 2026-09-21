import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { connectDB } from '$lib/server/db';
import { requirePermission } from '$lib/server/permissions';
import { assignOpticalCartridges } from '$lib/server/optical-assign';

// Assign an assay as optical-confirmation validation cartridges. The logic
// lives in $lib/server/optical-assign.ts (shared with scripts); see it for the
// BCODE-snapshot and manufacturing-cartridge adoption rules.
//
// Body: { assayId, barcodes?: string[], count?: number, groupName?: string, notes?: string }
export const POST: RequestHandler = async ({ request, locals }) => {
	if (!locals.user) return json({ error: 'Unauthorized' }, { status: 401 });
	requirePermission(locals.user, 'cartridge:write');
	await connectDB();

	try {
		const body = await request.json();
		const result = await assignOpticalCartridges({
			assayId: (body.assayId ?? '').toString(),
			barcodes: Array.isArray(body.barcodes) ? body.barcodes.map((b: unknown) => String(b)) : undefined,
			count: body.count,
			groupName: body.groupName,
			notes: body.notes,
			user: { _id: locals.user._id, username: locals.user.username }
		});
		if ('error' in result) return json({ error: result.error }, { status: result.status });
		return json(result);
	} catch (err) {
		// Surface the real failure to the operator instead of a generic 500.
		const message = err instanceof Error ? err.message : String(err);
		console.error('[optical assign] failed:', err);
		return json({ error: `Assign failed: ${message}` }, { status: 500 });
	}
};
