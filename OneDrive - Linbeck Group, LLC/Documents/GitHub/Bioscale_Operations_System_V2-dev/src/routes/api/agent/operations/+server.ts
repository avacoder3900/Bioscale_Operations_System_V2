import { json } from '@sveltejs/kit';
import { requireAgentApiKey } from '$lib/server/api-auth';
import {
	connectDB, CartridgeRecord, ProductionRun, LotRecord,
	ManufacturingMaterial, ShippingLot, ShippingPackage, TestResult
} from '$lib/server/db';
import type { RequestHandler } from './$types';

export const GET: RequestHandler = async ({ request, url }) => {
	requireAgentApiKey(request);
	await connectDB();

	const metric = url.searchParams.get('metric') || 'summary';

	if (metric === 'manufacturing') {
		const [activeRuns, totalCartridges, recentRuns] = await Promise.all([
			ProductionRun.countDocuments({ status: 'in_progress' }),
			CartridgeRecord.countDocuments(),
			ProductionRun.find().sort({ createdAt: -1 }).limit(10).lean()
		]);

		return json({
			success: true,
			data: {
				activeRuns,
				totalCartridges,
				recentRuns: recentRuns.map((r: any) => ({
					id: r._id, status: r.status, createdAt: r.createdAt
				}))
			}
		});
	}

	if (metric === 'inventory') {
		const materials = await ManufacturingMaterial.find().lean();
		return json({
			success: true,
			data: {
				materials: materials.map((m: any) => ({
					id: m._id,
					name: m.name,
					currentQuantity: m.currentQuantity,
					minimumQuantity: m.minimumQuantity,
					unit: m.unit,
					isLow: (m.currentQuantity ?? 0) <= (m.minimumQuantity ?? 0)
				}))
			}
		});
	}

	if (metric === 'quality') {
		const [totalTests, passedTests, failedTests, recentResults] = await Promise.all([
			TestResult.countDocuments(),
			TestResult.countDocuments({ status: 'completed' }),
			TestResult.countDocuments({ status: 'failed' }),
			TestResult.find().sort({ createdAt: -1 }).limit(10).select('_id status deviceId createdAt').lean()
		]);

		return json({
			success: true,
			data: {
				totalTests,
				passedTests,
				failedTests,
				passRate: totalTests > 0 ? ((passedTests / totalTests) * 100).toFixed(1) : '0',
				recentResults: recentResults.map((r: any) => ({
					id: r._id, status: r.status, deviceId: r.deviceId, createdAt: r.createdAt
				}))
			}
		});
	}

	if (metric === 'shipping') {
		const [openLots, shippedPackages, totalPackages] = await Promise.all([
			ShippingLot.countDocuments({ status: { $in: ['open', 'testing'] } }),
			ShippingPackage.countDocuments({ status: 'shipped' }),
			ShippingPackage.countDocuments()
		]);

		return json({
			success: true,
			data: { openLots, shippedPackages, totalPackages }
		});
	}

	// Default summary
	const [cartridgeCount, runCount, materialCount, lotCount] = await Promise.all([
		CartridgeRecord.countDocuments(),
		ProductionRun.countDocuments(),
		ManufacturingMaterial.countDocuments(),
		LotRecord.countDocuments()
	]);

	return json({
		success: true,
		data: {
			summary: {
				cartridges: cartridgeCount,
				productionRuns: runCount,
				materials: materialCount,
				lots: lotCount,
				timestamp: new Date().toISOString()
			}
		}
	});
};
