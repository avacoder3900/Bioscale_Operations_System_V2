/**
 * VOICE-01: Kanban → EOD check-in. One row per person, Monday–Friday across:
 * an X where that person sent an end-of-day voice note that day.
 *
 * Rows are the roster (KanbanPolicy.eodRoster, edited here by kanban:admin /
 * admins) plus anyone who sent a note in the week shown. A note counts for the
 * speaker it is filed under (initials in the title, else the webhook key) on its
 * lab day (US Central, 4 a.m. cutoff) — see voice-memos/checkin.ts.
 */
import { error, redirect } from '@sveltejs/kit';
import { connectDB, AuditLog, KanbanPolicy, User, VoiceMemo, generateId } from '$lib/server/db';
import { requirePermission, hasPermission, isAdmin } from '$lib/server/permissions';
import { getKanbanPolicy } from '$lib/server/kanban/policy';
import { initialsOf } from '$lib/server/voice-memos/speakers';
import { addDays, isDay, labDay, mondayOf, tally, weekdays } from '$lib/server/voice-memos/checkin';
import type { Actions, PageServerLoad } from './$types';

const canEdit = (user: App.Locals['user']) => !!user && (hasPermission(user, 'kanban:admin') || isAdmin(user));

export const load: PageServerLoad = async ({ locals, url }) => {
	if (!locals.user) redirect(302, '/login');
	requirePermission(locals.user, 'kanban:read');
	await connectDB();

	const today = labDay(new Date());
	const weekParam = url.searchParams.get('week');
	const monday = mondayOf(isDay(weekParam) ? weekParam : today);
	const days = weekdays(monday);

	// A day either side covers the timezone offset and the 4 a.m. cutoff.
	const [policy, memos, users]: [any, any[], any[]] = await Promise.all([
		getKanbanPolicy(),
		VoiceMemo.find({
			kind: 'eod',
			sourceDeletedAt: null,
			recordedAt: { $gte: new Date(`${addDays(monday, -1)}T00:00:00Z`), $lte: new Date(`${addDays(monday, 6)}T00:00:00Z`) }
		})
			.select('speaker recordedAt')
			.lean(),
		User.find({ isActive: { $ne: false } }).select('username firstName lastName').sort({ firstName: 1, username: 1 }).lean()
	]);

	const counts = tally(memos, days);
	const roster: string[] = policy?.eodRoster ?? [];
	const userByName = new Map(users.map((u) => [u.username, u]));
	const rowNames = [...new Set([...roster, ...counts.keys()])];

	const rows = rowNames
		.map((username) => {
			const u = userByName.get(username);
			const cells = days.map((d) => counts.get(username)?.get(d) ?? 0);
			return {
				username,
				name: [u?.firstName, u?.lastName].filter(Boolean).join(' ') || username,
				initials: (u ? initialsOf(u) : null) ?? username.slice(0, 2).toUpperCase(),
				onRoster: roster.includes(username),
				cells,
				sent: cells.filter((n) => n > 0).length
			};
		})
		.sort((a, b) => a.initials.localeCompare(b.initials) || a.name.localeCompare(b.name));

	return JSON.parse(
		JSON.stringify({
			monday,
			days,
			today,
			prevWeek: addDays(monday, -7),
			nextWeek: addDays(monday, 7),
			isThisWeek: monday === mondayOf(today),
			rows,
			canEdit: canEdit(locals.user),
			roster,
			people: users.map((u) => ({
				username: u.username,
				name: [u.firstName, u.lastName].filter(Boolean).join(' ') || u.username,
				initials: initialsOf(u) ?? ''
			}))
		})
	);
};

export const actions: Actions = {
	setRoster: async ({ request, locals }) => {
		if (!locals.user) redirect(302, '/login');
		if (!canEdit(locals.user)) error(403, 'Permission denied: requires kanban:admin');
		await connectDB();

		const picked = [...new Set((await request.formData()).getAll('username').map(String))];
		const active: any[] = await User.find({ username: { $in: picked }, isActive: { $ne: false } }).select('username').lean();
		const eodRoster = active.map((u) => u.username).sort();

		const before = (await getKanbanPolicy())?.eodRoster ?? [];
		const now = new Date();
		await KanbanPolicy.updateOne({ _id: 'default' }, { $set: { eodRoster, updatedBy: locals.user.username, updatedAt: now } });
		await AuditLog.create({
			_id: generateId(),
			tableName: 'kanban_policy',
			recordId: 'default',
			action: 'UPDATE',
			oldData: { eodRoster: before },
			newData: { eodRoster, via: 'ui' },
			changedBy: locals.user.username,
			changedAt: now
		});
		return { success: true };
	}
};
