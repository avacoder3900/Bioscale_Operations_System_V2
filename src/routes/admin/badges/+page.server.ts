/**
 * Badge Portal (BADGE-SYSTEM_PLAN.md §17.1 / §17.5) — admin only.
 * Issue, revoke, reissue printed QR badges, and flip the "Require badge"
 * switch that gates bucket mint / start-pass. Every action re-checks
 * isAdmin() itself; the layout tab is only a convenience.
 */
import { error, fail, redirect } from '@sveltejs/kit';
import { connectDB, User } from '$lib/server/db';
import { isAdmin } from '$lib/server/permissions';
import {
	BadgeError, badgeSettings, setBadgeMode, issueBadge, revokeBadge, reissueBadge, listBadges
} from '$lib/server/services/badge-service';
import type { Actions, PageServerLoad } from './$types';

function requireAdmin(locals: App.Locals) {
	if (!locals.user) redirect(302, '/login');
	if (!isAdmin(locals.user)) throw error(403, 'Admin access required');
	return { _id: locals.user._id, username: locals.user.username };
}

export const load: PageServerLoad = async ({ locals }) => {
	requireAdmin(locals);
	await connectDB();
	const [badges, settings, users] = await Promise.all([
		listBadges(),
		badgeSettings(),
		User.find({ isActive: { $ne: false } }).select('_id username firstName lastName').sort({ username: 1 }).lean() as Promise<any[]>
	]);
	const holders = new Set(badges.filter(b => b.status === 'active').map(b => b.userId));
	return {
		badges,
		settings,
		// Only users who do not already hold an active badge can be issued one.
		candidates: users
			.filter(u => !holders.has(u._id))
			.map(u => ({
				id: u._id,
				username: u.username,
				defaultName: [u.firstName, u.lastName].filter(Boolean).join(' ').trim() || u.username
			}))
	};
};

function wrap(key: string, fn: () => Promise<Record<string, unknown>>) {
	return async () => {
		try {
			return await fn();
		} catch (e) {
			if (e instanceof BadgeError) return fail(e.status, { [key]: { error: e.message, code: e.code ?? null } });
			throw e;
		}
	};
}

export const actions: Actions = {
	issue: async ({ request, locals }) => {
		const by = requireAdmin(locals);
		await connectDB();
		const d = await request.formData();
		return wrap('issue', async () => {
			const badge = await issueBadge({
				userId: String(d.get('userId') ?? ''),
				displayName: String(d.get('displayName') ?? ''),
				issuedBy: by
			});
			return { issue: { success: true, badge } };
		})();
	},

	revoke: async ({ request, locals }) => {
		const by = requireAdmin(locals);
		await connectDB();
		const d = await request.formData();
		return wrap('revoke', async () => {
			const badge = await revokeBadge({ badgeId: String(d.get('badgeId') ?? ''), reason: String(d.get('reason') ?? ''), by });
			return { revoke: { success: true, badge } };
		})();
	},

	reissue: async ({ request, locals }) => {
		const by = requireAdmin(locals);
		await connectDB();
		const d = await request.formData();
		return wrap('reissue', async () => {
			const r = await reissueBadge({ badgeId: String(d.get('badgeId') ?? ''), by });
			return { reissue: { success: true, badge: r.issued, revoked: r.revoked } };
		})();
	},

	// The enforcement switch (§17.5). Admin only — a non-admin POST gets the 403
	// from requireAdmin before the body is read.
	setBadgeMode: async ({ request, locals }) => {
		const by = requireAdmin(locals);
		await connectDB();
		const d = await request.formData();
		return wrap('setBadgeMode', async () => {
			const mode = String(d.get('mode') ?? '') === 'off' ? 'off' : 'required';
			const settings = await setBadgeMode({ mode, reason: String(d.get('reason') ?? ''), user: by });
			return { setBadgeMode: { success: true, settings } };
		})();
	}
};
