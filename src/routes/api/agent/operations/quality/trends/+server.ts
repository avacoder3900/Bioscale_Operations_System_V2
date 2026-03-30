import { json } from '@sveltejs/kit';
import { requireAgentApiKey } from '$lib/server/api-auth';
import { connectDB, TestResult, CartridgeRecord, WaxFillingRun } from '$lib/server/db';
import type { RequestHandler } from './$types';

export const GET: RequestHandler = async ({ request }) => {
	requireAgentApiKey(request);
	await connectDB();

	const [totalTests, passedTests, failedTests, phaseCounts, recentWaxRuns] = await Promise.all([
		TestResult.countDocuments(),
		TestResult.countDocuments({ status: 'completed' }),
		TestResult.countDocuments({ status: 'failed' }),
		CartridgeRecord.aggregate([
			{ $group: { _id: '$status', count: { $sum: 1 } } }
		]),
		WaxFillingRun.find()
			.sort({ createdAt: -1 }).limit(20)
			.select('_id status plannedCartridgeCount cartridgeIds createdAt').lean()
	]);

	const byPhase: Record<string, number> = {};
	for (const p of phaseCounts) {
		if (p._id) byPhase[p._id] = p.count;
	}

	const passRate = totalTests > 0
		? parseFloat(((passedTests / totalTests) * 100).toFixed(1))
		: 0;

	const waxCompletionRates = (recentWaxRuns as any[]).map(r => ({
		id: r._id,
		status: r.status,
		planned: r.plannedCartridgeCount || 0,
		actual: r.cartridgeIds?.length || 0,
		completionRate: r.plannedCartridgeCount
			? parseFloat(((r.cartridgeIds?.length || 0) / r.plannedCartridgeCount * 100).toFixed(1))
			: 0,
		createdAt: r.createdAt
	}));

	return json({
		success: true,
		data: {
			testResults: { total: totalTests, passed: passedTests, failed: failedTests, passRate },
			cartridgePipeline: { byPhase },
			recentWaxRuns: waxCompletionRates
		}
	});
};
