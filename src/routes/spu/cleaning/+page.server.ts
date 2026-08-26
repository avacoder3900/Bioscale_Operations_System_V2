import { fail } from '@sveltejs/kit';
import { requirePermission, hasPermission } from '$lib/server/permissions';
import {
	connectDB,
	CleaningArea,
	CleaningSchedule,
	CleaningRecord,
	AuditLog,
	generateId
} from '$lib/server/db';
import type { RequestEvent } from './$types';
import {
	expandOccurrences,
	occurrenceState,
	describeFrequency,
	monthKeyRange,
	addMonths,
	addDays,
	todayKey,
	isValidKey,
	isValidMonth,
	weekStart,
	type ScheduleLike
} from '$lib/server/cleaning/recurrence';
import type { Actions, PageServerLoad } from './$types';

/**
 * Audit writer for this route.
 *
 * Mirrors the AuditLog shape the rest of master uses (tableName / recordId /
 * action / changedBy / changedAt) while carrying the optional oldData, newData,
 * changedFields and reason columns the schema already supports. AuditLog has
 * immutable middleware applied — entries are append-only by design.
 */
async function writeAudit(
	event: RequestEvent,
	entry: {
		tableName: string;
		recordId: string;
		action: string;
		oldData?: unknown;
		newData?: unknown;
		changedFields?: string[];
		reason?: string;
	}
): Promise<void> {
	await AuditLog.create({
		_id: generateId(),
		...entry,
		changedBy: event.locals.user?.username,
		changedAt: new Date(),
		userAgent: event.request.headers.get('user-agent') ?? undefined
	});
}

/** How far back the "needs attention" list looks for missed cleanings. */
const OVERDUE_LOOKBACK_DAYS = 30;

interface OccurrenceRow {
	key: string;
	scheduleId: string;
	dueDate: string;
	title: string;
	areaId: string;
	areaName: string;
	color: string;
	instructions: string | null;
	assignedTo: string | null;
	cadence: string;
	state: string;
	record: {
		id: string;
		status: string;
		completedBy: string | null;
		completedAt: string | null;
		notes: string | null;
	} | null;
}

export const load: PageServerLoad = async ({ locals, url }) => {
	requirePermission(locals.user, 'cleaning:read');
	await connectDB();

	const today = todayKey();
	const monthParam = url.searchParams.get('month');
	const month = isValidMonth(monthParam) ? monthParam : today.slice(0, 7);
	const areaFilter = url.searchParams.get('area') ?? '';

	const { start: monthStart, end: monthEnd } = monthKeyRange(month);

	// The grid renders whole weeks, so pull the leading/trailing spill days too.
	const gridStart = weekStart(monthStart);
	const gridEnd = addDays(weekStart(monthEnd), 6);

	// The attention list can reach further back than the visible grid.
	const lookbackStart = addDays(today, -OVERDUE_LOOKBACK_DAYS);
	const fetchStart = lookbackStart < gridStart ? lookbackStart : gridStart;
	const fetchEnd = gridEnd > today ? gridEnd : today;

	const scheduleQuery: Record<string, unknown> = { isActive: true };
	if (areaFilter) scheduleQuery.areaId = areaFilter;

	const [areas, schedules, records] = await Promise.all([
		CleaningArea.find({ isActive: true }).sort({ sortOrder: 1, name: 1 }).lean(),
		CleaningSchedule.find(scheduleQuery).sort({ title: 1 }).lean(),
		CleaningRecord.find({ dueDate: { $gte: fetchStart, $lte: fetchEnd } }).lean()
	]);

	const areaById = new Map(areas.map((a: any) => [a._id, a]));

	// Index records by "scheduleId|dueDate" -- the same key the unique index uses.
	const recordByKey = new Map<string, any>();
	for (const r of records as any[]) recordByKey.set(`${r.scheduleId}|${r.dueDate}`, r);

	const buildRow = (s: any, dueDate: string): OccurrenceRow => {
		const key = `${s._id}|${dueDate}`;
		const rec = recordByKey.get(key);
		const area = areaById.get(s.areaId);
		return {
			key,
			scheduleId: s._id,
			dueDate,
			title: s.title,
			areaId: s.areaId,
			// Prefer the live area name, fall back to the schedule snapshot.
			areaName: area?.name ?? s.areaName ?? 'Unassigned area',
			color: area?.color ?? '#00d4ff',
			instructions: s.instructions ?? null,
			assignedTo: s.assignedTo?.username ?? null,
			cadence: describeFrequency(s.frequency),
			state: occurrenceState(dueDate, rec, today),
			record: rec
				? {
						id: rec._id,
						status: rec.status,
						completedBy: rec.completedBy?.username ?? null,
						completedAt: rec.completedAt ? new Date(rec.completedAt).toISOString() : null,
						notes: rec.notes ?? null
					}
				: null
		};
	};

	const gridRows: OccurrenceRow[] = [];
	const attentionRows: OccurrenceRow[] = [];
	// Today is tracked separately: it is not inside the grid window whenever the
	// user browses to another month, and the header stats must stay truthful.
	const todayRows: OccurrenceRow[] = [];

	for (const s of schedules as any[]) {
		const like: ScheduleLike = {
			_id: s._id,
			frequency: s.frequency,
			startDate: s.startDate,
			endDate: s.endDate ?? null
		};

		for (const due of expandOccurrences(like, gridStart, gridEnd)) {
			gridRows.push(buildRow(s, due));
		}

		for (const due of expandOccurrences(like, today, today)) {
			todayRows.push(buildRow(s, due));
		}

		// Missed cleanings: strictly before today, still unrecorded.
		for (const due of expandOccurrences(like, lookbackStart, addDays(today, -1))) {
			if (!recordByKey.has(`${s._id}|${due}`)) attentionRows.push(buildRow(s, due));
		}
	}

	todayRows.sort((a, b) => a.title.localeCompare(b.title));

	gridRows.sort((a, b) => a.dueDate.localeCompare(b.dueDate) || a.title.localeCompare(b.title));
	attentionRows.sort((a, b) => a.dueDate.localeCompare(b.dueDate) || a.title.localeCompare(b.title));

	// Bucket the grid by day so the UI does not re-scan the array per cell.
	const byDay: Record<string, OccurrenceRow[]> = {};
	for (const row of gridRows) (byDay[row.dueDate] ??= []).push(row);

	const days: string[] = [];
	for (let d = gridStart; d <= gridEnd; d = addDays(d, 1)) days.push(d);

	const monthRows = gridRows.filter((r) => r.dueDate >= monthStart && r.dueDate <= monthEnd);
	const completedThisMonth = monthRows.filter((r) => r.state === 'completed').length;

	// Recent sign-offs, newest first -- the "who cleaned what" feed.
	const recentActivity = (records as any[])
		.filter((r) => r.completedAt)
		.sort((a, b) => new Date(b.completedAt).getTime() - new Date(a.completedAt).getTime())
		.slice(0, 15)
		.map((r) => ({
			id: r._id,
			title: r.title ?? 'Cleaning',
			areaName: r.areaName ?? '',
			dueDate: r.dueDate,
			status: r.status,
			by: r.completedBy?.username ?? 'unknown',
			at: new Date(r.completedAt).toISOString(),
			notes: r.notes ?? null
		}));

	return {
		today,
		month,
		prevMonth: addMonths(month, -1),
		nextMonth: addMonths(month, 1),
		gridStart,
		gridEnd,
		monthStart,
		monthEnd,
		days,
		byDay,
		attention: attentionRows,
		dueToday: todayRows,
		recentActivity,
		areaFilter,
		areas: areas.map((a: any) => ({
			id: a._id,
			name: a.name,
			description: a.description ?? null,
			color: a.color ?? '#00d4ff'
		})),
		schedules: (schedules as any[]).map((s) => ({
			id: s._id,
			title: s.title,
			areaId: s.areaId,
			areaName: areaById.get(s.areaId)?.name ?? s.areaName ?? '',
			cadence: describeFrequency(s.frequency),
			startDate: s.startDate,
			endDate: s.endDate ?? null,
			assignedTo: s.assignedTo?.username ?? null
		})),
		stats: {
			schedules: schedules.length,
			areas: areas.length,
			dueToday: todayRows.filter((r) => r.state === 'due').length,
			overdue: attentionRows.length,
			completedThisMonth
		},
		canWrite: hasPermission(locals.user, 'cleaning:write'),
		canAdmin: hasPermission(locals.user, 'cleaning:admin')
	};
};

/** Confirm `dueDate` is genuinely an occurrence of this schedule before writing. */
async function resolveOccurrence(scheduleId: string, dueDate: string) {
	if (!scheduleId || !isValidKey(dueDate)) return null;
	const schedule: any = await CleaningSchedule.findById(scheduleId).lean();
	if (!schedule) return null;

	const hits = expandOccurrences(
		{
			_id: schedule._id,
			frequency: schedule.frequency,
			startDate: schedule.startDate,
			endDate: schedule.endDate ?? null
		},
		dueDate,
		dueDate
	);
	return hits.length === 1 ? schedule : null;
}

export const actions: Actions = {
	/** Sign off (or un-skip) a single occurrence. */
	complete: async (event) => {
		requirePermission(event.locals.user, 'cleaning:write');
		await connectDB();

		const form = await event.request.formData();
		const scheduleId = form.get('scheduleId')?.toString() ?? '';
		const dueDate = form.get('dueDate')?.toString() ?? '';
		const notes = form.get('notes')?.toString().trim() || undefined;
		const status = form.get('status')?.toString() === 'skipped' ? 'skipped' : 'completed';

		const schedule = await resolveOccurrence(scheduleId, dueDate);
		if (!schedule) return fail(400, { error: 'That is not a scheduled cleaning date.' });

		// Do not let someone sign off a cleaning that is not due yet.
		if (dueDate > todayKey()) {
			return fail(400, { error: 'Cannot sign off a cleaning before it is due.' });
		}

		const user = event.locals.user!;
		const existing: any = await CleaningRecord.findOne({ scheduleId, dueDate }).lean();

		const doc = {
			scheduleId,
			dueDate,
			areaId: schedule.areaId,
			areaName: schedule.areaName ?? undefined,
			title: schedule.title,
			status,
			completedBy: { _id: user._id, username: user.username },
			completedAt: new Date(),
			notes
		};

		const saved = await CleaningRecord.findOneAndUpdate(
			{ scheduleId, dueDate },
			{ $set: doc, $setOnInsert: { _id: generateId() } },
			{ upsert: true, new: true, setDefaultsOnInsert: true }
		).lean();

		await writeAudit(event, {
			tableName: 'cleaning_records',
			recordId: (saved as any)._id,
			action: existing ? 'UPDATE' : 'INSERT',
			oldData: existing ?? undefined,
			newData: saved,
			reason: status === 'skipped' ? 'Cleaning occurrence skipped' : 'Cleaning occurrence signed off'
		});

		return { success: true };
	},

	/**
	 * Clear a sign-off. The CleaningRecord is removed so the occurrence returns
	 * to "not done", but the AuditLog keeps an immutable DELETE entry carrying
	 * the full prior document -- nothing is silently lost.
	 */
	undo: async (event) => {
		requirePermission(event.locals.user, 'cleaning:write');
		await connectDB();

		const form = await event.request.formData();
		const scheduleId = form.get('scheduleId')?.toString() ?? '';
		const dueDate = form.get('dueDate')?.toString() ?? '';
		if (!scheduleId || !isValidKey(dueDate)) return fail(400, { error: 'Bad occurrence.' });

		const existing: any = await CleaningRecord.findOne({ scheduleId, dueDate }).lean();
		if (!existing) return fail(404, { error: 'No sign-off to undo.' });

		await CleaningRecord.deleteOne({ _id: existing._id });

		await writeAudit(event, {
			tableName: 'cleaning_records',
			recordId: existing._id,
			action: 'DELETE',
			oldData: existing,
			reason: 'Cleaning sign-off cleared'
		});

		return { success: true };
	},

	createArea: async (event) => {
		requirePermission(event.locals.user, 'cleaning:admin');
		await connectDB();

		const form = await event.request.formData();
		const name = form.get('name')?.toString().trim();
		if (!name) return fail(400, { error: 'Area name is required.' });

		const user = event.locals.user!;
		const area = await CleaningArea.create({
			_id: generateId(),
			name,
			description: form.get('description')?.toString().trim() || undefined,
			color: form.get('color')?.toString() || '#00d4ff',
			sortOrder: Number(form.get('sortOrder') ?? 0) || 0,
			isActive: true,
			createdBy: { _id: user._id, username: user.username }
		});

		await writeAudit(event, {
			tableName: 'cleaning_areas',
			recordId: area._id,
			action: 'INSERT',
			newData: area.toObject(),
			reason: 'Cleaning area created'
		});

		return { success: true };
	},

	createSchedule: async (event) => {
		requirePermission(event.locals.user, 'cleaning:admin');
		await connectDB();

		const form = await event.request.formData();
		const title = form.get('title')?.toString().trim();
		const areaId = form.get('areaId')?.toString() ?? '';
		const startDate = form.get('startDate')?.toString() ?? '';
		const kind = form.get('kind')?.toString() ?? 'weekly';

		if (!title) return fail(400, { error: 'Task title is required.' });
		if (!areaId) return fail(400, { error: 'Pick an area.' });
		if (!isValidKey(startDate)) return fail(400, { error: 'Start date is invalid.' });
		if (!['daily', 'weekly', 'monthly'].includes(kind)) {
			return fail(400, { error: 'Unknown frequency.' });
		}

		const endDate = form.get('endDate')?.toString() || undefined;
		if (endDate && !isValidKey(endDate)) return fail(400, { error: 'End date is invalid.' });
		if (endDate && endDate < startDate) {
			return fail(400, { error: 'End date cannot be before the start date.' });
		}

		const area: any = await CleaningArea.findById(areaId).lean();
		if (!area) return fail(400, { error: 'That area no longer exists.' });

		const daysOfWeek = form
			.getAll('daysOfWeek')
			.map((d) => Number(d))
			.filter((d) => Number.isInteger(d) && d >= 0 && d <= 6);

		if (kind === 'weekly' && daysOfWeek.length === 0) {
			return fail(400, { error: 'Pick at least one day of the week.' });
		}

		const interval = Math.max(1, Math.min(52, Number(form.get('interval') ?? 1) || 1));
		const dayOfMonth = Math.max(1, Math.min(31, Number(form.get('dayOfMonth') ?? 1) || 1));

		const assignedToId = form.get('assignedTo')?.toString() || '';
		const assignedToName = form.get('assignedToName')?.toString() || '';

		const user = event.locals.user!;
		const schedule = await CleaningSchedule.create({
			_id: generateId(),
			areaId,
			areaName: area.name,
			title,
			instructions: form.get('instructions')?.toString().trim() || undefined,
			frequency: {
				kind,
				interval,
				daysOfWeek: kind === 'weekly' ? daysOfWeek : [],
				dayOfMonth: kind === 'monthly' ? dayOfMonth : undefined
			},
			startDate,
			endDate,
			assignedTo: assignedToId ? { _id: assignedToId, username: assignedToName } : undefined,
			isActive: true,
			createdBy: { _id: user._id, username: user.username }
		});

		await writeAudit(event, {
			tableName: 'cleaning_schedules',
			recordId: schedule._id,
			action: 'INSERT',
			newData: schedule.toObject(),
			reason: 'Cleaning schedule created'
		});

		return { success: true };
	},

	/** Retire a schedule. History (CleaningRecords) is deliberately kept. */
	retireSchedule: async (event) => {
		requirePermission(event.locals.user, 'cleaning:admin');
		await connectDB();

		const form = await event.request.formData();
		const scheduleId = form.get('scheduleId')?.toString() ?? '';

		const existing: any = await CleaningSchedule.findById(scheduleId).lean();
		if (!existing) return fail(404, { error: 'Schedule not found.' });

		const updated = await CleaningSchedule.findByIdAndUpdate(
			scheduleId,
			{ $set: { isActive: false } },
			{ new: true }
		).lean();

		await writeAudit(event, {
			tableName: 'cleaning_schedules',
			recordId: scheduleId,
			action: 'UPDATE',
			oldData: existing,
			newData: updated,
			changedFields: ['isActive'],
			reason: 'Cleaning schedule retired'
		});

		return { success: true };
	}
};
