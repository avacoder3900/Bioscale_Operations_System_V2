import { error, fail } from '@sveltejs/kit';
import bcrypt from 'bcryptjs';
import { requirePermission } from '$lib/server/permissions';
import { connectDB, ValidationSession, User, Spu, AuditLog, generateId } from '$lib/server/db';
import { getVariable } from '$lib/server/particle';
import type { Actions, PageServerLoad } from './$types';

export const load: PageServerLoad = async ({ locals, params }) => {
	requirePermission(locals.user, 'spu:read');
	await connectDB();

	const session = await ValidationSession.findById(params.sessionId).lean() as any;
	if (!session) error(404, 'Session not found');

	const user = session.userId ? await User.findById(session.userId, { username: 1 }).lean() as any : null;

	return {
		session: {
			id: session._id,
			status: session.status,
			startedAt: session.startedAt?.toISOString() ?? null,
			completedAt: session.completedAt?.toISOString() ?? null,
			barcode: session.barcode ?? null,
			username: user?.username ?? null,
			spuUdi: session.spuUdi ?? null,
			spuId: session.spuId ?? null,
			particleDeviceId: session.particleDeviceId ?? null,
			overallPassed: session.overallPassed ?? null,
			override: session.override ? {
				by: session.override.by,
				at: session.override.at?.toISOString() ?? null,
				reason: session.override.reason,
				originalResult: session.override.originalResult
			} : null
		},
		result: session.magResults ? {
			id: session._id,
			testType: 'magnetometer',
			rawData: session.rawData ?? null,
			processedData: {
				metrics: session.magResults,
				interpretation: session.overallPassed ? 'All Z values within acceptable range' : 'One or more Z values outside acceptable range',
				failureReasons: session.failureReasons ?? []
			},
			passed: session.overallPassed ?? null,
			notes: null,
			createdAt: session.completedAt?.toISOString() ?? session.createdAt?.toISOString() ?? new Date().toISOString()
		} : null
	};
};

export const actions: Actions = {
	readResults: async ({ locals, params }) => {
		requirePermission(locals.user, 'spu:write');
		await connectDB();

		const session = await ValidationSession.findById(params.sessionId) as any;
		if (!session) return { error: 'Session not found' };
		if (!session.particleDeviceId) return { error: 'No device linked to this session' };

		try {
			const varData = await getVariable(session.particleDeviceId, 'magnet_validation');
			const rawResult = varData.result;
			if (!rawResult || typeof rawResult !== 'string') {
				return { error: 'No magnet_validation data available on device' };
			}

			// Parse the tab-delimited magnet validation result
			const parsed = parseMagValidation(rawResult);

			// Get criteria
			const { Integration } = await import('$lib/server/db');
			const criteria = await Integration.findOne({ type: 'mag_criteria' }).lean() as any;
			const minZ = criteria?.minZ ?? 3900;
			const maxZ = criteria?.maxZ ?? 4500;

			// Evaluate pass/fail per well per channel
			const failureReasons: string[] = [];
			for (const well of parsed) {
				for (const ch of ['A', 'B', 'C'] as const) {
					const z = well[`ch${ch}_Z`];
					if (z !== null && (z < minZ || z > maxZ)) {
						failureReasons.push(`Well ${well.well} Ch ${ch}: Z=${z} (range: ${minZ}-${maxZ})`);
					}
				}
			}

			const overallPassed = failureReasons.length === 0;

			await ValidationSession.updateOne(
				{ _id: params.sessionId },
				{
					$set: {
						status: overallPassed ? 'completed' : 'failed',
						completedAt: new Date(),
						rawData: rawResult,
						magResults: parsed,
						overallPassed,
						failureReasons,
						criteriaUsed: { minZ, maxZ }
					}
				}
			);

			return { success: true, overallPassed };
		} catch (err) {
			return { error: `Failed to read device: ${err instanceof Error ? err.message : String(err)}` };
		}
	},

	overrideApproval: async ({ request, locals, params }) => {
		requirePermission(locals.user, 'admin:full');
		await connectDB();

		const data = await request.formData();
		const adminPassword = data.get('adminPassword')?.toString();
		const reason = data.get('reason')?.toString();

		if (!adminPassword) return fail(400, { error: 'Password is required' });
		if (!reason || reason.length < 10) return fail(400, { error: 'Reason required (min 10 characters)' });

		// Re-authenticate admin via password
		const user = await User.findById(locals.user!._id).lean() as any;
		if (!user) return fail(400, { error: 'User not found' });
		const validPassword = await bcrypt.compare(adminPassword, user.passwordHash);
		if (!validPassword) return fail(403, { error: 'Invalid password' });

		const session = await ValidationSession.findById(params.sessionId).lean() as any;
		if (!session) return fail(404, { error: 'Session not found' });
		if (session.overallPassed === true && !session.override) {
			return fail(400, { error: 'Session already passed — no override needed' });
		}
		if (session.override) {
			return fail(400, { error: 'Session already has an override' });
		}

		const originalResult = {
			overallPassed: session.overallPassed,
			failureReasons: session.failureReasons ?? [],
			status: session.status
		};

		// Update ValidationSession
		await ValidationSession.updateOne(
			{ _id: params.sessionId },
			{
				$set: {
					overallPassed: true,
					status: 'completed',
					override: {
						by: { _id: locals.user!._id, username: locals.user!.username },
						at: new Date(),
						reason,
						originalResult
					}
				}
			}
		);

		// Update SPU validation record if linked
		if (session.spuId) {
			await Spu.updateOne({ _id: session.spuId }, {
				$set: {
					'validation.magnetometer.status': 'overridden',
					'validation.magnetometer.overriddenBy': { _id: locals.user!._id, username: locals.user!.username },
					'validation.magnetometer.overriddenAt': new Date(),
					'validation.magnetometer.overrideReason': reason
				}
			});
		}

		// Audit log
		await AuditLog.create({
			_id: generateId(),
			tableName: 'validation_sessions',
			recordId: params.sessionId,
			entityId: session.spuId ?? params.sessionId,
			action: 'OVERRIDE',
			oldData: originalResult,
			newData: {
				overallPassed: true,
				status: 'completed',
				overriddenBy: locals.user!.username,
				reason
			},
			changedAt: new Date(),
			changedBy: locals.user!._id,
			reason: `Magnetometer validation override: ${reason}`
		});

		return { success: true, overrideApplied: true };
	}
};

interface MagWellResult {
	well: number;
	error?: string | null;
	chA_T: number | null; chA_X: number | null; chA_Y: number | null; chA_Z: number | null;
	chB_T: number | null; chB_X: number | null; chB_Y: number | null; chB_Z: number | null;
	chC_T: number | null; chC_X: number | null; chC_Y: number | null; chC_Z: number | null;
}

function parseMagValidation(raw: string): MagWellResult[] {
	const lines = raw.split(/\r?\n/).map(l => l.trim()).filter(l => l.length > 0);
	const results: MagWellResult[] = [];

	for (const line of lines) {
		const match = line.match(/^(\d+)\t/);
		if (!match) continue;

		const well = parseInt(match[1]);
		if (well < 1 || well > 5) continue;

		const hasError = line.includes('Could not find') || line.includes('error') || line.includes('Error');
		const parts = line.split('\t').map(s => s.trim());
		const nums = parts.slice(1).map(s => {
			const n = parseFloat(s);
			return isNaN(n) ? null : n;
		});

		results.push({
			well,
			error: hasError ? parts.slice(1).join(' ').trim() : null,
			chA_T: nums[0] ?? null, chA_X: nums[1] ?? null, chA_Y: nums[2] ?? null, chA_Z: nums[3] ?? null,
			chB_T: nums[4] ?? null, chB_X: nums[5] ?? null, chB_Y: nums[6] ?? null, chB_Z: nums[7] ?? null,
			chC_T: nums[8] ?? null, chC_X: nums[9] ?? null, chC_Y: nums[10] ?? null, chC_Z: nums[11] ?? null
		});
	}

	for (let w = 1; w <= 5; w++) {
		if (!results.find(r => r.well === w)) {
			results.push({
				well: w, error: 'No data received',
				chA_T: null, chA_X: null, chA_Y: null, chA_Z: null,
				chB_T: null, chB_X: null, chB_Y: null, chB_Z: null,
				chC_T: null, chC_X: null, chC_Y: null, chC_Z: null
			});
		}
	}

	return results.sort((a, b) => a.well - b.well);
}

export const config = { maxDuration: 60 };
