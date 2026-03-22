import { redirect } from '@sveltejs/kit';
import { connectDB, TestResult } from '$lib/server/db';
import { requirePermission } from '$lib/server/permissions';
import type { PageServerLoad } from './$types';

export const load: PageServerLoad = async ({ locals, url }) => {
	if (!locals.user) redirect(302, '/login');
	requirePermission(locals.user, 'testResult:read');

	await connectDB();

	const page = parseInt(url.searchParams.get('page') || '1');
	const limit = 50;
	const statusFilter = url.searchParams.get('status') || null;
	const deviceFilter = url.searchParams.get('deviceId') || null;

	const filter: any = {};
	if (statusFilter) filter.status = statusFilter;
	if (deviceFilter) filter.deviceId = deviceFilter;

	const [results, total] = await Promise.all([
		TestResult.find(filter, {
			// Exclude readings from list view for performance (can be large)
			readings: 0
		}).sort({ createdAt: -1 }).skip((page - 1) * limit).limit(limit).lean(),
		TestResult.countDocuments(filter)
	]);

	return {
		results: results.map((r: any) => ({
			id: r._id,
			dataFormatCode: r.dataFormatCode,
			cartridgeUuid: r.cartridgeUuid,
			assayId: r.assayId,
			deviceId: r.deviceId,
			startTime: r.startTime,
			duration: r.duration,
			numberOfReadings: r.numberOfReadings,
			baselineScans: r.baselineScans,
			testScans: r.testScans,
			status: r.status,
			processedAt: r.processedAt,
			createdAt: r.createdAt
		})),
		pagination: { page, limit, total, hasNext: page * limit < total, hasPrev: page > 1 },
		filters: { status: statusFilter, deviceId: deviceFilter }
	};
};

export const config = { maxDuration: 60 };
