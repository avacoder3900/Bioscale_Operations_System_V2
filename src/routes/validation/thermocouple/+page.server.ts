import { requirePermission } from '$lib/server/permissions';
import { connectDB, ValidationSession, GeneratedBarcode, User } from '$lib/server/db';
import type { PageServerLoad } from './$types';

/**
 * Thermocouple Validation — the chronological run log.
 *
 * This route used to be the uploader; that moved to /validation/thermocouple/run
 * and this page now answers "what thermo runs have we done", newest first.
 * There are no server-side filters: the run list is small enough to read whole,
 * and the page's arrow toggle reverses the order client-side.
 */
export const load: PageServerLoad = async ({ locals }) => {
	requirePermission(locals.user, 'spu:read');
	await connectDB();

	const sessions = (await ValidationSession.find({ type: 'thermo' })
		.sort({ createdAt: -1 })
		.lean()) as any[];

	// Resolve barcodes — the THERMO-0000xx run numbers — for sessions that carry
	// a generated-barcode reference rather than an inline barcode string.
	const barcodeIds = sessions.map((s) => s.generatedBarcodeId).filter(Boolean);
	const barcodes = barcodeIds.length
		? ((await GeneratedBarcode.find({ _id: { $in: barcodeIds } }).lean()) as any[])
		: [];
	const barcodeMap = new Map(barcodes.map((b) => [b._id, b.barcode]));

	// Resolve usernames
	const userIds = [...new Set(sessions.map((s) => s.userId).filter(Boolean))];
	const users = userIds.length
		? ((await User.find({ _id: { $in: userIds } }, { username: 1 }).lean()) as any[])
		: [];
	const userMap = new Map(users.map((u) => [u._id, u.username]));

	// `sessions` is already every thermo session, so the counts come straight from
	// it — the old second full-collection query was only needed because the list
	// itself used to be filtered.
	const total = sessions.length;
	const passed = sessions.filter((s) => s.status === 'completed').length;
	const failed = sessions.filter((s) => s.status === 'failed').length;

	return {
		sessions: sessions.map((s: any) => {
			// Extract temp stats from the thermocouple result
			const thermoResult = s.results?.find((r: any) => r.testType === 'thermocouple');
			const stats = thermoResult?.processedData?.stats;

			return {
				id: s._id,
				status: s.status,
				passed: thermoResult?.passed ?? null,
				startedAt: s.startedAt?.toISOString?.() ?? null,
				completedAt: s.completedAt?.toISOString?.() ?? null,
				createdAt: s.createdAt?.toISOString?.() ?? new Date().toISOString(),
				spuUdi: s.spuUdi ?? null,
				spuId: s.spuId ?? null,
				runNumber: s.barcode ?? barcodeMap.get(s.generatedBarcodeId) ?? null,
				username: userMap.get(s.userId) ?? null,
				minTemp: stats?.min ?? null,
				maxTemp: stats?.max ?? null,
				avgTemp: stats?.average ?? null
			};
		}),
		stats: { total, passed, failed }
	};
};
