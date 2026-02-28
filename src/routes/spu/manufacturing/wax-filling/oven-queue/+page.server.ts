import { redirect } from '@sveltejs/kit';
import { connectDB, WaxFillingRun, ManufacturingSettings } from '$lib/server/db';
import type { PageServerLoad } from './$types';

export const load: PageServerLoad = async ({ locals }) => {
	if (!locals.user) redirect(302, '/login');
	await connectDB();

	const [runs, settingsDoc] = await Promise.all([
		WaxFillingRun.find({
			status: 'completed',
			ovenLocationId: { $exists: true, $ne: null }
		}).sort({ runEndTime: -1 }).lean(),
		ManufacturingSettings.findById('default').lean()
	]);

	const requiredMinutes = (settingsDoc as any)?.waxFilling?.minOvenTimeMin ?? 60;
	const now = Date.now();

	return {
		queue: runs.map((r: any) => {
			const enteredAt = r.runEndTime ? new Date(r.runEndTime) : null;
			const elapsed = enteredAt ? (now - enteredAt.getTime()) / 60000 : 0;
			const remaining = Math.max(0, requiredMinutes - elapsed);
			return {
				runId: r._id,
				robotName: r.robot?.name ?? null,
				assayTypeName: null,
				enteredOvenAt: enteredAt,
				requiredOvenMinutes: requiredMinutes,
				remainingMinutes: Math.round(remaining),
				cartridgeCount: r.cartridgeIds?.length ?? 0,
				ovenName: r.ovenLocationId ?? null
			};
		})
	};
};
