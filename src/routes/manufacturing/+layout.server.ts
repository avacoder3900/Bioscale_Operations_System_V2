import { redirect } from '@sveltejs/kit';
import { requirePermission, hasPermission } from '$lib/server/permissions';
import { connectDB, ProcessConfiguration } from '$lib/server/db';
import type { LayoutServerLoad } from './$types';

export const config = { maxDuration: 60 };

export const load: LayoutServerLoad = async ({ locals }) => {
	if (!locals.user) redirect(302, '/login');

	try {
		requirePermission(locals.user, 'manufacturing:read');
	} catch (e: unknown) {
		if (e && typeof e === 'object' && 'status' in e) throw e;
		console.error('[MFG LAYOUT] Permission check error:', e instanceof Error ? e.message : e);
	}

	await connectDB();
	let configs: any[] = [];
	try {
		configs = await ProcessConfiguration.find({}, { _id: 1, processName: 1, processType: 1 }).lean();
	} catch (e) {
		console.error('[MFG LAYOUT] DB error:', e instanceof Error ? e.message : e);
	}

	return {
		user: locals.user,
		isAdmin: hasPermission(locals.user, 'manufacturing:admin'),
		processConfigs: configs.map((c) => ({
			configId: String(c._id),
			processName: c.processName,
			processType: c.processType
		}))
	};
};
