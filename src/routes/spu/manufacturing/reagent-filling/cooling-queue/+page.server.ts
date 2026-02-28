import { redirect } from '@sveltejs/kit';
import { connectDB, ReagentBatchRecord, ManufacturingSettings } from '$lib/server/db';
import type { PageServerLoad } from './$types';

export const load: PageServerLoad = async ({ locals }) => {
	if (!locals.user) redirect(302, '/login');
	await connectDB();

	const [runs, settingsDoc] = await Promise.all([
		ReagentBatchRecord.find({
			status: 'completed',
			'topSeal.status': 'completed'
		}).sort({ 'topSeal.completionTime': -1 }).limit(20).lean(),
		ManufacturingSettings.findById('default').lean()
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
		})
	};
};
