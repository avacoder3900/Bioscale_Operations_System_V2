export const config = { maxDuration: 60 };
import { redirect, fail } from '@sveltejs/kit';
import { connectDB, Equipment, OpentronsRobot, generateId } from '$lib/server/db';
import type { PageServerLoad, Actions } from './$types';

export const load: PageServerLoad = async ({ locals }) => {
	if (!locals.user) redirect(302, '/login');
	await connectDB();

	// Primary source: Equipment collection (equipmentType: 'robot')
	const robots = await Equipment.find({ equipmentType: 'robot' }).sort({ name: 1 }).lean();
	return {
		robots: (robots as any[]).map((r) => ({
			id: String(r._id),
			name: r.name ?? '',
			robotSide: r.robotSide ?? '',
			ip: r.ip ?? '',
			isActive: r.isActive ?? true,
			status: r.status ?? 'active',
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

		const id = generateId();
		const robotSide = data.get('robotSide')?.toString() || undefined;
		const ip = data.get('ipAddress')?.toString() || undefined;

		// Primary write: Equipment collection
		await Equipment.create({
			_id: id,
			name,
			equipmentType: 'robot',
			status: 'active',
			isActive: true,
			robotSide,
			ip
		});

		// Sync to OpentronsRobot for opentrons lab pages
		await OpentronsRobot.create({
			_id: id,
			name,
			robotSide,
			ip,
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

		const robotSide = data.get('robotSide')?.toString() || undefined;
		const ip = data.get('ipAddress')?.toString() || undefined;

		// Primary update: Equipment
		await Equipment.findByIdAndUpdate(robotId, {
			$set: { name, robotSide, ip }
		});

		// Sync to OpentronsRobot
		await OpentronsRobot.findByIdAndUpdate(robotId, {
			$set: { name, robotSide, ip }
		});

		return { success: true };
	},

	toggleActive: async ({ request, locals }) => {
		if (!locals.user) redirect(302, '/login');
		await connectDB();

		const data = await request.formData();
		const robotId = data.get('robotId')?.toString();
		if (!robotId) return fail(400, { error: 'Robot ID required' });

		const robot = await Equipment.findById(robotId).lean() as any;
		if (!robot) return fail(404, { error: 'Robot not found' });

		const newActive = !robot.isActive;
		const newStatus = newActive ? 'active' : 'offline';

		// Primary: Equipment
		await Equipment.findByIdAndUpdate(robotId, {
			$set: { isActive: newActive, status: newStatus }
		});

		// Sync to OpentronsRobot
		await OpentronsRobot.findByIdAndUpdate(robotId, {
			$set: { isActive: newActive }
		});

		return { success: true };
	},

	deleteRobot: async ({ request, locals }) => {
		if (!locals.user) redirect(302, '/login');
		await connectDB();

		const data = await request.formData();
		const robotId = data.get('robotId')?.toString();
		if (!robotId) return fail(400, { error: 'Robot ID required' });

		// Delete from Equipment (primary)
		await Equipment.findByIdAndDelete(robotId);

		// Sync: also delete from OpentronsRobot
		await OpentronsRobot.findByIdAndDelete(robotId);

		return { success: true };
	}
};
