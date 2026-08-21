/**
 * KB2-03 — Processing (triage) + Tier 1 dispositions.
 *
 * Processing is the once-per-item decision that shapes a captured option:
 * size class + class of service are set BY THE PERSON PROCESSING (not the
 * author, not the eventual assignee — removes the inflation incentive),
 * plus a rank among the Tier 1 options and optionally the DoR fields.
 */
import { KanbanTask, KanbanTemplate, AuditLog, generateId, connectDB } from '$lib/server/db';
import { transitionTask, createKanbanItem, TransitionError, type TransitionVia } from './transition.js';
import type { KanbanClassOfService, KanbanSizeClass } from '$lib/shared/kanban-status';

/**
 * KB2-12 — the sizing decision test (canonical wording; also embedded in the
 * process modal + MCP tool descriptions). Size class is a measurement bucket,
 * never a promise: SLEs are computed from history.
 *
 *   Can you confidently pick a size?
 *   - Yes → deliverable; size it.
 *   - No, but you can name the next milestone → split; size the milestone.
 *   - No, and you can't name the milestone → spike; timebox the question.
 *   - None of the above → it's a project, not an item; only its milestones flow.
 */
export const SIZING_DECISION_TEST =
	"Can you confidently pick a size? Yes → deliverable, size it. No but you can name the next milestone → split and size the milestone (outcome = the milestone). No and you can't name the milestone → make it an investigation (itemType 'spike') and timebox the question instead. None of the above → it's a project, not an item — keep it upstream and let its milestones flow.";

export async function processTask(opts: {
	taskId: string;
	actorUsername: string;
	via: TransitionVia;
	sizeClass: KanbanSizeClass;
	classOfService: KanbanClassOfService;
	dueDate?: Date; // required when classOfService === 'fixed_date'
	/** KB2-27: workshopped estimate (duration) in working days (> 0). */
	estimateDays?: number;
	/** KB2-31: hands-on effort in working days when it differs from duration. */
	effortDays?: number;
	dor?: { deliverable?: string; handoffBrief?: string };
}) {
	await connectDB();
	const task: any = await KanbanTask.findById(opts.taskId).lean();
	if (!task) throw new TransitionError('NOT_FOUND', `Task ${opts.taskId} not found`);
	if (task.status !== 'captured') {
		throw new TransitionError('INVALID_STATUS', `Only 'captured' options can be processed (task is '${task.status}').`);
	}
	if (opts.classOfService === 'fixed_date' && !opts.dueDate && !task.dueDate) {
		throw new TransitionError('REASON_REQUIRED', "classOfService 'fixed_date' requires a real external dueDate.");
	}

	const $set: Record<string, unknown> = {
		sizeClass: opts.sizeClass,
		classOfService: opts.classOfService
	};
	if (opts.dueDate) $set.dueDate = opts.dueDate;
	if (typeof opts.estimateDays === 'number' && opts.estimateDays > 0) $set.estimateDays = opts.estimateDays;
	if (typeof opts.effortDays === 'number' && opts.effortDays > 0) $set.effortDays = opts.effortDays;
	if (typeof opts.effortDays === 'number' && opts.effortDays > 0) $set.effortDays = opts.effortDays;
	if (opts.dor?.deliverable !== undefined) $set['dor.deliverable'] = opts.dor.deliverable;
	if (opts.dor?.handoffBrief !== undefined) $set['dor.handoffBrief'] = opts.dor.handoffBrief;
	await KanbanTask.updateOne({ _id: opts.taskId }, { $set });

	await transitionTask({
		taskId: opts.taskId,
		to: 'processed',
		actor: { username: opts.actorUsername, via: opts.via }
	});
	return { taskId: opts.taskId, title: task.title };
}

/**
 * KB2-12 — reshape an already-processed item: edit size/class/DoR in place,
 * audited, no status change. (The unified Process modal uses processTask for
 * captured items and this for processed ones.)
 */
export async function reshapeTask(opts: {
	taskId: string;
	actorUsername: string;
	via: TransitionVia;
	sizeClass?: KanbanSizeClass;
	classOfService?: KanbanClassOfService;
	dueDate?: Date;
	/** KB2-27: workshopped estimate (duration) in working days (> 0). */
	estimateDays?: number;
	/** KB2-31: hands-on effort in working days when it differs from duration. */
	effortDays?: number;
	dor?: { deliverable?: string; handoffBrief?: string };
}) {
	await connectDB();
	const task: any = await KanbanTask.findById(opts.taskId).lean();
	if (!task) throw new TransitionError('NOT_FOUND', `Task ${opts.taskId} not found`);
	if (task.status !== 'processed') {
		throw new TransitionError('INVALID_STATUS', `reshape applies to 'processed' items (task is '${task.status}').`);
	}
	const $set: Record<string, unknown> = {};
	if (opts.sizeClass) $set.sizeClass = opts.sizeClass;
	if (opts.classOfService) $set.classOfService = opts.classOfService;
	if (opts.dueDate) $set.dueDate = opts.dueDate;
	if (typeof opts.estimateDays === 'number' && opts.estimateDays > 0) $set.estimateDays = opts.estimateDays;
	if (opts.dor?.deliverable !== undefined) $set['dor.deliverable'] = opts.dor.deliverable;
	if (opts.dor?.handoffBrief !== undefined) $set['dor.handoffBrief'] = opts.dor.handoffBrief;
	if (($set.classOfService ?? task.classOfService) === 'fixed_date' && !($set.dueDate ?? task.dueDate)) {
		throw new TransitionError('REASON_REQUIRED', "classOfService 'fixed_date' requires a real external dueDate.");
	}
	if (!Object.keys($set).length) return { taskId: opts.taskId, title: task.title, changed: false };
	await KanbanTask.updateOne({ _id: opts.taskId }, {
		$set,
		$push: {
			activityLog: {
				_id: generateId(), action: 'reshaped', details: $set, createdAt: new Date(), createdBy: opts.actorUsername
			}
		}
	});
	await AuditLog.create({
		_id: generateId(), tableName: 'kanban_tasks', recordId: opts.taskId, action: 'UPDATE',
		newData: { reshape: $set, via: opts.via }, changedBy: opts.actorUsername, changedAt: new Date()
	});
	return { taskId: opts.taskId, title: task.title, changed: true };
}

/**
 * KB2-11 — capture from a workflow template: item is created AND processed in
 * one motion, landing DoR-complete and immediately replenishable.
 */
export async function captureFromTemplate(opts: {
	templateId: string;
	actorUsername: string;
	via: TransitionVia;
	title?: string; // overrides titleTemplate
	dueDate?: Date;
}) {
	await connectDB();
	const tpl: any = await KanbanTemplate.findById(opts.templateId).lean();
	if (!tpl || tpl.active === false) throw new TransitionError('NOT_FOUND', `Template ${opts.templateId} not found or inactive`);

	const task: any = await createKanbanItem({
		title: (opts.title?.trim() || tpl.titleTemplate).trim(),
		actor: { username: opts.actorUsername, via: opts.via },
		itemType: tpl.itemType ?? 'deliverable',
		tags: tpl.tags ?? [],
		dueDate: opts.dueDate,
		source: 'template',
		sourceRef: `template:${tpl._id}`
	});
	await KanbanTask.updateOne({ _id: task._id }, { $set: { dor: tpl.dor } });
	await processTask({
		taskId: task._id,
		actorUsername: opts.actorUsername,
		via: opts.via,
		sizeClass: tpl.sizeClass,
		classOfService: tpl.classOfService,
		dueDate: opts.dueDate
	});
	return { taskId: task._id, title: task.title, templateName: tpl.name };
}

/** Park an option indefinitely — visible, skipped at processing, never auto-archived. */
export async function iceboxTask(opts: { taskId: string; actorUsername: string; via: TransitionVia; reason?: string }) {
	return transitionTask({
		taskId: opts.taskId,
		to: 'icebox',
		actor: { username: opts.actorUsername, via: opts.via },
		reason: opts.reason
	});
}

/** Explicitly not doing this — kept for the record (who/why). Reason required by the service. */
export async function declineTask(opts: { taskId: string; actorUsername: string; via: TransitionVia; reason: string }) {
	return transitionTask({
		taskId: opts.taskId,
		to: 'declined',
		actor: { username: opts.actorUsername, via: opts.via },
		reason: opts.reason
	});
}

/** Un-park (icebox → captured) so it re-enters the processing stream. */
export async function thawTask(opts: { taskId: string; actorUsername: string; via: TransitionVia }) {
	return transitionTask({ taskId: opts.taskId, to: 'captured', actor: { username: opts.actorUsername, via: opts.via } });
}

/**
 * KB2-07 — close a spike. A spike is done when the timebox expires regardless
 * of whether the question was answered ("we still don't know" is a valid,
 * recorded outcome — never treated as failure). Its output is options, not tasks.
 */
export async function closeSpike(opts: {
	taskId: string;
	actorUsername: string;
	via: TransitionVia;
	outcome: string;
	spawnOptions?: { title: string; description?: string }[];
}) {
	await connectDB();
	const task: any = await KanbanTask.findById(opts.taskId).lean();
	if (!task) throw new TransitionError('NOT_FOUND', `Task ${opts.taskId} not found`);
	if (task.itemType !== 'spike') throw new TransitionError('INVALID_STATUS', 'Not a spike.');
	if (!opts.outcome?.trim()) {
		throw new TransitionError('REASON_REQUIRED', 'Closing an investigation requires recording the outcome — including "still unknown".');
	}

	await KanbanTask.updateOne({ _id: opts.taskId }, { $set: { 'spike.outcome': opts.outcome.trim() } });
	await transitionTask({ taskId: opts.taskId, to: 'done', actor: { username: opts.actorUsername, via: opts.via } });

	const { createKanbanItem } = await import('./transition.js');
	const spawned: { taskId: string; title: string }[] = [];
	for (const o of opts.spawnOptions ?? []) {
		if (!o.title?.trim()) continue;
		const created: any = await createKanbanItem({
			title: o.title,
			description: o.description,
			actor: { username: opts.actorUsername, via: opts.via },
			tags: task.tags ?? [],
			origin: 'discovered',
			spawnedFrom: opts.taskId,
			source: 'spike-close'
		});
		spawned.push({ taskId: created._id, title: created.title });
	}
	return { taskId: opts.taskId, outcome: opts.outcome.trim(), spawnedOptions: spawned };
}
