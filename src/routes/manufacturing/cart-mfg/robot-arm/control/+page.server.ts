/**
 * Robot Arm — Remote Control.
 *
 * Form actions hit the Pi via robotArmClient. The Pi enforces
 * single-active-session and emits events through the existing webhook
 * pipeline; the run shows up in /manufacturing/cart-mfg/robot-arm/runs.
 */
import { fail, redirect } from '@sveltejs/kit';
import { connectDB } from '$lib/server/db/connection';
import { AuditLog, DeviceEvent, generateId } from '$lib/server/db';
import { RobotArmDataset, RobotArmDeletedRecording } from '$lib/server/db/models';
import { requirePermission } from '$lib/server/permissions';
import {
	robotArm,
	recordingStem,
	currentArmRoute,
	type RecordingExport
} from '$lib/server/robot-arm-client';
// Via the Worker, not the S3 client: production's direct R2 credentials are
// not valid, and the Worker is the path the rest of the app uploads through.
import { uploadViaWorker, downloadViaWorker } from '$lib/server/services/r2';
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

// Recording trash. Deleted recordings are kept in R2 for this long, then the
// purge-deleted-recordings cron removes them. Users cannot purge early.
const RECORDING_TRASH_DAYS = 30;
const RECORDING_TRASH_PREFIX = 'robot-arm/deleted-recordings';

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
				baseUrl: currentArmRoute(),
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

	const [activeResult, piRecordings, dbDatasets, preflightResult, tasks, holder, logRows, trash] =
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
				.lean(),
			RobotArmDeletedRecording.find({ recoveredAt: null, expiresAt: { $gt: new Date() } })
				.select('_id name sizeBytes modified deletedBy deletedAt expiresAt')
				.sort({ deletedAt: -1 })
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

	// "Last connected" and the base URL are no longer returned here: the ARM
	// CONNECTION panel moved to the Robot Arm layout, which derives them itself.

	return {
		active: activeResult.active,
		activeError: activeResult.activeError,
		piRecordings,
		dbDatasets: JSON.parse(JSON.stringify(dbDatasets)),
		deletedRecordings: JSON.parse(JSON.stringify(trash)),
		preflight: preflightResult.preflight,
		preflightError: preflightResult.preflightError,
		tasks,
		holder,
		currentUserId: locals.user._id,
		connectionLog: JSON.parse(JSON.stringify(connectionLog))
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

// Solenoid GPIO (cartridge chute). BCM pin numbers, in drop order: 17 first,
// then 27. These mirror the Pi's allow-list; the Pi is the enforcement point.
const GPIO_PINS = [17, 27];
const GPIO_PULSE_DEFAULT_MS = 1000;
const GPIO_PULSE_MIN_MS = 20;
const GPIO_PULSE_MAX_MS = 2000;
const GPIO_GAP_MAX_MS = 5000;

function parseGpioMs(raw: FormDataEntryValue | null, fallback: number): number | null {
	const txt = raw?.toString().trim();
	const n = txt ? parseInt(txt, 10) : fallback;
	if (!Number.isFinite(n) || n < GPIO_PULSE_MIN_MS || n > GPIO_PULSE_MAX_MS) return null;
	return n;
}

function parseGpioGap(raw: FormDataEntryValue | null): number | null {
	const txt = raw?.toString().trim();
	const n = txt ? parseInt(txt, 10) : 500;
	if (!Number.isFinite(n) || n < 0 || n > GPIO_GAP_MAX_MS) return null;
	return n;
}

function gpioStatus(err: unknown): number {
	const msg = (err as Error).message ?? '';
	return msg.includes('robot-arm 409') ? 409 : 502;
}

function gpioMessage(err: unknown): string {
	const msg = (err as Error).message ?? 'unknown error';
	if (msg.includes('robot-arm 404')) {
		return 'The arm Pi does not have the GPIO endpoints yet - deploy the solenoid module to the robot-arm service and restart it.';
	}
	if (msg.includes('robot-arm 409')) return 'A solenoid pulse is already in progress on the Pi.';
	return msg;
}

async function auditGpio(
	user: { _id: string; username: string },
	action: string,
	details: Record<string, unknown>
) {
	await connectDB();
	await AuditLog.create({
		_id: generateId(),
		tableName: 'robot_arm_gpio',
		recordId: ARM_DEVICE_ID,
		action,
		newData: { ...details, userId: user._id },
		changedBy: user.username
	});
}

function recordingMessage(err: unknown): string {
	const msg = (err as Error).message ?? 'unknown error';
	if (msg.includes('robot-arm 404') && msg.includes('Not Found')) {
		return 'The arm Pi does not have the recording trash endpoints yet - install recordings_admin.py on the Pi and restart the robot-arm service.';
	}
	return msg;
}

async function auditRecording(
	user: { _id: string; username: string },
	action: string,
	resourceId: string,
	details: Record<string, unknown>
) {
	await AuditLog.create({
		_id: generateId(),
		tableName: 'robot_arm_deleted_recordings',
		recordId: resourceId,
		action,
		newData: { ...details, userId: user._id },
		changedBy: user.username
	});
}

export const actions: Actions = {
	// Move a recording from the Pi to the 30-day trash. Order matters: export
	// from the Pi, upload to R2, write the trash row, and only then delete on the
	// Pi. A failure at any earlier step leaves the recording where it was.
	deleteRecording: async ({ request, locals }) => {
		if (!locals.user) return fail(401, { error: 'Unauthorized' });
		requirePermission(locals.user, 'manufacturing:write');
		const data = await request.formData();
		const name = data.get('name')?.toString();
		if (!name) return fail(400, { error: 'recording name is required' });
		await connectDB();

		// The live Pi's app.py has no module-level `state`, so its trash router
		// cannot see sessions. Enforce "not while a session runs" here instead.
		try {
			const { active } = await robotArm.getActive();
			if (active) {
				return fail(409, {
					error: `A ${active.kind} session is running. Stop it before deleting recordings.`
				});
			}
		} catch (err) {
			return fail(502, { error: `Cannot reach the arm: ${(err as Error).message}` });
		}

		let exported: RecordingExport;
		try {
			exported = await robotArm.exportRecording(name);
		} catch (err) {
			return fail(502, { error: `Could not read "${name}" from the Pi: ${recordingMessage(err)}` });
		}

		const id = generateId();
		const r2Key = `${RECORDING_TRASH_PREFIX}/${id}.json`;
		const payload = Buffer.from(JSON.stringify(exported), 'utf8');
		try {
			await uploadViaWorker(payload, r2Key, 'application/json');
		} catch (err) {
			return fail(502, {
				error: `Could not save a recovery copy of "${name}", so it was not deleted: ${(err as Error).message}`
			});
		}

		const now = new Date();
		const expiresAt = new Date(now.getTime() + RECORDING_TRASH_DAYS * 24 * 60 * 60 * 1000);
		await RobotArmDeletedRecording.create({
			_id: id,
			name,
			r2Key,
			sizeBytes: new TextEncoder().encode(exported.jsonl).byteLength,
			modified: data.get('modified')?.toString() || undefined,
			meta: exported.meta ?? null,
			deletedBy: { _id: locals.user._id, username: locals.user.username },
			deletedAt: now,
			expiresAt
		});

		try {
			await robotArm.deleteRecording(name);
		} catch (err) {
			// The Pi still has it, so the trash row would be a duplicate. Drop it;
			// the orphaned R2 object is harmless and tiny.
			await RobotArmDeletedRecording.deleteOne({ _id: id });
			const msg = (err as Error).message ?? '';
			return fail(msg.includes('robot-arm 409') ? 409 : 502, {
				error: `"${name}" was not deleted: ${recordingMessage(err)}`
			});
		}

		await auditRecording(locals.user, 'robot_arm.recording.delete', id, {
			name,
			r2Key,
			expiresAt: expiresAt.toISOString()
		});
		return {
			success: `"${name}" moved to the trash. It can be recovered until ${expiresAt.toLocaleDateString()}.`
		};
	},

	// Restore a trashed recording to the Pi. If the original name is taken, it
	// comes back as <name>-recovered (then -recovered-2, ...).
	recoverRecording: async ({ request, locals }) => {
		if (!locals.user) return fail(401, { error: 'Unauthorized' });
		requirePermission(locals.user, 'manufacturing:write');
		const data = await request.formData();
		const id = data.get('id')?.toString();
		if (!id) return fail(400, { error: 'trash id is required' });
		await connectDB();

		const row = (await RobotArmDeletedRecording.findById(id).lean()) as {
			_id: string;
			name: string;
			r2Key: string;
			recoveredAt: Date | null;
			expiresAt: Date;
		} | null;
		if (!row || row.recoveredAt || new Date(row.expiresAt) <= new Date()) {
			return fail(404, { error: 'That recording is no longer in the trash.' });
		}

		let exported: RecordingExport;
		try {
			const file = await downloadViaWorker(row.r2Key);
			exported = JSON.parse(file.toString('utf8'));
		} catch (err) {
			return fail(502, { error: `Could not load the recovery copy: ${(err as Error).message}` });
		}

		const stem = recordingStem(row.name);
		const candidates = [
			stem,
			`${stem}-recovered`,
			...[2, 3, 4, 5].map((n) => `${stem}-recovered-${n}`)
		];
		let restoredAs: string | null = null;
		for (const candidate of candidates) {
			try {
				await robotArm.restoreRecording({ ...exported, name: candidate });
				restoredAs = candidate;
				break;
			} catch (err) {
				if (((err as Error).message ?? '').includes('robot-arm 409')) continue;
				return fail(502, { error: `Could not restore "${row.name}": ${recordingMessage(err)}` });
			}
		}
		if (!restoredAs) {
			return fail(409, {
				error: `"${row.name}" and its -recovered names are all taken on the Pi. Rename or delete one first.`
			});
		}

		await RobotArmDeletedRecording.updateOne(
			{ _id: id },
			{
				$set: {
					recoveredAt: new Date(),
					recoveredBy: { _id: locals.user._id, username: locals.user.username },
					recoveredAs: restoredAs
				}
			}
		);
		await auditRecording(locals.user, 'robot_arm.recording.recover', id, {
			name: row.name,
			restoredAs
		});
		return {
			success:
				restoredAs === stem
					? `"${row.name}" recovered to the Pi.`
					: `"${row.name}" recovered to the Pi as "${restoredAs}" (the original name was taken).`
		};
	},

	startTeleop: async ({ request, locals }) => {
		if (!locals.user) return fail(401, { error: 'Unauthorized' });
		requirePermission(locals.user, 'manufacturing:write');
		const data = await request.formData();
		const rate = parseInt(data.get('rate_hz')?.toString() || '30', 10);
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
		const rate = parseInt(data.get('rate_hz')?.toString() || '30', 10);
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
			tableName: 'robot_arm_runs',
			recordId: runId,
			action: 'robot_arm.task.start',
			newData: { task_name: name, lot_id: lot ?? null, dry_run: true, userId: locals.user._id },
			changedBy: locals.user.username
		});

		return { success: `task "${name}" started`, runId };
	},

	// Solenoid pulses on the arm Pi's GPIO (cartridge chute). Pins are named by
	// BCM number for now; the Pi enforces the allow-list and the 2 s cap, so a
	// tampered form cannot hold a coil on. Deliberately NOT gated on the arm
	// session: manual testing fires these while teleop is running.
	pulseGpio: async ({ request, locals }) => {
		if (!locals.user) return fail(401, { error: 'Unauthorized' });
		requirePermission(locals.user, 'manufacturing:write');
		const data = await request.formData();
		const pin = parseInt(data.get('pin')?.toString() || '', 10);
		const ms = parseGpioMs(data.get('pulse_ms'), GPIO_PULSE_DEFAULT_MS);
		if (!GPIO_PINS.includes(pin)) {
			return fail(400, { error: `pin must be one of ${GPIO_PINS.join(', ')}` });
		}
		if (ms === null) {
			return fail(400, { error: `pulse must be ${GPIO_PULSE_MIN_MS}-${GPIO_PULSE_MAX_MS} ms` });
		}
		try {
			const result = await robotArm.pulseGpio({ pin, ms });
			await auditGpio(locals.user, 'robot_arm.gpio.pulse', { pin, ms, simulated: result.simulated });
			return {
				success: `GPIO ${pin} pulsed for ${ms} ms${result.simulated ? ' (simulated - no GPIO on the Pi)' : ''}`
			};
		} catch (err) {
			return fail(gpioStatus(err), { error: gpioMessage(err) });
		}
	},

	// GPIO 17 then GPIO 27, each for pulse_ms, with gap_ms between. This is the
	// manual version of the chute drop; the automatic between-loops version is
	// deliberately not built yet.
	pulseSequence: async ({ request, locals }) => {
		if (!locals.user) return fail(401, { error: 'Unauthorized' });
		requirePermission(locals.user, 'manufacturing:write');
		const data = await request.formData();
		const ms = parseGpioMs(data.get('pulse_ms'), GPIO_PULSE_DEFAULT_MS);
		const gap = parseGpioGap(data.get('gap_ms'));
		if (ms === null) {
			return fail(400, { error: `pulse must be ${GPIO_PULSE_MIN_MS}-${GPIO_PULSE_MAX_MS} ms` });
		}
		if (gap === null) return fail(400, { error: `gap must be 0-${GPIO_GAP_MAX_MS} ms` });
		try {
			const result = await robotArm.sequenceGpio({ pins: GPIO_PINS, ms, gap_ms: gap });
			await auditGpio(locals.user, 'robot_arm.gpio.sequence', {
				pins: GPIO_PINS,
				ms,
				gap_ms: gap,
				simulated: result.simulated
			});
			return {
				success: `GPIO ${GPIO_PINS.join(' then ')} pulsed for ${ms} ms each, ${gap} ms apart${result.simulated ? ' (simulated - no GPIO on the Pi)' : ''}`
			};
		} catch (err) {
			return fail(gpioStatus(err), { error: gpioMessage(err) });
		}
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
			// Operator rule (2026-10-21): a cancelled run leaves the arm holding
			// where it is, never limp. One retry: the Pi may still be releasing
			// the session's bus when the first request lands.
			let torqueOn = false;
			let torqueError: string | null = null;
			for (let i = 0; i < 2 && !torqueOn; i++) {
				if (i) await new Promise((r) => setTimeout(r, 600));
				try {
					await robotArm.setTorque(true);
					torqueOn = true;
				} catch (e) {
					torqueError = (e as Error).message;
				}
			}
			await AuditLog.create({
				_id: generateId(),
				tableName: 'robot_arm_runs',
				recordId: result.stopped_run_id ?? heldRunId ?? 'none',
				action: 'robot_arm.session.stop',
				changedBy: locals.user.username,
				newData: {
					userId: locals.user._id,
					stopped_run_id: result.stopped_run_id ?? null,
					held_by: heldBy,
					stopped_by: locals.user.username,
					override: heldBy !== null && heldBy !== locals.user.username,
					torque_on: torqueOn,
					torque_error: torqueOn ? null : torqueError
				}
			});
			const stopped = `stop signal sent (${result.stopped_run_id ?? 'no active session'})`;
			return torqueOn
				? { success: `${stopped}; torque re-enabled — the arm is holding its position.` }
				: { warning: `${stopped}, but torque could NOT be re-enabled (${torqueError}) — the arm may be limp; enable torque before leaving it.` };
		} catch (err) {
			return fail(500, { error: (err as Error).message });
		}
	}
};
