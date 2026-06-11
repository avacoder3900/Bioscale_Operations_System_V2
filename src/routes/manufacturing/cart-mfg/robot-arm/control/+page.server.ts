/**
 * Robot Arm — Remote Control.
 *
 * Form actions hit the Pi via robotArmClient. The Pi enforces
 * single-active-session and emits events through the existing webhook
 * pipeline; the run shows up in /manufacturing/cart-mfg/robot-arm/runs.
 */
import { fail, redirect } from '@sveltejs/kit';
import { connectDB } from '$lib/server/db/connection';
import { RobotArmDataset } from '$lib/server/db/models';
import { requirePermission } from '$lib/server/permissions';
import { robotArm } from '$lib/server/robot-arm-client';
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

export const load: PageServerLoad = async ({ locals }) => {
	if (!locals.user) redirect(302, '/login');
	requirePermission(locals.user, 'manufacturing:read');
	await connectDB();

	const [active, piRecordings, dbDatasets] = await Promise.all([
		safeActive(),
		safeRecordings(),
		RobotArmDataset.find({}).select('_id name path').sort({ recordedAt: -1 }).limit(50).lean()
	]);

	return {
		active,
		piRecordings,
		dbDatasets: JSON.parse(JSON.stringify(dbDatasets))
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

	stop: async ({ locals }) => {
		if (!locals.user) return fail(401, { error: 'Unauthorized' });
		requirePermission(locals.user, 'manufacturing:write');
		try {
			const result = await robotArm.stop();
			return { success: `stop signal sent (${result.stopped_run_id ?? 'no active session'})` };
		} catch (err) {
			return fail(500, { error: (err as Error).message });
		}
	}
};
