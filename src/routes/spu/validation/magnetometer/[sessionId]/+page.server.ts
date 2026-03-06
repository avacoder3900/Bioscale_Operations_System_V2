import { error } from '@sveltejs/kit';
import { requirePermission } from '$lib/server/permissions';
import { connectDB, ValidationSession, User, generateId } from '$lib/server/db';
import { getVariable } from '$lib/server/particle';
import type { Actions, PageServerLoad } from './$types';

export const load: PageServerLoad = async ({ locals, params }) => {
	requirePermission(locals.user, 'spu:read');
	await connectDB();

	const session = await ValidationSession.findById(params.sessionId).lean() as any;
	if (!session) error(404, 'Session not found');

	const user = session.userId ? await User.findById(session.userId, { username: 1 }).lean() as any : null;

	return {
		session: {
			id: session._id,
			status: session.status,
			startedAt: session.startedAt?.toISOString() ?? null,
			completedAt: session.completedAt?.toISOString() ?? null,
			barcode: session.barcode ?? null,
			username: user?.username ?? null,
			spuUdi: session.spuUdi ?? null,
			spuId: session.spuId ?? null,
			particleDeviceId: session.particleDeviceId ?? null,
			criteriaUsed: session.criteriaUsed ?? null,
			deviceTimestamp: session.deviceTimestamp ?? null
		},
		result: session.magResults ? {
			id: session._id,
			testType: 'magnetometer',
			rawData: session.rawData ?? null,
			processedData: {
				metrics: session.magResults,
				interpretation: session.overallPassed ? 'All Z values within acceptable range' : 'One or more Z values outside acceptable range',
				failureReasons: session.failureReasons ?? []
			},
			passed: session.overallPassed ?? null,
			notes: null,
			createdAt: session.completedAt?.toISOString() ?? session.createdAt?.toISOString() ?? new Date().toISOString()
		} : null
	};
};

export const actions: Actions = {
	readResults: async ({ locals, params }) => {
		requirePermission(locals.user, 'spu:write');
		await connectDB();

		const session = await ValidationSession.findById(params.sessionId) as any;
		if (!session) return { error: 'Session not found' };
		if (!session.particleDeviceId) return { error: 'No device linked to this session' };

		try {
			const varData = await getVariable(session.particleDeviceId, 'magnet_validation');
			const rawResult = varData.result;
			if (!rawResult || typeof rawResult !== 'string') {
				return { error: 'No magnet_validation data available on device' };
			}

			// Use shared module for parsing + evaluation
			const { parseMagValidation, evaluateCriteria, extractTimestamp } = await import('$lib/server/particle-validation');
			const parsed = parseMagValidation(rawResult);

			// Get criteria
			const { Integration } = await import('$lib/server/db');
			const criteria = await Integration.findOne({ type: 'mag_criteria' }).lean() as any;
			const minZ = criteria?.minZ ?? 3900;
			const maxZ = criteria?.maxZ ?? 4500;

			const { overallPassed, failureReasons } = evaluateCriteria(parsed, minZ, maxZ);
			const deviceTimestamp = extractTimestamp(rawResult);

			await ValidationSession.updateOne(
				{ _id: params.sessionId },
				{
					$set: {
						status: overallPassed ? 'completed' : 'failed',
						completedAt: new Date(),
						rawData: rawResult,
						magResults: parsed,
						overallPassed,
						failureReasons,
						criteriaUsed: { minZ, maxZ },
						...(deviceTimestamp ? { deviceTimestamp } : {})
					}
				}
			);

			return { success: true, overallPassed };
		} catch (err) {
			return { error: `Failed to read device: ${err instanceof Error ? err.message : String(err)}` };
		}
	}
};
