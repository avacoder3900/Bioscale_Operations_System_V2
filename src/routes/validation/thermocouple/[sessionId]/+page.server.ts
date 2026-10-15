import { error, fail } from '@sveltejs/kit';
import { requirePermission } from '$lib/server/permissions';
import { connectDB, ValidationSession, GeneratedBarcode, User } from '$lib/server/db';
import { recordThermoVerdict } from '$lib/server/validation/thermo-upload';
import type { Actions, PageServerLoad } from './$types';

export const load: PageServerLoad = async ({ locals, params }) => {
	requirePermission(locals.user, 'spu:read');
	await connectDB();

	const session = await ValidationSession.findById(params.sessionId).lean() as any;
	if (!session) error(404, 'Session not found');

	// Resolve user
	const user = session.userId
		? await User.findById(session.userId, { username: 1 }).lean() as any
		: null;

	// Resolve barcode
	let barcode: string | null = session.barcode ?? null;
	if (!barcode && session.generatedBarcodeId) {
		const bc = await GeneratedBarcode.findById(session.generatedBarcodeId).lean() as any;
		barcode = bc?.barcode ?? null;
	}

	// Find the thermocouple result in the results array
	const thermoResult = session.results?.find((r: any) => r.testType === 'thermocouple') ?? null;

	// Build channel chart URLs if multi-channel data exists
	const channelCharts = thermoResult?.processedData?.channels
		? Object.keys(thermoResult.processedData.channels).map((ch: string) => ({
			channel: ch,
			url: `/api/validation/thermocouple/${session._id}/chart/${ch}`,
			stats: thermoResult.processedData.channels[ch]?.stats ?? null,
			passed: thermoResult.processedData.channels[ch]?.passed ?? null
		}))
		: null;

	// Per-probe series + statistics, paired by key. Sessions recorded before
	// two-channel parsing carry neither, and the page falls back to the single
	// combined series for those.
	const storedSeries: any[] = Array.isArray(thermoResult?.rawData?.channelSeries)
		? thermoResult.rawData.channelSeries
		: [];
	const storedStats: any[] = Array.isArray(thermoResult?.processedData?.channelStats)
		? thermoResult.processedData.channelStats
		: [];
	const channels = storedSeries.length > 1
		? storedSeries.map((s: any) => ({
			key: s.key,
			label: s.label ?? s.key,
			readings: Array.isArray(s.readings) ? s.readings : [],
			stats: storedStats.find((st: any) => st.key === s.key)?.stats ?? null
		}))
		: null;

	return {
		session: {
			id: session._id,
			status: session.status,
			startedAt: session.startedAt?.toISOString?.() ?? null,
			completedAt: session.completedAt?.toISOString?.() ?? null,
			barcode,
			username: user?.username ?? null
		},
		result: thermoResult ? {
			id: thermoResult._id,
			testType: thermoResult.testType,
			// `channelSeries` is dropped here: it is returned once, already
			// paired with its statistics, as `channels` below. Sending it inside
			// rawData as well would put every per-probe reading on the wire twice.
			rawData: thermoResult.rawData
				? (({ channelSeries, ...rest }: any) => rest)(thermoResult.rawData)
				: null,
			processedData: thermoResult.processedData ?? null,
			passed: thermoResult.passed ?? null,
			notes: thermoResult.notes ?? null,
			createdAt: thermoResult.createdAt?.toISOString?.() ?? session.createdAt?.toISOString?.() ?? new Date().toISOString()
		} : null,
		channelCharts,
		channels
	};
};

export const actions: Actions = {
	// The verdict, keyed on this session's id. Same call the uploader makes, so
	// a session judged here is indistinguishable from one judged at upload time.
	verdict: async ({ request, locals, params }) => {
		requirePermission(locals.user, 'spu:write');
		await connectDB();

		const form = await request.formData();
		const choice = form.get('outcome')?.toString();
		if (choice !== 'passed' && choice !== 'failed') {
			return fail(400, { error: 'Record a Pass or Fail verdict' });
		}

		const outcome = await recordThermoVerdict({
			sessionId: params.sessionId,
			verdict: choice,
			user: { _id: locals.user!._id, username: locals.user!.username }
		});
		if ('error' in outcome) return fail(400, { error: outcome.error });

		return { success: true, passed: outcome.passed };
	}
};
