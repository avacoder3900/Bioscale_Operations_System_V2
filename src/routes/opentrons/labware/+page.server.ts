import { redirect } from '@sveltejs/kit';
import { connectDB, OpentronsRobot, LabwareDefinition } from '$lib/server/db';
import { requirePermission } from '$lib/server/permissions';
import type { PageServerLoad } from './$types';

export const load: PageServerLoad = async ({ locals }) => {
	if (!locals.user) redirect(302, '/login');
	requirePermission(locals.user, 'manufacturing:read');
	await connectDB();

	const [defs, robots] = await Promise.all([
		LabwareDefinition.find()
			.select('namespace loadName version displayName category fileName uploadedBy updatedAt')
			.sort({ loadName: 1 }).lean(),
		OpentronsRobot.find({ isActive: true }).select('protocols').lean()
	]);

	// Usage count per loadName across robot protocols (best-effort; labwareDefinitions
	// may be an object keyed by loadName or an array of {loadName}).
	const usage = new Map<string, number>();
	for (const r of robots as any[]) {
		for (const p of r.protocols ?? []) {
			const lwd = p.labwareDefinitions;
			if (Array.isArray(lwd)) {
				for (const d of lwd) { const ln = d?.loadName; if (ln) usage.set(ln, (usage.get(ln) ?? 0) + 1); }
			} else if (lwd && typeof lwd === 'object') {
				for (const ln of Object.keys(lwd)) usage.set(ln, (usage.get(ln) ?? 0) + 1);
			}
		}
	}

	return {
		labware: (defs as any[]).map((d) => ({
			id: String(d._id),
			namespace: d.namespace,
			loadName: d.loadName,
			version: d.version ?? 1,
			displayName: d.displayName ?? d.loadName,
			category: d.category ?? 'Other',
			fileName: d.fileName ?? '',
			uploadedBy: d.uploadedBy ?? '',
			updatedAt: d.updatedAt ? new Date(d.updatedAt).toISOString() : '',
			usedIn: usage.get(d.loadName) ?? 0
		}))
	};
};

export const config = { maxDuration: 60 };
