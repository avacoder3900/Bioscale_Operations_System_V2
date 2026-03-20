import { redirect, fail } from '@sveltejs/kit';
import { connectDB, OpentronsRobot, generateId } from '$lib/server/db';
import type { PageServerLoad, Actions } from './$types';

export const load: PageServerLoad = async ({ locals }) => {
	if (!locals.user) redirect(302, '/login');
	await connectDB();

	const robots = await OpentronsRobot.find({}).sort({ name: 1 }).lean();
	return {
		robots: (robots as any[]).map((r) => ({
			id: String(r._id),
			name: r.name ?? '',
			robotSide: r.robotSide ?? '',
			ipAddress: r.ipAddress ?? '',
			serialNumber: r.serialNumber ?? '',
			model: r.model ?? '',
			isActive: r.isActive ?? true,
			createdAt: r.createdAt ? new Date(r.createdAt).toISOString() : null,
			updatedAt: r.updatedAt ? new Date(r.updatedAt).toISOString() : null
		}))
	};
};

export const actions: Actions = {
	addRobot: async ({ request, locals }) => {
		if (!locals.user) redirect(302, '/login');
		await connectDB();

		const data = await request.formData();
		const name = data.get('name')?.toString()?.trim();
		if (!name) return fail(400, { error: 'Robot name is required' });

		await OpentronsRobot.create({
			_id: generateId(),
			name,
			robotSide: data.get('robotSide')?.toString() || undefined,
			ipAddress: data.get('ipAddress')?.toString() || undefined,
			serialNumber: data.get('serialNumber')?.toString() || undefined,
			model: data.get('model')?.toString() || 'OT-2',
			isActive: true
		});

		return { success: true };
	},

	updateRobot: async ({ request, locals }) => {
		if (!locals.user) redirect(302, '/login');
		await connectDB();

		const data = await request.formData();
		const robotId = data.get('robotId')?.toString();
		if (!robotId) return fail(400, { error: 'Robot ID required' });

		const name = data.get('name')?.toString()?.trim();
		if (!name) return fail(400, { error: 'Robot name is required' });

		await OpentronsRobot.findByIdAndUpdate(robotId, {
			$set: {
				name,
				robotSide: data.get('robotSide')?.toString() || undefined,
				ipAddress: data.get('ipAddress')?.toString() || undefined,
				serialNumber: data.get('serialNumber')?.toString() || undefined,
				model: data.get('model')?.toString() || undefined
			}
		});

		return { success: true };
	},

	toggleActive: async ({ request, locals }) => {
		if (!locals.user) redirect(302, '/login');
		await connectDB();

		const data = await request.formData();
		const robotId = data.get('robotId')?.toString();
		if (!robotId) return fail(400, { error: 'Robot ID required' });

		const robot = await OpentronsRobot.findById(robotId).lean() as any;
		if (!robot) return fail(404, { error: 'Robot not found' });

		await OpentronsRobot.findByIdAndUpdate(robotId, {
			$set: { isActive: !robot.isActive }
		});

		return { success: true };
	},

	deleteRobot: async ({ request, locals }) => {
		if (!locals.user) redirect(302, '/login');
		await connectDB();

		const data = await request.formData();
		const robotId = data.get('robotId')?.toString();
		if (!robotId) return fail(400, { error: 'Robot ID required' });

		await OpentronsRobot.findByIdAndDelete(robotId);
		return { success: true };
	}
};
