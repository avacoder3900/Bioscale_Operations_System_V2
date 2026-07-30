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
import { AuditLog, DeviceEvent, generateId } from '$lib/server/db';
import { RobotArmDataset } from '$lib/server/db/models';
import { requirePermission } from '$lib/server/permissions';
import { robotArm } from '$lib/server/robot-arm-client';
import { deriveArmHolder } from '$lib/server/robot-arm-lock';
import type { Actions, PageServerLoad } from './$types';

// Connection log. Recorded here rather than pushed by the Pi, because the event
// that matters most — "BIMS cannot reach the arm" — is only observable from this
// side. Rows go in the shared immutable `device_events` collection (30-day TTL).
const ARM_DEVICE_ID = 'robot-arm-pi';
const ARM_CONNECTION_EVENT = 'robot_arm.connection';
// Same-state heartbeat floor. Deliberately coarse: /devices renders
// DeviceEvent.find() UNFILTERED with limit(100), so a chatty arm heartbeat would
// bury an unrelated page. Hourly keeps an anchor row inside the 30-day TTL
// without crowding that list.
const ARM_HEARTBEAT_MS = 60 * 60 * 1000;
// A state CHANGE still won't write if an identical-state row landed this
// recently — kills Refresh-mashing and instantaneous flapping.
const ARM_CHANGE_DEDUPE_MS = 30_000;
const ARM_LOG_LIMIT = 20;

// Normalized to {value, error} rather than a union, so the page doesn't need
// hand-written type guards to tell a session from an outage.
async function safeActive() {
	try {
		const res = await robotArm.getActive();
		return { active: res.active ?? null, activeError: null };
	} catch (err) {
		return { active: null, activeError: (err as Error).message };
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

interface ConnectionRow {
	_id: string;
	success: boolean;
	errorMessage?: string | null;
	eventData?: Record<string, unknown> | null;
	createdAt: string | Date;
}

/**
 * Append a connection-log row, but only when it says something new: on an
 * up<->down transition, or once an hour while the state is steady.
 *
 * `device_events` is an immutable log — updateOne/findOneAndUpdate are blocked by
 * middleware — so there is no atomic upsert available and this read-then-write is
 * racy across concurrent tabs. That is acceptable: the worst case is two adjacent
 * rows in the same state a few milliseconds apart, in an append-only TTL'd
 * telemetry log that nothing reads for correctness.
 *
 * Returns the row it wrote, or null if it decided not to write.
 */
async function recordConnection(
	up: boolean,
	preflight: { ok?: boolean; checks?: Record<string, { ok?: boolean; value?: boolean } | undefined> } | null,
	errorMessage: string | null,
	previous: ConnectionRow | null
): Promise<ConnectionRow | null> {
	try {
		const prevUp = previous ? previous.success === true : null;
		const ageMs = previous ? Date.now() - new Date(previous.createdAt).getTime() : Infinity;
		const changed = prevUp !== null && prevUp !== up;

		if (changed && ageMs < ARM_CHANGE_DEDUPE_MS) return null;
		if (!changed && prevUp !== null && ageMs < ARM_HEARTBEAT_MS) return null;

		const row = {
			_id: generateId(),
			deviceId: ARM_DEVICE_ID,
			eventType: ARM_CONNECTION_EVENT,
			success: up,
			errorMessage: up ? undefined : (errorMessage ?? '').slice(0, 500),
			eventData: {
				reason: changed ? 'change' : 'heartbeat',
				previous: prevUp === null ? null : prevUp ? 'up' : 'down',
				preflightOk: preflight?.ok ?? null,
				dryRun: preflight?.checks?.dry_run?.value ?? null,
				leaderOk: preflight?.checks?.leader_port?.ok ?? null,
				followerOk: preflight?.checks?.follower_port?.ok ?? null,
				baseUrl: env.ROBOT_ARM_BASE_URL ?? null,
				// The mechanism that observed this, deliberately NOT the user who was
				// looking — a connection log should not become a surveillance log.
				observedBy: 'control-page-load'
			},
			createdAt: new Date()
		};

		await DeviceEvent.create(row);
		return row as unknown as ConnectionRow;
	} catch {
		// Telemetry must never break the page it describes — same posture as the
		// safe* wrappers above.
		return null;
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

	const [activeResult, piRecordings, dbDatasets, preflightResult, tasks, holder, logRows] =
		await Promise.all([
			safeActive(),
			safeRecordings(),
			RobotArmDataset.find({}).select('_id name path').sort({ recordedAt: -1 }).limit(50).lean(),
			safePreflight(),
			safeTasks(),
			deriveArmHolder(),
			DeviceEvent.find({ deviceId: ARM_DEVICE_ID, eventType: ARM_CONNECTION_EVENT })
				.select('_id success errorMessage eventData createdAt')
				.sort({ createdAt: -1 })
				.limit(ARM_LOG_LIMIT)
				.lean()
		]);

	// Preflight is the single definition of "reachable" for the log. safeActive()
	// is a second, independent reachability signal (different endpoint, different
	// timeout) that can disagree — that disagreement is surfaced in the session
	// bar, deliberately not blended into this log.
	const up = preflightResult.preflightError === null;
	const previous = (logRows[0] as ConnectionRow | undefined) ?? null;
	const written = await recordConnection(
		up,
		preflightResult.preflight,
		preflightResult.preflightError,
		previous
	);
	const connectionLog = (written ? [written, ...logRows] : logRows) as ConnectionRow[];

	// Fold in what THIS request just observed. Reading "last connected" straight
	// off the newest success row would report an hour-old timestamp next to a
	// green ONLINE dot, because a steady arm only writes a heartbeat row hourly.
	let lastConnected: string | null = null;
	if (up) {
		lastConnected = new Date().toISOString();
	} else {
		const recent = connectionLog.find((r) => r.success);
		if (recent) {
			lastConnected = new Date(recent.createdAt).toISOString();
		} else {
			// Down, and no success inside the fetched window — look further back
			// rather than claiming it has never connected.
			const older = await DeviceEvent.findOne({
				deviceId: ARM_DEVICE_ID,
				eventType: ARM_CONNECTION_EVENT,
				success: true
			})
				.select('createdAt')
				.sort({ createdAt: -1 })
				.lean();
			lastConnected = older ? new Date(older.createdAt).toISOString() : null;
		}
	}

	return {
		active: activeResult.active,
		activeError: activeResult.activeError,
		piRecordings,
		dbDatasets: JSON.parse(JSON.stringify(dbDatasets)),
		preflight: preflightResult.preflight,
		preflightError: preflightResult.preflightError,
		// Surfaced so the panel can name the endpoint it failed to reach. Not a
		// secret — the API key is what guards the Pi, and that never leaves here.
		armBaseUrl: env.ROBOT_ARM_BASE_URL ?? null,
		tasks,
		holder,
		currentUserId: locals.user._id,
		connectionLog: JSON.parse(JSON.stringify(connectionLog)),
		lastConnected
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
