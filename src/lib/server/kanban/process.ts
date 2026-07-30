/**
 * KB2-03 — Processing (triage) + Tier 1 dispositions.
 *
 * Processing is the once-per-item decision that shapes a captured option:
 * size class + class of service are set BY THE PERSON PROCESSING (not the
 * author, not the eventual assignee — removes the inflation incentive),
 * plus a rank among the project's options and optionally the DoR fields.
 */
import { KanbanTask, connectDB } from '$lib/server/db';
import { transitionTask, TransitionError, type TransitionVia } from './transition.js';
import type { KanbanClassOfService, KanbanSizeClass } from '$lib/shared/kanban-status';

export async function processTask(opts: {
	taskId: string;
	actorUsername: string;
	via: TransitionVia;
	sizeClass: KanbanSizeClass;
	classOfService: KanbanClassOfService;
	dueDate?: Date; // required when classOfService === 'fixed_date'
	dor?: { outcome?: string; acceptanceCriteria?: string; handoffBrief?: string };
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
	if (opts.dor?.outcome !== undefined) $set['dor.outcome'] = opts.dor.outcome;
	if (opts.dor?.acceptanceCriteria !== undefined) $set['dor.acceptanceCriteria'] = opts.dor.acceptanceCriteria;
	if (opts.dor?.handoffBrief !== undefined) $set['dor.handoffBrief'] = opts.dor.handoffBrief;
	await KanbanTask.updateOne({ _id: opts.taskId }, { $set });

	await transitionTask({
		taskId: opts.taskId,
		to: 'processed',
		actor: { username: opts.actorUsername, via: opts.via }
	});
	return { taskId: opts.taskId, title: task.title };
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
		throw new TransitionError('REASON_REQUIRED', 'Closing a spike requires recording the outcome — including "still unknown".');
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
			board: task.board ?? 'ops',
			project: task.project ?? null,
			origin: 'discovered',
			spawnedFrom: opts.taskId,
			source: 'spike-close'
		});
		spawned.push({ taskId: created._id, title: created.title });
	}
	return { taskId: opts.taskId, outcome: opts.outcome.trim(), spawnedOptions: spawned };
}
