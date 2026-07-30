import mongoose, { Schema } from 'mongoose';
import { generateId } from '../utils.js';
import {
	ALL_STATUSES,
	BOARDS,
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
	title: { type: String, required: true },
	description: String,
	status: { type: String, enum: ALL_STATUSES, default: 'captured' },
	board: { type: String, enum: BOARDS, default: 'ops' },
	// Strict ordinal, no ties. Scope: Tier 1 = (board, project); Tier 2 = (board) global. 0 = unranked.
	rank: { type: Number, default: 0 },
	itemType: { type: String, enum: ITEM_TYPES, default: 'deliverable' },
	classOfService: { type: String, enum: CLASSES_OF_SERVICE, default: 'standard' },
	sizeClass: { type: String, enum: SIZE_CLASSES }, // set at processing (KB2-03); replaces taskLength
	origin: { type: String, enum: ORIGINS, default: 'planned' },
	spawnedFrom: String, // task that was in wip when this option was captured (provenance, ≠ parentTaskId)
	project: { _id: String, name: String, color: String },
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
	// Definition of Ready (KB2-03; handoffBrief is the software-board coding-agent brief, KB2-08)
	dor: {
		outcome: String,
		acceptanceCriteria: String,
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

kanbanTaskSchema.index({ board: 1, status: 1, rank: 1 });
kanbanTaskSchema.index({ board: 1, 'project._id': 1, status: 1, rank: 1 });
kanbanTaskSchema.index({ 'assignee._id': 1, status: 1 });
kanbanTaskSchema.index({ tags: 1 });
kanbanTaskSchema.index({ archived: 1, archivedAt: -1 });
kanbanTaskSchema.index({ parentTaskId: 1 });
kanbanTaskSchema.index({ spawnedFrom: 1 });

export const KanbanTask = mongoose.models.KanbanTask || mongoose.model('KanbanTask', kanbanTaskSchema, 'kanban_tasks');
