import { error, fail, redirect } from '@sveltejs/kit';
import { connectDB, OpentronsRobot, AuditLog, generateId } from '$lib/server/db';
import { requirePermission } from '$lib/server/permissions';
import { isValidDirectUrl, resolveRobotConnection, tailnetAllowedHere } from '$lib/server/opentrons/connection';
import type { Actions, PageServerLoad } from './$types';

export const load: PageServerLoad = async ({ params, locals }) => {
	if (!locals.user) redirect(302, '/login');
	requirePermission(locals.user, 'manufacturing:read');
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
			notes: robot.notes ?? '',
			// OT2-TAILNET-4
			connectionMode: robot.connection?.mode ?? 'queue',
			directUrl: robot.connection?.directUrl ?? '',
			tailnetHostname: robot.connection?.tailnetHostname ?? '',
			connectionUpdatedAt: robot.connection?.updatedAt ?? null,
			connectionUpdatedBy: robot.connection?.updatedBy ?? ''
		},
		connection: {
			allowedHere: tailnetAllowedHere(robot),
			effective: resolveRobotConnection(robot)
		}
	};
};

export const actions: Actions = {
	default: async ({ request, params, locals }) => {
		if (!locals.user) redirect(302, '/login');
		requirePermission(locals.user, 'manufacturing:write');
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

		// OT2-TAILNET-4: which line BIMS uses to reach this robot.
		const connectionMode = form.get('connectionMode')?.toString() === 'tailnet' ? 'tailnet' : 'queue';
		const directUrl = (form.get('directUrl')?.toString().trim() || '').replace(/\/+$/, '');
		const tailnetHostname = form.get('tailnetHostname')?.toString().trim() || '';
		if (directUrl && !isValidDirectUrl(directUrl)) {
			return fail(400, { error: 'Direct URL must look like https://ot2-<slot>.tailf65a70.ts.net (https, no port or path)' });
		}
		if (connectionMode === 'tailnet' && !directUrl) {
			return fail(400, { error: 'Tailnet mode needs a Direct URL' });
		}

		const robot = (await OpentronsRobot.findById(params.robotId).lean()) as any;
		if (!robot) return fail(404, { error: 'Robot not found' });

		const before = {
			mode: robot.connection?.mode ?? 'queue',
			directUrl: robot.connection?.directUrl ?? '',
			tailnetHostname: robot.connection?.tailnetHostname ?? ''
		};
		const after = { mode: connectionMode, directUrl, tailnetHostname };
		const connectionChanged =
			before.mode !== after.mode || before.directUrl !== after.directUrl || before.tailnetHostname !== after.tailnetHostname;
		if (connectionChanged) {
			update.connection = { ...after, updatedAt: new Date(), updatedBy: locals.user.username };
		}

		await OpentronsRobot.updateOne({ _id: params.robotId }, { $set: update });

		if (connectionChanged) {
			await AuditLog.create({
				_id: generateId(),
				tableName: 'opentrons_robots',
				recordId: params.robotId,
				action: 'connection_update',
				oldData: before,
				newData: after,
				changedFields: Object.keys(after).filter((k) => (before as any)[k] !== (after as any)[k]),
				changedAt: new Date(),
				changedBy: locals.user.username
			});
		}

		redirect(303, `/opentrons/devices/${params.robotId}`);
	}
};

export const config = { maxDuration: 60 };
