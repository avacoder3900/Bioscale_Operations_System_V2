/**
 * Robot Arm — Remote Control.
 *
 * Form actions hit the Pi via robotArmClient. The Pi enforces
 * single-active-session and emits events through the existing webhook
 * pipeline; the run shows up in /manufacturing/cart-mfg/robot-arm/runs.
 */
import { fail, redirect } from '@sveltejs/kit';
import { env } from '$env/dynamic/private';
import { connectDB } from '$lib/server/db/connection';
import { AuditLog, generateId } from '$lib/server/db';
import { RobotArmDataset } from '$lib/server/db/models';
import { requirePermission } from '$lib/server/permissions';
import { robotArm } from '$lib/server/robot-arm-client';
import { deriveArmHolder } from '$lib/server/robot-arm-lock';
import type { Actions, PageServerLoad } from './$types';

async function safeActive() {
	try {
		const res = await robotArm.getActive();
		return res.active;
	} catch (err) {
		return { error: (err as Error).message };
	}
}

async function safeRecordings() {
	try {
		const res = await robotArm.listRecordings();
		return res.recordings;
	} catch {
		return [];
	}
}

// ARM-01 S2. A Pi outage must render a degraded connection panel, never a 500 —
// so the error is data, not a throw. The panel shows the configured base URL
// alongside it, because "cannot reach" without the URL you're failing to reach
// is not a diagnosis.
async function safePreflight() {
	try {
		return { preflight: await robotArm.preflight(), preflightError: null };
	} catch (err) {
		return { preflight: null, preflightError: (err as Error).message };
	}
}

async function safeTasks() {
	try {
		const res = await robotArm.listTasks();
		return res.tasks ?? [];
	} catch {
		return [];
	}
}

export const load: PageServerLoad = async ({ locals }) => {
	if (!locals.user) redirect(302, '/login');
	requirePermission(locals.user, 'manufacturing:read');
	await connectDB();

	const [active, piRecordings, dbDatasets, preflightResult, tasks, holder] = await Promise.all([
		safeActive(),
		safeRecordings(),
		RobotArmDataset.find({}).select('_id name path').sort({ recordedAt: -1 }).limit(50).lean(),
		safePreflight(),
		safeTasks(),
		deriveArmHolder()
	]);

	return {
		active,
		piRecordings,
		dbDatasets: JSON.parse(JSON.stringify(dbDatasets)),
		preflight: preflightResult.preflight,
		preflightError: preflightResult.preflightError,
		// Surfaced so the panel can name the endpoint it failed to reach. Not a
		// secret — the API key is what guards the Pi, and that never leaves here.
		armBaseUrl: env.ROBOT_ARM_BASE_URL ?? null,
		tasks,
		holder,
		currentUserId: locals.user._id
	};
};

// Pull optional provenance from formData. Frontend form may not have these
// fields yet — that's fine, they're optional all the way down.
function provenanceFromForm(data: FormData): {
	lot_id?: string;
	manufacturing_step?: string;
	recorded_during_run_id?: string;
} {
	const lot = data.get('lot_id')?.toString().trim();
	const step = data.get('manufacturing_step')?.toString().trim();
	const ref = data.get('recorded_during_run_id')?.toString().trim();
	return {
		lot_id: lot || undefined,
		manufacturing_step: step || undefined,
		recorded_during_run_id: ref || undefined
	};
}

export const actions: Actions = {
	startTeleop: async ({ request, locals }) => {
		if (!locals.user) return fail(401, { error: 'Unauthorized' });
		requirePermission(locals.user, 'manufacturing:write');
		const data = await request.formData();
		const rate = parseInt(data.get('rate_hz')?.toString() || '10', 10);
		const dur = data.get('duration_s')?.toString();
		try {
			const result = await robotArm.startTeleop({
				rate_hz: rate,
				duration_s: dur ? parseFloat(dur) : undefined,
				triggered_by: { _id: locals.user._id, username: locals.user.username },
				...provenanceFromForm(data)
			});
			return { success: 'teleop started', runId: result.run_id };
		} catch (err) {
			return fail(409, { error: (err as Error).message });
		}
	},

	startRecord: async ({ request, locals }) => {
		if (!locals.user) return fail(401, { error: 'Unauthorized' });
		requirePermission(locals.user, 'manufacturing:write');
		const data = await request.formData();
		const name = data.get('name')?.toString().trim();
		if (!name) return fail(400, { error: 'name is required' });
		const rate = parseInt(data.get('rate_hz')?.toString() || '10', 10);
		const dur = data.get('duration_s')?.toString();
		try {
			const result = await robotArm.startRecord({
				name,
				rate_hz: rate,
				duration_s: dur ? parseFloat(dur) : undefined,
				triggered_by: { _id: locals.user._id, username: locals.user.username },
				...provenanceFromForm(data)
			});
			return { success: `recording "${name}" started`, runId: result.run_id };
		} catch (err) {
			return fail(409, { error: (err as Error).message });
		}
	},

	startReplay: async ({ request, locals }) => {
		if (!locals.user) return fail(401, { error: 'Unauthorized' });
		requirePermission(locals.user, 'manufacturing:write');
		const data = await request.formData();
		const source = data.get('source')?.toString().trim();
		if (!source) return fail(400, { error: 'source recording is required' });
		const loops = parseInt(data.get('loops')?.toString() || '1', 10);
		try {
			const result = await robotArm.startReplay({
				source,
				loops,
				triggered_by: { _id: locals.user._id, username: locals.user.username },
				...provenanceFromForm(data)
			});
			return { success: `replay started (${loops} loop${loops === 1 ? '' : 's'})`, runId: result.run_id };
		} catch (err) {
			return fail(409, { error: (err as Error).message });
		}
	},

	// ARM-01 S5. Start a named task from the Pi's tasks.yaml registry.
	startTask: async ({ request, locals }) => {
		if (!locals.user) return fail(401, { error: 'Unauthorized' });
		requirePermission(locals.user, 'manufacturing:write');
		const data = await request.formData();
		const name = data.get('task_name')?.toString().trim();
		if (!name) return fail(400, { error: 'task is required' });
		const lot = data.get('lot_id')?.toString().trim() || undefined;

		// ARM-01 §7.4: this build is accepted against dry-run only. The Pi is the
		// authority on its own DRY_RUN state, so re-read it at submit time rather
		// than trusting what the page rendered — the service could have been
		// restarted since load.
		let dryRun: boolean | undefined;
		try {
			const pre = await robotArm.preflight();
			dryRun = pre.checks?.dry_run?.value;
		} catch (err) {
			return fail(502, { error: `Cannot reach the arm to verify its state: ${(err as Error).message}` });
		}
		if (dryRun !== true) {
			return fail(400, {
				error:
					'Refusing to start: the arm is not in DRY_RUN. Live motion is out of scope for this build (ARM-01 §7.4).'
			});
		}

		let runId: string;
		try {
			const result = await robotArm.startTask(name, {
				lot_id: lot ?? null,
				triggered_by: { _id: locals.user._id, username: locals.user.username }
			});
			runId = result.run_id;
		} catch (err) {
			const msg = (err as Error).message;
			// The Pi serializes runs; 409 means something already holds the bus.
			if (msg.includes('robot-arm 409')) {
				return fail(409, { error: 'The arm is already running something. Stop it first.' });
			}
			return fail(502, { error: msg });
		}

		await AuditLog.create({
			_id: generateId(),
			action: 'robot_arm.task.start',
			resourceType: 'robot_arm_run',
			resourceId: runId,
			userId: locals.user._id,
			username: locals.user.username,
			timestamp: new Date(),
			details: { task_name: name, lot_id: lot ?? null, dry_run: true }
		});

		return { success: `task "${name}" started`, runId };
	},

	// ARM-01 §7.7: stop is available to ANY manufacturing:write user, including
	// one who doesn't hold the arm. A stop that respects the lock is a stop that
	// fails when you need it most.
	stop: async ({ locals }) => {
		if (!locals.user) return fail(401, { error: 'Unauthorized' });
		requirePermission(locals.user, 'manufacturing:write');

		// Read the holder before stopping so the audit trail names both parties.
		let heldBy: string | null = null;
		let heldRunId: string | null = null;
		try {
			const holder = await deriveArmHolder();
			heldBy = holder?.username ?? null;
			heldRunId = holder?.runId ?? null;
		} catch {
			// Best-effort attribution; never block a stop on it.
		}

		try {
			const result = await robotArm.stop();
			await AuditLog.create({
				_id: generateId(),
				action: 'robot_arm.session.stop',
				resourceType: 'robot_arm_run',
				resourceId: result.stopped_run_id ?? heldRunId ?? 'none',
				userId: locals.user._id,
				username: locals.user.username,
				timestamp: new Date(),
				details: {
					stopped_run_id: result.stopped_run_id ?? null,
					held_by: heldBy,
					stopped_by: locals.user.username,
					override: heldBy !== null && heldBy !== locals.user.username
				}
			});
			return { success: `stop signal sent (${result.stopped_run_id ?? 'no active session'})` };
		} catch (err) {
			return fail(500, { error: (err as Error).message });
		}
	}
};
