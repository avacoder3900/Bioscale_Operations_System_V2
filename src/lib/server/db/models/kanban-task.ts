import mongoose, { Schema } from 'mongoose';
import { generateId } from '../utils.js';
import {
	ALL_STATUSES,
	ITEM_TYPES,
	CLASSES_OF_SERVICE,
	SIZE_CLASSES,
	ORIGINS
} from '../../../shared/kanban-status.js';

const operatorRef = { _id: String, username: String };

/**
 * Two-tier kanban task. See docs/prds/KB2-00-OVERVIEW.md + KB2-01.
 * Status writes go through src/lib/server/kanban/transition.ts ONLY —
 * tier is derived from status (tierOf), never stored.
 */
const kanbanTaskSchema = new Schema({
	_id: { type: String, default: () => generateId() },
	// KB2-20: human-facing tracking number, e.g. TASK-001. Allocated once at
	// capture from the atomic KanbanCounter; never reused, never renumbered.
	// Cosmetic identity only — `_id` stays the key for every relation/route.
	trackingNumber: { type: String },
	title: { type: String, required: true },
	description: String,
	status: { type: String, enum: ALL_STATUSES, default: 'captured' },
	// Strict ordinal, no ties. Scope (KB2-16): Tier 1 = one global list; Tier 2 = the global ready order. 0 = unranked.
	rank: { type: Number, default: 0 },
	itemType: { type: String, enum: ITEM_TYPES, default: 'deliverable' },
	classOfService: { type: String, enum: CLASSES_OF_SERVICE, default: 'standard' },
	sizeClass: { type: String, enum: SIZE_CLASSES }, // set at processing (KB2-03); replaces taskLength
	// KB2-27: workshopped estimate in working days (Claude-app ↔ MCP). Rung 1 of
	// the scheduler's ladder; checked against actuals (wipDate→completedDate).
	// KB2-31: estimateDays is DURATION (calendar-shaped: drives CPM chain dates).
	estimateDays: Number,
	// KB2-31: hands-on team effort in working days, when it differs from
	// duration (elapsed-time tasks: incubations, at-home testing). The capacity
	// clamp + measured velocity + calibration consume effortDays ?? estimateDays
	// so long experiments stop eating fictional team-weeks.
	effortDays: Number,
	origin: { type: String, enum: ORIGINS, default: 'planned' },
	spawnedFrom: String, // task that was in wip when this option was captured (provenance, ≠ parentTaskId)
	// KB2-16: the project subdoc and board discriminator are gone — tags carry both jobs.
	assignee: operatorRef,
	dueDate: Date,
	tags: [String],
	source: String,
	sourceRef: String,
	statusChangedAt: Date,
	// Per-status stamps (transition service writes; STATUS_DATE_FIELD maps status → field)
	processedDate: Date,
	declinedDate: Date,
	readyDate: Date,
	wipDate: Date,
	waitingDate: Date,
	blockedDate: Date,
	reviewDate: Date,
	completedDate: Date,
	committedAt: Date, // first entry into Tier 2 — the commitment timestamp
	waitingReason: String,
	waitingOn: String,
	waitingUntil: Date,
	blockedReason: String,
	declineReason: String,
	// Definition of Ready (KB2-03/KB2-12; handoffBrief is the software-board coding-agent brief, KB2-08).
	// deliverable = what will exist/be true when this is done + how you'd verify it (one field,
	// collapsed from the old outcome + acceptanceCriteria pair — KB2-12 addendum 2026-08-03).
	dor: {
		deliverable: String,
		handoffBrief: String
	},
	// Spike fields (KB2-07): question required at creation, outcome at close
	spike: {
		question: String,
		timebox: { amount: Number, unit: { type: String, enum: ['hours', 'days'] } },
		outcome: String
	},
	// Last commitment-point crossing (KB2-02)
	replenishment: { eventId: String, promotedBy: String, promotedAt: Date },
	comments: [{
		_id: { type: String, default: () => generateId() },
		content: String, createdAt: Date, createdBy: operatorRef
	}],
	parentTaskId: String,
	// KB2-20: explicit, typed task-to-task links. Stored one-way on the task
	// that declares the relationship; the reverse direction is derived at read
	// time so a link can never be half-written.
	//   blocks     — this task must finish before `taskId` can start
	//   blocked_by — `taskId` must finish before this one can start
	//   relates_to — soft association, no scheduling meaning
	links: [{
		_id: { type: String, default: () => generateId() },
		taskId: { type: String, required: true },
		type: { type: String, enum: ['blocks', 'blocked_by', 'relates_to'], default: 'relates_to' },
		note: String,
		createdAt: { type: Date, default: Date.now },
		createdBy: String // username
	}],
	transitions: [{
		_id: { type: String, default: () => generateId() },
		fromStatus: String, toStatus: String,
		changedBy: String, // username — kept name for back-compat reads
		via: String, // 'ui' | 'mcp' | 'agent-api' | 'system'
		reason: String,
		timestamp: { type: Date, default: Date.now }
	}],
	activityLog: [{
		_id: { type: String, default: () => generateId() },
		action: String, details: Schema.Types.Mixed, createdAt: Date, createdBy: String
	}],
	proposals: [{
		_id: { type: String, default: () => generateId() },
		proposedBy: String, proposalType: String,
		details: String, suggestedActions: [String],
		decision: { type: String, enum: ['pending', 'approved', 'edited', 'vetoed'] },
		decidedBy: String, editNotes: String, vetoReason: String, batchId: String,
		createdAt: Date, decidedAt: Date
	}],
	archived: { type: Boolean, default: false },
	archivedAt: Date,
	createdBy: String
}, { timestamps: true });

kanbanTaskSchema.index({ status: 1, rank: 1 });
kanbanTaskSchema.index({ 'assignee._id': 1, status: 1 });
kanbanTaskSchema.index({ tags: 1 });
kanbanTaskSchema.index({ archived: 1, archivedAt: -1 });
kanbanTaskSchema.index({ parentTaskId: 1 });
// Sparse+unique: legacy tasks with no number stay legal, new ones can't collide.
kanbanTaskSchema.index({ trackingNumber: 1 }, { unique: true, sparse: true });
kanbanTaskSchema.index({ 'links.taskId': 1 });
kanbanTaskSchema.index({ spawnedFrom: 1 });
// wip-mtime watermark poll: findOne().sort({updatedAt:-1}) every few seconds
// per open board — needs this or it full-scans + in-memory-sorts every poll
// (Atlas query-targeting alert, 2026-07-31).
kanbanTaskSchema.index({ updatedAt: -1 });
// archive cron + status-scoped time reads
kanbanTaskSchema.index({ status: 1, archived: 1, statusChangedAt: 1 });

// ---------------------------------------------------------------------------
// Status-write guard (2026-09-09). The flow history / CFD replays activityLog
// `status_change` entries, so a status written WITHOUT one leaves a ghost on
// the chart (27 found after the KB2 migrations wrote status with a raw
// updateMany). Every legitimate status change goes through
// src/lib/server/kanban/transition.ts, which persists via document save() and
// writes the entry — so at the model level, an update operator that touches
// `status` is always a mistake. Reject it loudly. Raw-driver writes
// (db.collection(...)) bypass Mongoose entirely and cannot be caught here:
// migration scripts MUST append a status_change entry themselves (see
// scripts/backfill-kanban-cfd-ghosts.ts for the shape).
// Escape hatch for a deliberate repair: .setOptions({ allowRawStatusWrite: true }).
const STATUS_WRITE_ERROR =
	'KanbanTask.status must change through transitionTask() (src/lib/server/kanban/transition.ts) so the activityLog status_change entry is written — the CFD replays that log. Use .setOptions({ allowRawStatusWrite: true }) only for an audited repair that also appends the entry.';

function touchesStatus(update: any): boolean {
	if (!update || typeof update !== 'object') return false;
	if (Array.isArray(update)) return update.some(touchesStatus); // pipeline updates
	if ('status' in update) return true;
	for (const op of ['$set', '$setOnInsert', '$unset']) {
		if (update[op] && typeof update[op] === 'object' && 'status' in update[op]) return true;
	}
	return false;
}

for (const hook of ['updateOne', 'updateMany', 'findOneAndUpdate', 'replaceOne'] as const) {
	kanbanTaskSchema.pre(hook, function (this: any) {
		if (touchesStatus(this.getUpdate()) && !this.getOptions()?.allowRawStatusWrite) {
			throw new Error(STATUS_WRITE_ERROR);
		}
	});
}

export const KanbanTask = mongoose.models.KanbanTask || mongoose.model('KanbanTask', kanbanTaskSchema, 'kanban_tasks');
