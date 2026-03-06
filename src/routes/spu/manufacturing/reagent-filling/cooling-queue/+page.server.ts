import { redirect } from '@sveltejs/kit';
import { connectDB, ReagentBatchRecord, ManufacturingSettings, CartridgeRecord } from '$lib/server/db';
import type { PageServerLoad } from './$types';

export const load: PageServerLoad = async ({ locals }) => {
	if (!locals.user) redirect(302, '/login');
	await connectDB();

	const [runs, settingsDoc, coolingCartridges] = await Promise.all([
		ReagentBatchRecord.find({
			status: 'completed',
			'topSeal.status': 'completed'
		}).sort({ 'topSeal.completionTime': -1 }).limit(20).lean(),
		ManufacturingSettings.findById('default').lean(),
		CartridgeRecord.find({ currentPhase: 'cooling' }).sort({ 'reagentFilling.completedAt': -1 }).lean()
	]);

	const requiredMinutes = (settingsDoc as any)?.reagentFilling?.minCoolingTimeMin ?? 30;
	const now = Date.now();

	return {
		queue: runs.map((r: any) => {
			const enteredAt = r.topSeal?.completionTime ? new Date(r.topSeal.completionTime) : null;
			const elapsed = enteredAt ? (now - enteredAt.getTime()) / 60000 : 0;
			const remaining = Math.max(0, requiredMinutes - elapsed);
			return {
				runId: r._id,
				robotName: r.robot?.name ?? null,
				assayTypeName: r.assayType?.name ?? null,
				enteredCoolingAt: enteredAt,
				requiredCoolingMinutes: requiredMinutes,
				remainingMinutes: Math.round(remaining),
				cartridgeCount: r.cartridgeCount ?? 0
			};
		}),
		cartridges: coolingCartridges.map((c: any): {
			id: string;
			barcode: string;
			lotNumber: string;
			coolingStartedAt: Date | null;
			coolingRequiredMin: number;
			isReady: boolean;
		} => {
			const startedAt = c.reagentFilling?.completedAt ? new Date(c.reagentFilling.completedAt) : null;
			const elapsedMin = startedAt ? (now - startedAt.getTime()) / 60000 : 0;
			return {
				id: c._id,
				barcode: c.barcode ?? '',
				lotNumber: c.lotNumber ?? '',
				coolingStartedAt: startedAt,
				coolingRequiredMin: requiredMinutes,
				isReady: elapsedMin >= requiredMinutes
			};
		})
	};
};
