/**
 * KB2-38 — detailed capture. The whole item on one page shaped like the task
 * detail view, plus WHERE it lands (captured / processed / committed) and
 * WHERE in that list (position). Everything runs through captureTask(), the
 * same service the quick box, agent API and MCP use — a UI item and an agent
 * item are the same shape and pass the same gates.
 */
import { fail, redirect } from '@sveltejs/kit';
import { connectDB, KanbanTask, User } from '$lib/server/db';
import { requirePermission, hasPermission, isAdmin } from '$lib/server/permissions';
import { TransitionError } from '$lib/server/kanban/transition';
import { ReplenishError } from '$lib/server/kanban/replenish';
import { captureTask, isCaptureLanding, type CaptureLanding } from '$lib/server/kanban/capture';
import { normalizeTags } from '$lib/server/kanban/tags';
import { SIZING_DECISION_TEST } from '$lib/server/kanban/process';
import { getKanbanPolicy, queuePolicyOf } from '$lib/server/kanban/policy';
import {
	SIZE_CLASSES,
	CLASSES_OF_SERVICE,
	ITEM_TYPES,
	type KanbanSizeClass,
	type KanbanClassOfService,
	type KanbanItemType
} from '$lib/shared/kanban-status';
import type { PageServerLoad, Actions } from './$types';

export const load: PageServerLoad = async ({ locals, url }) => {
	if (!locals.user) redirect(302, '/login');
	requirePermission(locals.user, 'kanban:write');
	await connectDB();

	const policy = await getKanbanPolicy();
	const { readyCap } = queuePolicyOf(policy);
	const [tier1Count, readyCount, users, tags] = await Promise.all([
		KanbanTask.countDocuments({ status: { $in: ['captured', 'processed'] }, archived: false }),
		KanbanTask.countDocuments({ status: 'ready', archived: false }),
		User.find({ isActive: { $ne: false } }).select('_id username').sort({ username: 1 }).lean(),
		KanbanTask.distinct('tags')
	]);

	const landingParam = url.searchParams.get('landing');
	const canReplenish = hasPermission(locals.user, 'kanban:replenish') || isAdmin(locals.user);
	const initialLanding: CaptureLanding =
		isCaptureLanding(landingParam) && (landingParam !== 'committed' || canReplenish) ? landingParam : 'captured';

	return {
		canReplenish,
		initialLanding,
		tier1Count,
		ready: { count: readyCount, cap: readyCap },
		users: (users as any[]).map((u) => ({ id: String(u._id), username: u.username })),
		tagVocabulary: (tags as string[])
			.filter((t) => typeof t === 'string' && t.trim().length > 0)
			.sort((a, b) => a.localeCompare(b)),
		sizingDecisionTest: SIZING_DECISION_TEST,
		sizeClassDefinitions: {
			short: policy?.sizeClassDefinitions?.short ?? '',
			medium: policy?.sizeClassDefinitions?.medium ?? '',
			long: policy?.sizeClassDefinitions?.long ?? ''
		}
	};
};

function num(fd: FormData, key: string): number | undefined {
	const raw = fd.get(key)?.toString().trim();
	if (!raw) return undefined;
	const n = Number(raw);
	return Number.isFinite(n) && n > 0 ? n : undefined;
}

export const actions: Actions = {
	create: async ({ request, locals }) => {
		if (!locals.user) redirect(302, '/login');
		requirePermission(locals.user, 'kanban:write');
		await connectDB();
		const fd = await request.formData();

		const title = fd.get('title')?.toString().trim();
		if (!title) return fail(400, { error: 'Title is required' });

		const landingRaw = fd.get('landing')?.toString() ?? 'captured';
		if (!isCaptureLanding(landingRaw)) return fail(400, { error: 'Unknown landing' });
		const landing = landingRaw;

		const itemTypeRaw = fd.get('itemType')?.toString() || 'deliverable';
		if (!(ITEM_TYPES as readonly string[]).includes(itemTypeRaw)) return fail(400, { error: 'Unknown item type' });
		const itemType = itemTypeRaw as KanbanItemType;

		const sizeClassRaw = fd.get('sizeClass')?.toString() || undefined;
		if (sizeClassRaw && !(SIZE_CLASSES as readonly string[]).includes(sizeClassRaw)) {
			return fail(400, { error: 'A valid size class is required' });
		}
		const cosRaw = fd.get('classOfService')?.toString() || undefined;
		if (cosRaw && !(CLASSES_OF_SERVICE as readonly string[]).includes(cosRaw)) {
			return fail(400, { error: 'A valid class of service is required' });
		}

		const dueDateRaw = fd.get('dueDate')?.toString().trim();
		const dueDate = dueDateRaw ? new Date(dueDateRaw) : undefined;
		if (dueDate && Number.isNaN(dueDate.getTime())) return fail(400, { error: 'Due date is not a valid date' });
		if (itemType === 'milestone' && !dueDate) {
			return fail(400, { error: 'A milestone needs a due date — it is the hard anchor the roadmap schedules against.' });
		}

		let assignee: { _id: string; username: string } | null = null;
		const assignedTo = fd.get('assignedTo')?.toString();
		if (assignedTo) {
			const u = (await User.findById(assignedTo).select('_id username').lean()) as any;
			if (u) assignee = { _id: String(u._id), username: u.username };
		}

		const tags = await normalizeTags(fd.get('tags')?.toString() ?? '');

		let spike: { question: string; timebox: { amount: number; unit: 'hours' | 'days' } } | undefined;
		if (itemType === 'spike') {
			const question = fd.get('spikeQuestion')?.toString().trim() ?? '';
			const amount = num(fd, 'spikeTimeboxAmount');
			const unit = fd.get('spikeTimeboxUnit')?.toString() === 'hours' ? 'hours' : 'days';
			if (!question || !amount) {
				return fail(400, { error: 'An investigation needs its question and a timebox.' });
			}
			spike = { question, timebox: { amount, unit } };
		}

		const positionRaw = fd.get('position')?.toString().trim();
		const position = positionRaw ? parseInt(positionRaw, 10) : undefined;

		try {
			const result = await captureTask({
				title,
				description: fd.get('description')?.toString().trim() || undefined,
				itemType,
				spike,
				assignee,
				dueDate,
				tags,
				estimateDays: num(fd, 'estimateDays'),
				effortDays: num(fd, 'effortDays'),
				dor: {
					deliverable: fd.get('deliverable')?.toString().trim() || undefined,
					handoffBrief: fd.get('handoffBrief')?.toString().trim() || undefined
				},
				source: 'ui-detailed',
				landing,
				position,
				sizeClass: sizeClassRaw as KanbanSizeClass | undefined,
				classOfService: cosRaw as KanbanClassOfService | undefined,
				commitNote: fd.get('commitNote')?.toString().trim() || undefined,
				actor: { username: locals.user.username, via: 'ui' }
			});
			// Land where it can be seen in its slot.
			redirect(303, result.landing === 'committed' ? '/kanban' : '/kanban/inventory');
		} catch (e) {
			if (e instanceof TransitionError) return fail(400, { error: e.message, code: e.code });
			if (e instanceof ReplenishError) {
				return fail(e.code === 'PERMISSION_DENIED' ? 403 : 400, { error: e.message, code: e.code });
			}
			throw e;
		}
	}
};

export const config = { maxDuration: 60 };
