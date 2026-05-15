import mongoose, { Schema } from 'mongoose';
import { generateId } from '../utils.js';

const kanbanProjectSchema = new Schema({
	_id: { type: String, default: () => generateId() },
	name: { type: String, required: true },
	description: String,
	color: { type: String, default: '#3b82f6' },
	sortOrder: { type: Number, default: 0 },
	isActive: { type: Boolean, default: true },
	// UI persistence. Global state — shared across users.
	collapsed: { type: Boolean, default: false },        // project section fold on /kanban
	backlogCollapsed: { type: Boolean, default: true },  // backlog accordion fold per project
	createdAt: { type: Date, default: Date.now },
	createdBy: String
}, { timestamps: false });

export const KanbanProject = mongoose.models.KanbanProject || mongoose.model('KanbanProject', kanbanProjectSchema, 'kanban_projects');
