import { requirePermission } from '$lib/server/permissions';
import { connectDB, CartridgeRecord } from '$lib/server/db';
import { analyzeGroup } from '$lib/server/optical-analysis';
import type { PageServerLoad } from './$types';

// Multi-cartridge GROUP analysis. Reads a comma-separated `ids` query param, loads
// those cartridge_records, and derives the group F7/F3 stats on-read. Non-destructive:
// nothing is ever written back to the DB.
export const load: PageServerLoad = async ({ url, locals }) => {
	requirePermission(locals.user, 'cartridge:read');
	await connectDB();

	const ids = (url.searchParams.get('ids') ?? '')
		.split(',')
		.map((s) => s.trim())
		.filter(Boolean);

	if (ids.length === 0) {
		return { group: null, ids: [] as string[] };
	}

	const docs = await CartridgeRecord.find({ _id: { $in: ids } })
		.select('_id assayName status device rawData')
		.lean();

	const items = docs.map((d: any) => ({
		id: d._id,
		label: d._id, // cartridge_records _id IS the scanned barcode
		readings: d.rawData?.readings ?? []
	}));

	const group = analyzeGroup(items);

	return { group: JSON.parse(JSON.stringify(group)), ids };
};
