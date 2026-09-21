/**
 * Tag vocabulary hygiene (MCP-IMPROVEMENTS P1-3, 2026-08-18).
 *
 * Tags are free text but the vocabulary is meant to stay CLOSED: the same
 * concept must not fork into `cartridge` / `Cartridge` / `cartridge `. Every
 * write path (UI capture, agent API, MCP, subtasks, merge) runs incoming tags
 * through normalizeTags(), which trims, collapses whitespace, de-dupes
 * case-insensitively, and folds each entry onto the existing canonical casing
 * when one already exists on the board. renameTag() is the bulk migration
 * tool for the cases hygiene-on-write can't reach (retiring / merging tags).
 */
import { connectDB, KanbanTask, AuditLog } from '$lib/server/db';
import { generateId } from '$lib/server/db/utils.js';
import type { TransitionActor } from './transition';

function clean(raw: unknown): string {
	return typeof raw === 'string' ? raw.trim().replace(/\s+/g, ' ') : '';
}

/** Existing vocabulary keyed by lowercase → canonical casing (first seen wins). */
export async function canonicalTagMap(): Promise<Map<string, string>> {
	await connectDB();
	const existing = (await KanbanTask.distinct('tags')) as unknown[];
	const map = new Map<string, string>();
	for (const t of existing) {
		const c = clean(t);
		if (!c) continue;
		const key = c.toLowerCase();
		if (!map.has(key)) map.set(key, c);
	}
	return map;
}

/**
 * Normalize a caller-supplied tag list against the live vocabulary. Pure
 * function of (input, vocabulary): trim/collapse, drop blanks, de-dupe
 * case-insensitively (first occurrence wins), fold onto canonical casing.
 */
export async function normalizeTags(raw: unknown, canonical?: Map<string, string>): Promise<string[]> {
	const list: unknown[] = Array.isArray(raw)
		? raw
		: typeof raw === 'string'
			? raw.split(',')
			: [];
	const canon = canonical ?? (await canonicalTagMap());
	const seen = new Set<string>();
	const out: string[] = [];
	for (const item of list) {
		const c = clean(item);
		if (!c) continue;
		const key = c.toLowerCase();
		if (seen.has(key)) continue;
		seen.add(key);
		out.push(canon.get(key) ?? c);
	}
	return out;
}

export interface RenameTagResult {
	from: string;
	to: string | null;
	scope: 'active' | 'all';
	touched: number;
	taskIds: string[];
}

/**
 * Bulk rename (or remove) a tag. Exact, case-sensitive match on `from`.
 * `to: null` removes the tag. If a task already carries `to` (any casing),
 * `from` is simply dropped so no task ends up with both. One AuditLog row
 * per touched task plus one summary row.
 */
export async function renameTag(opts: {
	from: string;
	to: string | null;
	scope?: 'active' | 'all';
	actor: TransitionActor;
}): Promise<RenameTagResult> {
	await connectDB();
	const from = clean(opts.from);
	const to = opts.to === null || opts.to === undefined ? null : clean(opts.to) || null;
	const scope = opts.scope === 'all' ? 'all' : 'active';
	if (!from) throw new Error('`from` tag is required.');
	if (to !== null && to === from) return { from, to, scope, touched: 0, taskIds: [] };

	const filter: any = { tags: from };
	if (scope === 'active') {
		filter.archived = { $ne: true };
		filter.status = { $ne: 'declined' };
	}
	const tasks = (await KanbanTask.find(filter).select('_id tags').lean()) as any[];
	const now = new Date();
	const touched: string[] = [];

	for (const t of tasks) {
		const current: string[] = Array.isArray(t.tags) ? t.tags : [];
		const next: string[] = [];
		const seen = new Set<string>();
		let hasTo = false;
		for (const tag of current) {
			const c = clean(tag);
			if (!c || c === from) continue;
			if (to !== null && c.toLowerCase() === to.toLowerCase()) hasTo = true;
			const key = c.toLowerCase();
			if (seen.has(key)) continue;
			seen.add(key);
			next.push(c);
		}
		if (to !== null && !hasTo) next.push(to);

		await KanbanTask.updateOne(
			{ _id: t._id },
			{
				$set: { tags: next },
				$push: {
					activityLog: {
						_id: generateId(),
						action: 'tag_renamed',
						details: { from, to, via: opts.actor.via },
						createdAt: now,
						createdBy: opts.actor.username
					}
				}
			}
		);
		await AuditLog.create({
			_id: generateId(),
			tableName: 'kanban_tasks',
			recordId: t._id,
			action: 'UPDATE',
			oldData: { tags: current },
			newData: { tags: next, tagRename: { from, to } },
			changedFields: ['tags'],
			changedBy: opts.actor.username,
			changedAt: now
		});
		touched.push(t._id);
	}

	await AuditLog.create({
		_id: generateId(),
		tableName: 'kanban_tasks',
		recordId: `tag:${from}`,
		action: 'UPDATE',
		newData: { tagRename: { from, to, scope, touched: touched.length }, via: opts.actor.via },
		changedBy: opts.actor.username,
		changedAt: now
	});

	return { from, to, scope, touched: touched.length, taskIds: touched };
}
