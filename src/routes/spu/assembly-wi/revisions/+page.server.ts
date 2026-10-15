import { fail } from '@sveltejs/kit';
import { connectDB } from '$lib/server/db/connection';
import { hasPermission, requirePermission } from '$lib/server/permissions';
import { getDeviceAssemblyWI, listSnapshots, revertToVersion } from '$lib/server/services/device-assembly-wi';
import { getRecentPulls } from '$lib/server/services/device-assembly-wi-pulls';
import type { Actions, PageServerLoad } from './$types';

export const load: PageServerLoad = async ({ locals }) => {
	requirePermission(locals.user, 'spu:read');
	await connectDB();
	const wi = await getDeviceAssemblyWI();
	const revisions = wi ? [...wi.revisions].sort((a: any, b: any) => b.version - a.version) : [];
	const pulls = wi ? await getRecentPulls(wi._id, 500) : [];
	const restorable = wi ? (await listSnapshots(wi._id)).map((s) => s.version) : [];
	return {
		restorable,
		canEdit: hasPermission(locals.user, 'spu:write'),
		wi: wi ? { _id: wi._id, documentNumber: wi.documentNumber, title: wi.title, currentVersion: wi.currentVersion, lastChangedBy: wi.lastChangedBy, lastChangedAt: wi.lastChangedAt } : null,
		revisions,
		pulls
	};
};

export const actions: Actions = {
	revert: async ({ request, locals }) => {
		requirePermission(locals.user, 'spu:write');
		await connectDB();
		const form = await request.formData();
		const version = Number(form.get('version'));
		if (!Number.isFinite(version)) return fail(400, { error: 'Version is required' });
		try {
			const r = await revertToVersion({ _id: locals.user!._id, username: locals.user!.username }, version, (form.get('reason') ?? '').toString() || undefined);
			return { success: true, message: `${r.summary} — now ${r.label}` };
		} catch (e: any) {
			return fail(400, { error: e?.message ?? String(e) });
		}
	}
};
