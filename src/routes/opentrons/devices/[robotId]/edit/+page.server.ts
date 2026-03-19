import { error, fail, redirect } from '@sveltejs/kit';
import { connectDB, OpentronsRobot } from '$lib/server/db';
import type { Actions, PageServerLoad } from './$types';

export const load: PageServerLoad = async ({ params }) => {
	await connectDB();
	const robot = await OpentronsRobot.findById(params.robotId).lean() as any;
	if (!robot) error(404, 'Robot not found');

	return {
		robot: {
			robotId: robot._id,
			name: robot.name ?? '',
			ip: robot.ip ?? '',
			port: robot.port ?? 31950,
			robotSide: robot.robotSide ?? '',
			robotModel: robot.robotModel ?? 'OT-2',
			robotSerial: robot.robotSerial ?? '',
			isActive: robot.isActive ?? true,
			firmwareVersion: robot.firmwareVersion ?? '',
			apiVersion: robot.apiVersion ?? '',
			source: robot.source ?? 'manual',
			// OT-2 specific fields
			leftPipette: robot.leftPipette ?? '',
			rightPipette: robot.rightPipette ?? '',
			deckSlotConfig: robot.deckSlotConfig ?? '',
			labwareCalibrationDate: robot.labwareCalibrationDate ?? '',
			pipetteCalibrationDate: robot.pipetteCalibrationDate ?? '',
			deckCalibrationDate: robot.deckCalibrationDate ?? '',
			notes: robot.notes ?? ''
		}
	};
};

export const actions: Actions = {
	default: async ({ request, params }) => {
		await connectDB();
		const form = await request.formData();

		const name = form.get('name')?.toString().trim();
		if (!name) return fail(400, { error: 'Robot name is required' });

		const ip = form.get('ip')?.toString().trim() || '';
		const portStr = form.get('port')?.toString().trim() || '31950';
		const port = parseInt(portStr, 10);
		if (isNaN(port) || port < 1 || port > 65535) return fail(400, { error: 'Invalid port number' });

		const update: Record<string, any> = {
			name,
			ip,
			port,
			robotSide: form.get('robotSide')?.toString().trim() || '',
			robotModel: form.get('robotModel')?.toString().trim() || 'OT-2',
			robotSerial: form.get('robotSerial')?.toString().trim() || '',
			isActive: form.get('isActive') === 'on',
			firmwareVersion: form.get('firmwareVersion')?.toString().trim() || '',
			apiVersion: form.get('apiVersion')?.toString().trim() || '',
			// OT-2 specific
			leftPipette: form.get('leftPipette')?.toString().trim() || '',
			rightPipette: form.get('rightPipette')?.toString().trim() || '',
			deckSlotConfig: form.get('deckSlotConfig')?.toString().trim() || '',
			labwareCalibrationDate: form.get('labwareCalibrationDate')?.toString().trim() || '',
			pipetteCalibrationDate: form.get('pipetteCalibrationDate')?.toString().trim() || '',
			deckCalibrationDate: form.get('deckCalibrationDate')?.toString().trim() || '',
			notes: form.get('notes')?.toString().trim() || ''
		};

		const robot = await OpentronsRobot.findById(params.robotId);
		if (!robot) return fail(404, { error: 'Robot not found' });

		await OpentronsRobot.updateOne({ _id: params.robotId }, { $set: update });

		redirect(303, `/opentrons/devices/${params.robotId}`);
	}
};

export const config = { maxDuration: 60 };
