import { fail } from '@sveltejs/kit';
import { connectDB } from '$lib/server/db/connection';
import { PartDefinition } from '$lib/server/db/models';
import { hasPermission, requirePermission } from '$lib/server/permissions';
import { getDeviceAssemblyWI } from '$lib/server/services/device-assembly-wi';
import { BadgeError, badgeHolderCan, resolveBadge } from '$lib/server/services/badge-service';
import {
	BuildError,
	cancelBuild,
	handleScan,
	loadBoard,
	completeSection,
	recordUncataloguedPart,
	registerBucket,
	reopenSection,
	startBuild,
	undoScan,
	type BuildOperator,
	type BuildOutcome
} from '$lib/server/services/spu-build';
import type { Actions, PageServerLoad } from './$types';

// Build several SPUs at once against the SPU Assembly WI: one bucket per SPU.
// See $lib/server/services/spu-build for the rules.

export const load: PageServerLoad = async ({ locals }) => {
	requirePermission(locals.user, 'spu:read');
	await connectDB();

	const [wi, board] = await Promise.all([getDeviceAssemblyWI(), loadBoard()]);

	// Live on-hand counts for every catalog-linked part on the WI.
	const stock: Record<string, number> = {};
	if (wi) {
		const ids = new Set<string>();
		for (const s of wi.sections) for (const st of s.steps) for (const m of st.materials) if (m.kind === 'part' && m.partDefinitionId) ids.add(m.partDefinitionId);
		if (ids.size) {
			const parts = await PartDefinition.find({ _id: { $in: [...ids] } }).select('inventoryCount').lean();
			for (const p of parts as any[]) stock[String(p._id)] = p.inventoryCount ?? 0;
		}
	}

	return {
		// Only what the page draws: revisions, front matter and source-file details stay on the WI page.
		wi: wi
			? { _id: wi._id, title: wi.title, documentNumber: wi.documentNumber, currentVersion: wi.currentVersion, sections: wi.sections }
			: null,
		builds: board.builds,
		nextBuildNumber: board.nextBuildNumber,
		buckets: board.buckets,
		nextBucketNumber: board.nextBucketNumber,
		stock,
		canBuild: hasPermission(locals.user, 'spu:write')
	};
};

function str(v: FormDataEntryValue | null): string {
	return (v ?? '').toString();
}

function num(v: FormDataEntryValue | null): number | null {
	if (v == null || v === '') return null;
	const n = Number(v);
	return Number.isFinite(n) ? n : null;
}

/**
 * Who the work is recorded against. A badge scanned at the gate attributes it to
 * the badge holder (re-resolved on every request, never trusted from the page);
 * a typed name is recorded as given, attributed to the signed-in account.
 */
async function operatorFrom(form: FormData, locals: App.Locals): Promise<BuildOperator> {
	const badge = str(form.get('badge')).trim();
	if (badge) {
		const holder = await resolveBadge(badge);
		if (!badgeHolderCan(holder, 'spu:write')) throw new BuildError(`${holder.displayName} is not allowed to build SPUs.`);
		return { name: holder.displayName, user: holder.user, badgeCode: holder.code };
	}
	const name = str(form.get('operatorName')).trim().slice(0, 80);
	if (!name) throw new BuildError('Enter your name before you start.');
	return { name, user: { _id: locals.user!._id, username: locals.user!.username } };
}

/** A picked reason plus an optional note; "Other" means the note is the reason. */
function reasonFrom(form: FormData): string {
	const pick = str(form.get('reason')).trim();
	const note = str(form.get('note')).trim();
	if (!pick || pick === 'Other') return note;
	return note ? `${pick}: ${note}` : pick;
}

async function respond<T extends BuildOutcome>(fn: () => Promise<T>) {
	try {
		return { success: true as const, ...(await fn()) };
	} catch (e) {
		if (e instanceof BuildError || e instanceof BadgeError) return fail(400, { error: e.message });
		console.error('[spu-build]', e);
		return fail(500, { error: 'Something went wrong recording that. Reload the page and check Inventory deductions before scanning again.' });
	}
}

export const actions: Actions = {
	// Gate: resolve a scanned badge to the holder's name (typed names never reach the server here).
	identify: async ({ request, locals }) => {
		requirePermission(locals.user, 'spu:write');
		await connectDB();
		const form = await request.formData();
		const code = str(form.get('badge')).trim();
		try {
			const holder = await resolveBadge(code);
			if (!badgeHolderCan(holder, 'spu:write')) return fail(403, { error: `${holder.displayName} is not allowed to build SPUs.` });
			return { success: true as const, operator: { name: holder.displayName, badgeCode: holder.code } };
		} catch (e) {
			if (e instanceof BadgeError) return fail(400, { error: e.message });
			console.error('[spu-build] identify', e);
			return fail(500, { error: 'Could not read that badge. Try again or type your name.' });
		}
	},

	// Add a QR code as the next bucket number. start=1 (from a scan of an unknown
	// QR code) also starts the SPU in it straight away; the "Add a new bucket"
	// button only registers it.
	registerBucket: async ({ request, locals }) => {
		requirePermission(locals.user, 'spu:write');
		await connectDB();
		const form = await request.formData();
		const andStart = str(form.get('start')) === '1';
		return respond(async () => {
			const op = await operatorFrom(form, locals);
			const added = await registerBucket({ qrCode: str(form.get('qrCode')) }, op);
			if (!added.bucketId) return added;
			if (!andStart) {
				return added.kind === 'ok' ? { ...added, message: `${added.message} Scan it any time to start building in it.` } : added;
			}
			const started = await startBuild({ bucketId: added.bucketId }, op);
			// a brand-new bucket says so; one that was already registered just starts
			return { ...started, message: added.kind === 'ok' ? `${added.message} ${started.message}` : started.message };
		});
	},

	// Everything from the scan bar: buckets (open / new) and bag lot labels. See handleScan().
	scan: async ({ request, locals }) => {
		requirePermission(locals.user, 'spu:write');
		await connectDB();
		const form = await request.formData();
		const buildId = str(form.get('buildId')) || null;
		const sectionNumber = num(form.get('sectionNumber'));
		return respond(async () => handleScan({ code: str(form.get('code')), buildId, sectionNumber }, await operatorFrom(form, locals)));
	},

	recordPart: async ({ request, locals }) => {
		requirePermission(locals.user, 'spu:write');
		await connectDB();
		const form = await request.formData();
		const buildId = str(form.get('buildId'));
		const sectionNumber = num(form.get('sectionNumber'));
		const stepId = str(form.get('stepId'));
		const materialId = str(form.get('materialId'));
		if (!buildId || sectionNumber == null || !stepId || !materialId) return fail(400, { error: 'Part reference missing. Reload the page.' });
		return respond(async () => recordUncataloguedPart({ buildId, sectionNumber, stepId, materialId }, await operatorFrom(form, locals)));
	},

	// One button at the end of a section's steps: the operator confirms the whole section done.
	completeSection: async ({ request, locals }) => {
		requirePermission(locals.user, 'spu:write');
		await connectDB();
		const form = await request.formData();
		const buildId = str(form.get('buildId'));
		const sectionNumber = num(form.get('sectionNumber'));
		if (!buildId || sectionNumber == null) return fail(400, { error: 'Section reference missing. Reload the page.' });
		return respond(async () => completeSection({ buildId, sectionNumber }, await operatorFrom(form, locals)));
	},

	// ── corrections ──
	undoScan: async ({ request, locals }) => {
		requirePermission(locals.user, 'spu:write');
		await connectDB();
		const form = await request.formData();
		const buildId = str(form.get('buildId'));
		const scanId = str(form.get('scanId'));
		if (!buildId || !scanId) return fail(400, { error: 'Scan reference missing. Reload the page.' });
		return respond(async () => undoScan({ buildId, scanId, reason: reasonFrom(form) }, await operatorFrom(form, locals)));
	},

	reopenSection: async ({ request, locals }) => {
		requirePermission(locals.user, 'spu:write');
		await connectDB();
		const form = await request.formData();
		const buildId = str(form.get('buildId'));
		const sectionNumber = num(form.get('sectionNumber'));
		if (!buildId || sectionNumber == null) return fail(400, { error: 'Section reference missing. Reload the page.' });
		return respond(async () => reopenSection({ buildId, sectionNumber, reason: reasonFrom(form) }, await operatorFrom(form, locals)));
	},

	cancelBuild: async ({ request, locals }) => {
		requirePermission(locals.user, 'spu:write');
		await connectDB();
		const form = await request.formData();
		const buildId = str(form.get('buildId'));
		if (!buildId) return fail(400, { error: 'Build reference missing. Reload the page.' });
		const returnParts = str(form.get('parts')) !== 'keep';
		return respond(async () => cancelBuild({ buildId, reason: reasonFrom(form), returnParts }, await operatorFrom(form, locals)));
	}
};
