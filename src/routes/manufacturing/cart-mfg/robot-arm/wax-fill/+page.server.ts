/**
 * ARM-WAX-01 — robot-arm wax fill cell (single cartridge).
 *
 * Create a coordinated arm+OT-2 wax-fill run: scan ONE cartridge, pick the
 * OT-2, set gate volumes/channels. The run then lives at ./wax-fill/[runId]
 * where each interlocked step is triggered and verified.
 */
import { fail, redirect } from '@sveltejs/kit';
import { requirePermission } from '$lib/server/permissions';
import {
	connectDB,
	ArmWaxFillRun,
	CartridgeRecord,
	OpentronsRobot,
	AuditLog,
	generateId
} from '$lib/server/db';
import type { PageServerLoad, Actions } from './$types';

export const load: PageServerLoad = async ({ locals }) => {
	if (!locals.user) redirect(302, '/login');
	requirePermission(locals.user, 'manufacturing:read');
	await connectDB();

	const [robots, runs] = await Promise.all([
		OpentronsRobot.find({}).select('_id name ip healthStatus').sort({ name: 1 }).lean(),
		ArmWaxFillRun.find({})
			.select('_id phase cartridgeId robotId createdAt endedAt error triggeredBy')
			.sort({ createdAt: -1 })
			.limit(25)
			.lean()
	]);

	return {
		robots: JSON.parse(JSON.stringify(robots)),
		runs: JSON.parse(JSON.stringify(runs))
	};
};

export const actions: Actions = {
	create: async ({ request, locals }) => {
		if (!locals.user) redirect(302, '/login');
		requirePermission(locals.user, 'manufacturing:write');
		await connectDB();

		const data = await request.formData();
		const cartridgeId = data.get('cartridgeId')?.toString().trim();
		const robotId = data.get('robotId')?.toString();
		const createMissing = data.get('createMissing') === 'on';
		const dryRun = data.get('dryRun') === 'on';

		if (!cartridgeId) return fail(400, { error: 'Scan a cartridge barcode' });
		if (!robotId) return fail(400, { error: 'Pick an OT-2 robot' });

		const robot = await OpentronsRobot.findById(robotId).select('_id').lean();
		if (!robot) return fail(400, { error: 'Unknown robot' });

		const num = (name: string, dflt: number) => {
			const v = parseFloat(data.get(name)?.toString() ?? '');
			return Number.isFinite(v) ? v : dflt;
		};

		const op = { _id: locals.user._id, username: locals.user.username };
		const now = new Date();

		const cart = (await CartridgeRecord.findById(cartridgeId).select('_id status').lean()) as {
			_id: string;
			status?: string;
		} | null;
		if (!cart && !createMissing) {
			return fail(400, {
				error: `Cartridge ${cartridgeId} not found. Tick "create missing" to conjure a test cart.`
			});
		}
		if (!cart && createMissing) {
			await CartridgeRecord.create({
				_id: cartridgeId,
				status: 'ready_for_wax',
				priorStatus: '(created)',
				usedForTestFill: true,
				notes: [
					{
						_id: generateId(),
						body: 'Created via ARM-WAX cell (test cartridge for arm wax fill).',
						phase: 'ready_for_wax',
						author: op,
						createdAt: now
					}
				]
			});
		}

		// One live run per cartridge at a time.
		const live = await ArmWaxFillRun.findOne({
			cartridgeId,
			phase: { $nin: ['complete', 'failed', 'aborted'] }
		})
			.select('_id phase')
			.lean();
		if (live) {
			return fail(400, {
				error: `Cartridge already has an active arm-wax run (${(live as any)._id}, ${(live as any).phase})`
			});
		}

		const run = await ArmWaxFillRun.create({
			_id: generateId(),
			cartridgeId,
			robotId,
			parameters: {
				nestSlot: data.get('nestSlot')?.toString() || '1',
				waxTubeWell: data.get('waxTubeWell')?.toString() || 'A1',
				channels: {
					a: data.get('channelA') === 'on',
					b: data.get('channelB') === 'on',
					c: data.get('channelC') === 'on'
				},
				volumes: {
					gate4: num('volGate4', 1.6),
					gate3: num('volGate3', 1.6),
					gate2: num('volGate2', 1.6),
					gate1: num('volGate1', 1.6)
				},
				aspirateRemainder: num('aspirateRemainder', 11.5),
				dryRun
			},
			triggeredBy: op,
			events: [{ at: now, type: 'run.created', phase: 'created', by: op.username }]
		});

		await AuditLog.create({
			_id: generateId(),
			tableName: 'arm_wax_fill_runs',
			recordId: run._id,
			action: 'arm_wax_create',
			newData: { cartridgeId, robotId, dryRun },
			changedAt: now,
			changedBy: op.username
		});

		redirect(303, `/manufacturing/cart-mfg/robot-arm/wax-fill/${run._id}`);
	}
};
