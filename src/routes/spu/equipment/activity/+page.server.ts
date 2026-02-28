import { connectDB, AuditLog } from '$lib/server/db';
import type { PageServerLoad } from './$types';

export const load: PageServerLoad = async () => {
	await connectDB();
	const logs = await AuditLog.find({ tableName: 'equipment' })
		.sort({ changedAt: -1 })
		.limit(100)
		.lean();

	return {
		activities: logs.map((l: any) => ({
			id: l._id,
			equipmentId: l.recordId ?? null,
			equipmentName: l.newData?.name ?? l.oldData?.name ?? 'Unknown',
			activityType: l.action ?? null,
			description: l.reason ?? null,
			performedAt: l.changedAt ?? null,
			performedByUsername: l.changedBy ?? 'System',
			notes: null
		}))
	};
};
