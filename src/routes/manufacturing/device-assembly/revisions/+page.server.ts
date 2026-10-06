import { connectDB } from '$lib/server/db/connection';
import { requirePermission } from '$lib/server/permissions';
import { getDeviceAssemblyWI } from '$lib/server/services/device-assembly-wi';
import { getRecentPulls } from '$lib/server/services/device-assembly-wi-pulls';
import type { PageServerLoad } from './$types';

export const load: PageServerLoad = async ({ locals }) => {
	requirePermission(locals.user, 'manufacturing:read');
	await connectDB();
	const wi = await getDeviceAssemblyWI();
	const revisions = wi ? [...wi.revisions].sort((a: any, b: any) => b.version - a.version) : [];
	const pulls = wi ? await getRecentPulls(wi._id, 500) : [];
	return {
		wi: wi ? { _id: wi._id, documentNumber: wi.documentNumber, title: wi.title, currentVersion: wi.currentVersion, lastChangedBy: wi.lastChangedBy, lastChangedAt: wi.lastChangedAt } : null,
		revisions,
		pulls
	};
};
