/**
 * Robot Arm — Sync Zero Calibration.
 *
 * Captures a persistent matched reference pose for leader + follower.
 * Once captured, every teleop/record session starts from that calibrated
 * neutral instead of locking neutrals to whatever pose the arms are in
 * at GO time. The host side persists this to calibrations/sync_zero.json
 * on alejandros-pc; nothing about it lives in MongoDB.
 *
 * Live deltas (current minus saved) are read on every page load so the
 * operator can verify alignment before pressing GO on the control page.
 */
import { fail, redirect } from '@sveltejs/kit';
import { connectDB, AuditLog, LabwareDefinition, generateId } from '$lib/server/db';
import { requirePermission } from '$lib/server/permissions';
import { robotArm } from '$lib/server/robot-arm-client';
import type { Actions, PageServerLoad } from './$types';
// Bundled with the app (Vite JSON import) so "register" works on Vercel too,
// where loose repo files are not on disk at runtime.
import bundledNestDef from '../../../../../../protocols/labware/brevitest_arm_nest_1_gen7cartridge.json';

/**
 * ARM-WAX tooling (labware JSONs) — project-scoped section of this page.
 *
 * The wax-fill run needs custom labware the stock Opentrons library doesn't
 * have (the arm-facing cartridge nest today; trays/fixtures later). Tooling
 * registered here lands in the same LabwareDefinition library that is
 * auto-bundled with every protocol upload (LABWARE-LIBRARY-AUTO-BUNDLE), so
 * adding a new fixture JSON requires no code change to reach the OT-2.
 */
const ARM_WAX_PROJECT = 'ARM-WAX-01';
const REQUIRED_TOOLING: { loadName: string; label: string; bundled: boolean }[] = [
	{
		loadName: 'brevitest_arm_nest_1_gen7cartridge',
		label: 'Arm nest — 1x Gen7 cartridge (deck slot 1)',
		bundled: true
	}
	// Future fixtures (multi-slot nest, wax reservoir adapter, gripper jig)
	// get a row here as they are designed.
];

const BUNDLED_DEFS: Record<string, unknown> = {
	brevitest_arm_nest_1_gen7cartridge: bundledNestDef
};

async function loadTooling() {
	const loadNames = REQUIRED_TOOLING.map((t) => t.loadName);
	const defs = await LabwareDefinition.find({
		$or: [{ project: ARM_WAX_PROJECT }, { loadName: { $in: loadNames } }]
	})
		.select('namespace loadName version displayName category fileName uploadedBy project updatedAt')
		.sort({ loadName: 1, version: -1 })
		.lean();
	const plain = JSON.parse(JSON.stringify(defs)) as any[];
	return {
		project: ARM_WAX_PROJECT,
		required: REQUIRED_TOOLING.map((t) => {
			const match = plain.filter((d) => d.loadName === t.loadName);
			return {
				...t,
				present: match.length > 0,
				version: match[0]?.version ?? null
			};
		}),
		defs: plain.map((d) => ({
			id: String(d._id),
			namespace: d.namespace,
			loadName: d.loadName,
			version: d.version ?? 1,
			displayName: d.displayName ?? d.loadName,
			uploadedBy: d.uploadedBy ?? '',
			project: d.project ?? null,
			updatedAt: d.updatedAt ?? ''
		}))
	};
}

/** Parse + validate an Opentrons labware definition, or return an error string. */
function parseLabwareDef(text: string):
	| { def: any; namespace: string; loadName: string; version: number }
	| { error: string } {
	let def: any;
	try {
		def = JSON.parse(text);
	} catch {
		return { error: 'Not valid JSON.' };
	}
	const namespace = def?.namespace;
	const loadName = def?.parameters?.loadName;
	const version = Number(def?.version ?? 1);
	if (!namespace || !loadName) {
		return { error: 'Not an Opentrons labware definition (missing namespace or parameters.loadName).' };
	}
	return { def, namespace, loadName, version };
}

async function upsertToolingDef(
	parsed: { def: any; namespace: string; loadName: string; version: number },
	fileName: string,
	user: { _id: string; username: string }
) {
	const { def, namespace, loadName, version } = parsed;
	const displayName = def?.metadata?.displayName ?? loadName;
	const category = def?.metadata?.displayCategory ?? 'Other';
	await LabwareDefinition.findOneAndUpdate(
		{ namespace, loadName, version },
		{
			$set: {
				displayName,
				category,
				fileName,
				definition: def,
				uploadedBy: user.username,
				project: ARM_WAX_PROJECT
			},
			$setOnInsert: { _id: generateId() }
		},
		{ upsert: true, new: true }
	);
	await AuditLog.create({
		_id: generateId(),
		tableName: 'labware_definitions',
		recordId: `${namespace}/${loadName}/${version}`,
		action: 'robot_arm.calibrate.tooling_upsert',
		changedBy: user.username,
		changedAt: new Date(),
		newData: { namespace, loadName, version, displayName, project: ARM_WAX_PROJECT }
	});
	return { namespace, loadName, version, displayName };
}

async function safeCalibration(live: boolean) {
	try {
		return await robotArm.getCalibration({ live });
	} catch (err) {
		return { error: (err as Error).message };
	}
}

async function safeJointMap(live: boolean) {
	try {
		return await robotArm.getJointMap({ live });
	} catch (err) {
		return { map: null, live: null, live_error: (err as Error).message };
	}
}

/**
 * `reachable` distinguishes "the host answered, nothing is running" from
 * "we could not ask". Both used to collapse to null, which made an
 * unreachable Pi look like an idle one and sent the load down the most
 * expensive path — two live reads that can only ever time out.
 */
async function safeActive() {
	try {
		const res = await robotArm.getActive();
		return { active: res.active, reachable: true };
	} catch {
		return { active: null, reachable: false };
	}
}

export const load: PageServerLoad = async ({ locals }) => {
	if (!locals.user) redirect(302, '/login');
	requirePermission(locals.user, 'manufacturing:read');

	const { active, reachable } = await safeActive();
	// Skip live reads if a session is active — bus is single-owner and the
	// host will return live_error anyway — and also if the host never
	// answered at all, since a live read would just burn its whole timeout.
	// Worst case is then 5s + 10s + 10s = 25s, inside the adapter's
	// maxDuration of 30 (svelte.config.js).
	const live = reachable && active === null;
	// Sequential, not Promise.all: both live reads open the same two serial
	// buses, and the Pi serialises them anyway. Firing them together just
	// makes one fail with a port-busy error.
	const calibration = await safeCalibration(live);
	const jointMap = await safeJointMap(live);

	// Tooling list is DB-only — independent of arm-host reachability.
	await connectDB();
	let tooling: Awaited<ReturnType<typeof loadTooling>> | { error: string };
	try {
		tooling = await loadTooling();
	} catch (err) {
		tooling = { error: (err as Error).message };
	}

	return { active, reachable, calibration, jointMap, tooling };
};

export const actions: Actions = {
	capture: async ({ locals }) => {
		if (!locals.user) return fail(401, { error: 'Unauthorized' });
		requirePermission(locals.user, 'manufacturing:write');
		await connectDB();
		try {
			const record = await robotArm.captureCalibration({
				triggered_by: { _id: locals.user._id, username: locals.user.username }
			});
			await AuditLog.create({
				_id: generateId(),
				action: 'robot_arm.calibrate.capture',
				resourceType: 'robot_arm_calibration',
				resourceId: 'sync_zero',
				userId: locals.user._id,
				username: locals.user.username,
				timestamp: new Date(),
				details: {
					captured_at: record.captured_at,
					leader_positions: record.leader_positions,
					follower_positions: record.follower_positions
				}
			});
			return { success: 'Sync zero captured.', capturedAt: record.captured_at };
		} catch (err) {
			return fail(500, { error: (err as Error).message });
		}
	},

	clear: async ({ locals }) => {
		if (!locals.user) return fail(401, { error: 'Unauthorized' });
		requirePermission(locals.user, 'manufacturing:write');
		await connectDB();
		try {
			const res = await robotArm.clearCalibration();
			await AuditLog.create({
				_id: generateId(),
				action: 'robot_arm.calibrate.clear',
				resourceType: 'robot_arm_calibration',
				resourceId: 'sync_zero',
				userId: locals.user._id,
				username: locals.user.username,
				timestamp: new Date(),
				details: { removed: res.removed }
			});
			return res.removed
				? { success: 'Saved sync zero cleared. Teleop will lock neutrals at GO.' }
				: { success: 'No saved sync zero to clear.' };
		} catch (err) {
			return fail(500, { error: (err as Error).message });
		}
	},

	// --- multi-pose joint map ---

	capturePose: async ({ locals }) => {
		if (!locals.user) return fail(401, { error: 'Unauthorized' });
		requirePermission(locals.user, 'manufacturing:write');
		await connectDB();
		try {
			const map = await robotArm.capturePose({
				triggered_by: { _id: locals.user._id, username: locals.user.username }
			});
			// Field names must match auditLogSchema (tableName/recordId/
			// changedBy/changedAt/newData). Mongoose strict mode silently
			// DROPS unknown paths on create, so a resourceType/userId/details
			// shape persists as {_id, action, changedAt} — an audit row that
			// looks written but records nothing.
			await AuditLog.create({
				_id: generateId(),
				tableName: 'robot_arm_calibration',
				recordId: 'joint_map',
				action: 'robot_arm.calibrate.capture_pose',
				changedBy: locals.user.username,
				changedAt: new Date(),
				newData: {
					n_poses: map.fit.n_poses,
					fitted_at: map.fit.fitted_at,
					scale: map.fit.scale,
					offset: map.fit.offset,
					status: map.fit.status
				}
			});
			return { success: `Pose ${map.fit.n_poses} captured.`, nPoses: map.fit.n_poses };
		} catch (err) {
			return fail(500, { error: (err as Error).message });
		}
	},

	deletePose: async ({ locals, request }) => {
		if (!locals.user) return fail(401, { error: 'Unauthorized' });
		requirePermission(locals.user, 'manufacturing:write');
		await connectDB();

		const data = await request.formData();
		// Trim before testing: Number('   ') is 0, which would pass the
		// integer check and silently delete pose 0.
		const raw = data.get('index')?.toString().trim();
		const index = Number(raw);
		if (!raw || !Number.isInteger(index) || index < 0) {
			return fail(400, { error: 'A valid pose index is required.' });
		}

		try {
			const map = await robotArm.deletePose(index);
			await AuditLog.create({
				_id: generateId(),
				tableName: 'robot_arm_calibration',
				recordId: 'joint_map',
				action: 'robot_arm.calibrate.delete_pose',
				changedBy: locals.user.username,
				changedAt: new Date(),
				newData: {
					deleted_index: index,
					n_poses: map.fit.n_poses,
					status: map.fit.status
				}
			});
			return { success: `Pose ${index} deleted. Refitted on ${map.fit.n_poses} pose(s).` };
		} catch (err) {
			return fail(500, { error: (err as Error).message });
		}
	},

	clearMap: async ({ locals }) => {
		if (!locals.user) return fail(401, { error: 'Unauthorized' });
		requirePermission(locals.user, 'manufacturing:write');
		await connectDB();
		try {
			const res = await robotArm.clearJointMap();
			await AuditLog.create({
				_id: generateId(),
				tableName: 'robot_arm_calibration',
				recordId: 'joint_map',
				action: 'robot_arm.calibrate.clear_map',
				changedBy: locals.user.username,
				changedAt: new Date(),
				newData: { removed: res.removed }
			});
			return res.removed
				? { success: 'Joint map cleared. Teleop reverts to a 1:1 mirror.' }
				: { success: 'No saved joint map to clear.' };
		} catch (err) {
			return fail(500, { error: (err as Error).message });
		}
	},

	// --- ARM-WAX tooling (labware JSONs) ---

	uploadTooling: async ({ request, locals }) => {
		if (!locals.user) return fail(401, { error: 'Unauthorized' });
		requirePermission(locals.user, 'manufacturing:write');
		await connectDB();

		const fd = await request.formData();
		const file = fd.get('labwareFile');
		if (!(file instanceof File) || file.size === 0) {
			return fail(400, { error: 'Choose a labware .json file first.' });
		}
		const parsed = parseLabwareDef(await file.text());
		if ('error' in parsed) return fail(400, { error: parsed.error });

		try {
			const saved = await upsertToolingDef(parsed, file.name, locals.user);
			return {
				success: `Registered ${saved.displayName} (${saved.loadName} v${saved.version}) to ${ARM_WAX_PROJECT}. It will be bundled with the next protocol upload.`
			};
		} catch (err) {
			return fail(500, { error: (err as Error).message });
		}
	},

	registerBundled: async ({ request, locals }) => {
		if (!locals.user) return fail(401, { error: 'Unauthorized' });
		requirePermission(locals.user, 'manufacturing:write');
		await connectDB();

		const fd = await request.formData();
		const loadName = fd.get('loadName')?.toString() ?? '';
		const bundled = BUNDLED_DEFS[loadName];
		if (!bundled) return fail(400, { error: `No bundled definition for "${loadName}".` });

		const parsed = parseLabwareDef(JSON.stringify(bundled));
		if ('error' in parsed) return fail(500, { error: `Bundled JSON is invalid: ${parsed.error}` });

		try {
			const saved = await upsertToolingDef(parsed, `${loadName}.json`, locals.user);
			return {
				success: `Registered bundled ${saved.displayName} (${saved.loadName} v${saved.version}) to ${ARM_WAX_PROJECT}.`
			};
		} catch (err) {
			return fail(500, { error: (err as Error).message });
		}
	},

	removeTooling: async ({ request, locals }) => {
		if (!locals.user) return fail(401, { error: 'Unauthorized' });
		requirePermission(locals.user, 'manufacturing:write');
		await connectDB();

		const fd = await request.formData();
		const id = fd.get('id')?.toString();
		if (!id) return fail(400, { error: 'Missing definition id.' });

		try {
			const doc = await LabwareDefinition.findById(id)
				.select('namespace loadName version')
				.lean() as any;
			if (!doc) return fail(404, { error: 'Definition not found (already removed?).' });
			await LabwareDefinition.deleteOne({ _id: id });
			await AuditLog.create({
				_id: generateId(),
				tableName: 'labware_definitions',
				recordId: `${doc.namespace}/${doc.loadName}/${doc.version}`,
				action: 'robot_arm.calibrate.tooling_remove',
				changedBy: locals.user.username,
				changedAt: new Date(),
				newData: { removedId: id }
			});
			return { success: `Removed ${doc.loadName} v${doc.version} from the library.` };
		} catch (err) {
			return fail(500, { error: (err as Error).message });
		}
	}
};
