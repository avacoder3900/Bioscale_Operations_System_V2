import mongoose, { Schema } from 'mongoose';
import { generateId } from '../utils.js';

const operatorRef = { _id: String, username: String };

const kanbanTaskSchema = new Schema({
	_id: { type: String, default: () => generateId() },
	title: { type: String, required: true },
	description: String,
	status: { type: String, enum: ['backlog', 'ready', 'wip', 'waiting', 'done'], default: 'backlog' },
	prioritized: { type: Boolean, default: false },
	taskLength: { type: String, enum: ['short', 'medium', 'long'], default: 'medium' },
	sortOrder: { type: Number, default: 0 },
	project: { _id: String, name: String, color: String },
	assignee: operatorRef,
	dueDate: Date,
	tags: [String],
	source: String,
	sourceRef: String,
	statusChangedAt: Date,
	backlogDate: Date, readyDate: Date, wipDate: Date, waitingDate: Date, completedDate: Date,
	waitingReason: String, waitingOn: String,
	comments: [{
		_id: { type: String, default: () => generateId() },
		content: String, createdAt: Date, createdBy: operatorRef
	}],
	parentTaskId: String,
	transitions: [{
		_id: { type: String, default: () => generateId() },
		fromStatus: String, toStatus: String,
		changedBy: String, timestamp: { type: Date, default: Date.now }
	}],
	activityLog: [{
		_id: { type: String, default: () => generateId() },
		action: String, details: Schema.Types.Mixed, createdAt: Date, createdBy: String
	}],
	proposals: [{
		_id: { type: String, default: () => generateId() },
		proposedBy: String, proposalType: String,
		decision: { type: String, enum: ['pending', 'approved', 'edited', 'vetoed'] },
		decidedBy: String, editNotes: String, vetoReason: String, batchId: String,
		createdAt: Date, decidedAt: Date
	}],
	archived: { type: Boolean, default: false },
	archivedAt: Date,
	createdBy: String
}, { timestamps: true });

kanbanTaskSchema.index({ 'project._id': 1, status: 1, archived: 1 });
kanbanTaskSchema.index({ 'assignee._id': 1, status: 1 });
kanbanTaskSchema.index({ tags: 1 });
kanbanTaskSchema.index({ archived: 1, archivedAt: -1 });
kanbanTaskSchema.index({ status: 1, sortOrder: 1 });
kanbanTaskSchema.index({ parentTaskId: 1 });

export const KanbanTask = mongoose.models.KanbanTask || mongoose.model('KanbanTask', kanbanTaskSchema, 'kanban_tasks');
