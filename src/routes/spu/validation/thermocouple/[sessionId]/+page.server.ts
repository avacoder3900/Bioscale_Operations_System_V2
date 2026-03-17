import { error } from '@sveltejs/kit';
import { requirePermission } from '$lib/server/permissions';
import { connectDB, ValidationSession, GeneratedBarcode, User } from '$lib/server/db';
import type { PageServerLoad } from './$types';

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
			rawData: thermoResult.rawData ?? null,
			processedData: thermoResult.processedData ?? null,
			passed: thermoResult.passed ?? null,
			notes: thermoResult.notes ?? null,
			createdAt: thermoResult.createdAt?.toISOString?.() ?? session.createdAt?.toISOString?.() ?? new Date().toISOString()
		} : null
	};
};
