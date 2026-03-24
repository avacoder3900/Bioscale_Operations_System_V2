import { redirect } from '@sveltejs/kit';
import { connectDB, OpentronsRobot } from '$lib/server/db';
import { requirePermission } from '$lib/server/permissions';
import type { PageServerLoad } from './$types';

export const load: PageServerLoad = async ({ locals }) => {
	if (!locals.user) redirect(302, '/login');
	requirePermission(locals.user, 'manufacturing:read');
	await connectDB();
	const robots = await OpentronsRobot.find().sort({ name: 1 }).lean();

	return {
		robots: robots.map((r: any) => ({
			robotId: r._id,
			name: r.name ?? '',
			ip: r.ip ?? '',
			port: r.port ?? 31950,
			robotSide: r.robotSide ?? null,
			robotModel: r.robotModel ?? 'OT-2',
			robotSerial: r.robotSerial ?? null,
			isActive: r.isActive ?? true,
			lastHealthOk: r.lastHealthOk ?? false,
			lastHealthAt: r.lastHealthAt ? new Date(r.lastHealthAt).toISOString() : null,
			source: r.source ?? 'manual'
		}))
	};
};

export const config = { maxDuration: 60 };
