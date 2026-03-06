import { error, fail, redirect } from '@sveltejs/kit';
import { requirePermission } from '$lib/server/permissions';
import { connectDB, ValidationSession, Spu, Integration, generateId } from '$lib/server/db';
import { callFunction } from '$lib/server/particle';
import { readAndStoreIfNew } from '$lib/server/particle-validation';
import type { Actions, PageServerLoad } from './$types';

export const load: PageServerLoad = async ({ locals, params }) => {
	requirePermission(locals.user, 'spu:read');
	await connectDB();

	// 1. Find SPU
	const spu = await Spu.findById(params.spuId, {
		udi: 1,
		'particleLink.particleDeviceId': 1,
		status: 1
	}).lean() as any;

	if (!spu) error(404, 'SPU not found');

	// 2. Get all ValidationSessions for this SPU, newest first
	const sessions = await ValidationSession.find({ type: 'mag', spuId: params.spuId })
		.sort({ createdAt: -1 })
		.lean() as any[];

	// 3. Get criteria
	const criteria = await Integration.findOne({ type: 'mag_criteria' }).lean() as any;

	return {
		spu: {
			id: spu._id,
			udi: spu.udi,
			particleDeviceId: spu.particleLink?.particleDeviceId ?? null,
			status: spu.status
		},
		sessions: sessions.map(s => {
			const wellCount = Array.isArray(s.magResults) ? s.magResults.length : 0;
			const failCount = Array.isArray(s.failureReasons) ? s.failureReasons.length : 0;
			let summary = '—';
			if (s.overallPassed === true && wellCount > 0) summary = `${wellCount}/${wellCount} wells passed`;
			else if (s.overallPassed === false) summary = `${failCount} failure${failCount !== 1 ? 's' : ''}`;
			else if (s.status === 'running') summary = 'Test running…';

			return {
				id: s._id,
				overallPassed: s.overallPassed ?? null,
				status: s.status,
				createdAt: s.createdAt?.toISOString() ?? null,
				completedAt: s.completedAt?.toISOString() ?? null,
				deviceTimestamp: s.deviceTimestamp ?? null,
				summary
			};
		}),
		criteria: {
			minZ: criteria?.minZ ?? 3900,
			maxZ: criteria?.maxZ ?? 4500
		}
	};
};

export const actions: Actions = {
	readLatest: async ({ locals, params }) => {
		requirePermission(locals.user, 'spu:write');
		await connectDB();

		const spu = await Spu.findById(params.spuId, {
			'particleLink.particleDeviceId': 1
		}).lean() as any;

		if (!spu?.particleLink?.particleDeviceId) {
			return fail(400, { error: 'No Particle device linked to this SPU' });
		}

		const result = await readAndStoreIfNew(params.spuId, spu.particleLink.particleDeviceId);

		if (result.error) {
			return fail(400, { error: result.error });
		}

		return {
			newSession: result.newSession,
			message: result.message ?? (result.newSession ? 'New test result stored!' : 'No new test data.'),
			sessionId: result.sessionId ?? null,
			passed: result.passed ?? null
		};
	},

	runTest: async ({ locals, params }) => {
		requirePermission(locals.user, 'spu:write');
		await connectDB();

		const spu = await Spu.findById(params.spuId, {
			udi: 1,
			'particleLink.particleDeviceId': 1
		}).lean() as any;

		if (!spu) return fail(404, { error: 'SPU not found' });
		if (!spu.particleLink?.particleDeviceId) {
			return fail(400, { error: 'No Particle device linked to this SPU' });
		}

		const sessionId = generateId();

		// Create running session
		await ValidationSession.create({
			_id: sessionId,
			type: 'mag',
			status: 'running',
			startedAt: new Date(),
			userId: locals.user!._id,
			spuUdi: spu.udi,
			spuId: spu._id,
			particleDeviceId: spu.particleLink.particleDeviceId,
			results: []
		});

		// Call run_test on device
		try {
			await callFunction(spu.particleLink.particleDeviceId, 'run_test', 'mag');
		} catch (err) {
			await ValidationSession.updateOne(
				{ _id: sessionId },
				{
					$set: {
						status: 'failed',
						completedAt: new Date(),
						failureReasons: [`Device error: ${err instanceof Error ? err.message : String(err)}`]
					}
				}
			);
			return fail(400, { error: `Failed to trigger test: ${err instanceof Error ? err.message : String(err)}` });
		}

		redirect(303, `/spu/validation/magnetometer/${sessionId}`);
	}
};
