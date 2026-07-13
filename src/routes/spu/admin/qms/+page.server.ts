import { fail } from '@sveltejs/kit';
import { requirePermission } from '$lib/server/permissions';
import { getQmsState, transitionQms } from '$lib/server/qms';
import { verifyPassword, writeAudit, recordSignature } from '$lib/server/qms-gate';
import { connectDB, QmsState } from '$lib/server/db';
import type { Actions, PageServerLoad } from './$types';

// QMS control is gated on admin:full — which the seeded Admin role already holds — so
// the feature is reachable without first re-seeding a brand-new qms:* permission.
const QMS_PERMISSION = 'admin:full';

export const load: PageServerLoad = async ({ locals }) => {
	requirePermission(locals.user, QMS_PERMISSION);
	await connectDB();
	const state = await getQmsState(true);
	const doc = (await QmsState.findById('default').lean()) as any;

	return {
		phase: state.phase,
		regulated: state.regulated,
		reauthWindowSec: state.reauthWindowSec,
		activatedAt: state.activatedAt ? new Date(state.activatedAt).toISOString() : null,
		activatedBy: state.activatedBy?.username ?? null,
		transitions: ((doc?.transitions ?? []) as any[])
			.slice()
			.reverse()
			.slice(0, 25)
			.map((t) => ({
				from: t.from,
				to: t.to,
				at: t.at ? new Date(t.at).toISOString() : null,
				by: t.by?.username ?? null,
				reason: t.reason ?? null
			}))
	};
};

/** Shared transition handler: verify password + reason, flip, audit, sign. */
async function doTransition(event: Parameters<Actions[string]>[0], to: 'configuration' | 'regulated') {
	const { request, locals } = event;
	requirePermission(locals.user, QMS_PERMISSION);
	await connectDB();

	const form = await request.formData();
	const password = form.get('password')?.toString();
	const reason = form.get('reason')?.toString().trim();

	if (!password) return fail(400, { error: 'Password is required to change the QMS environment.' });
	if (!reason) return fail(400, { error: 'A reason is required for this controlled transition.' });

	const ok = await verifyPassword(locals.user!._id, password);
	if (!ok) return fail(401, { error: 'Password incorrect.' });

	const before = await getQmsState(true);
	if (before.phase === to) {
		return fail(400, { error: `Already in ${to} mode.` });
	}

	const actor = { _id: locals.user!._id, username: locals.user!.username };
	await transitionQms(to, actor, reason);

	await recordSignature(event, {
		entityType: 'qms_state',
		entityId: 'default',
		meaning: to === 'regulated' ? 'Start QMS Regulated Environment' : 'Exit QMS Regulated Environment'
	});
	await writeAudit(event, {
		tableName: 'qms_state',
		recordId: 'default',
		action: 'UPDATE',
		oldData: { phase: before.phase },
		newData: { phase: to },
		changedFields: ['phase'],
		reason
	});

	return { success: true, phase: to };
}

export const actions: Actions = {
	activate: (event) => doTransition(event, 'regulated'),
	deactivate: (event) => doTransition(event, 'configuration')
};
