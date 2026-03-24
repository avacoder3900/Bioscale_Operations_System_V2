import { error } from '@sveltejs/kit';
import { connectDB, ValidationSession } from '$lib/server/db';
import type { PageServerLoad } from './$types';

export const load: PageServerLoad = async ({ params }) => {
	try {
		await connectDB();
		const session = await ValidationSession.findById(params.sessionId).lean() as any;
		if (!session) error(404, 'Session not found');

		const result = (session.results ?? [])[0] as any | undefined;

		return {
			session: {
				id: String(session._id),
				status: session.status ?? 'pending',
				startedAt: session.startedAt?.toISOString?.() ?? null,
				completedAt: session.completedAt?.toISOString?.() ?? null,
				barcode: session.barcode ?? null,
				username: session.userId ?? null
			},
			result: result ? {
				id: String(result._id),
				testType: result.testType ?? 'thermocouple',
				rawData: result.rawData ?? null,
				processedData: result.processedData ?? null,
				passed: result.passed ?? null,
				notes: result.notes ?? null,
				createdAt: result.createdAt?.toISOString?.() ?? new Date().toISOString()
			} : null
		};
	} catch (err: any) {
		if (err.status === 404) throw err;
		error(500, 'Failed to load session');
	}
};

export const config = { maxDuration: 60 };
