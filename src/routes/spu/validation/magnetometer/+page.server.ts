import { fail } from '@sveltejs/kit';
import { requirePermission } from '$lib/server/permissions';
import { connectDB, ValidationSession, Spu, Integration } from '$lib/server/db';
import type { Actions, PageServerLoad } from './$types';

export const load: PageServerLoad = async ({ locals }) => {
	requirePermission(locals.user, 'spu:read');
	await connectDB();

	// 1. Get all SPUs with particle links
	const spus = await Spu.find(
		{ 'particleLink.particleDeviceId': { $exists: true, $ne: null } },
		{ udi: 1, 'particleLink.particleDeviceId': 1, status: 1 }
	).sort({ udi: 1 }).lean() as any[];

	const spuIds = spus.map(s => s._id);

	// 2. Get latest ValidationSession per SPU + total count per SPU
	const sessionAgg = await ValidationSession.aggregate([
		{ $match: { type: 'mag', spuId: { $in: spuIds } } },
		{ $sort: { createdAt: -1 } },
		{
			$group: {
				_id: '$spuId',
				latestSession: { $first: '$$ROOT' },
				totalCount: { $sum: 1 }
			}
		}
	]);

	// Build lookup map: spuId → { latestSession, totalCount }
	const sessionMap = new Map<string, { latestSession: any; totalCount: number }>();
	for (const agg of sessionAgg) {
		sessionMap.set(agg._id, { latestSession: agg.latestSession, totalCount: agg.totalCount });
	}

	// 3. Build SPU dashboard cards
	const spuCards = spus.map(spu => {
		const entry = sessionMap.get(spu._id);
		const latest = entry?.latestSession ?? null;
		let sortOrder = 1; // default: UNTESTED

		if (latest) {
			if (latest.overallPassed === false) sortOrder = 0; // FAIL first
			else if (latest.overallPassed === true) sortOrder = 2; // PASS last
		}

		return {
			id: spu._id,
			udi: spu.udi,
			particleDeviceId: spu.particleLink?.particleDeviceId ?? null,
			status: spu.status,
			latestTest: latest
				? {
						id: latest._id,
						overallPassed: latest.overallPassed ?? null,
						status: latest.status,
						createdAt: latest.createdAt?.toISOString() ?? null,
						completedAt: latest.completedAt?.toISOString() ?? null
					}
				: null,
			totalTests: entry?.totalCount ?? 0,
			sortOrder
		};
	});

	// Sort: FAIL(0) → UNTESTED(1) → PASS(2)
	spuCards.sort((a, b) => a.sortOrder - b.sortOrder);

	// 4. Stats
	const allSessions = sessionAgg.flatMap(a => [a.latestSession]);
	const totalTestsAll = sessionAgg.reduce((sum, a) => sum + a.totalCount, 0);
	const passedSpus = sessionAgg.filter(a => a.latestSession.overallPassed === true).length;
	const failedSpus = sessionAgg.filter(a => a.latestSession.overallPassed === false).length;
	const untestedSpus = spus.length - sessionAgg.length;

	// 5. Get criteria
	const criteria = await Integration.findOne({ type: 'mag_criteria' }).lean() as any;

	return {
		spuCards,
		stats: {
			totalSpus: spus.length,
			totalTests: totalTestsAll,
			passedSpus,
			failedSpus,
			untestedSpus
		},
		criteria: {
			minZ: criteria?.minZ ?? 3900,
			maxZ: criteria?.maxZ ?? 4500
		}
	};
};

export const actions: Actions = {
	updateCriteria: async ({ request, locals }) => {
		requirePermission(locals.user, 'spu:write');
		await connectDB();

		const form = await request.formData();
		const minZ = parseFloat(form.get('minZ')?.toString() ?? '3900');
		const maxZ = parseFloat(form.get('maxZ')?.toString() ?? '4500');

		if (isNaN(minZ) || isNaN(maxZ) || minZ >= maxZ) {
			return fail(400, { error: 'Invalid criteria range' });
		}

		await Integration.updateOne(
			{ type: 'mag_criteria' },
			{ $set: { type: 'mag_criteria', minZ, maxZ, updatedAt: new Date() } },
			{ upsert: true }
		);

		return { criteriaUpdated: true };
	}
};
