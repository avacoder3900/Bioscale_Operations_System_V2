import mongoose, { Schema } from 'mongoose';
import { generateId } from '../utils.js';

const workflowViolationSchema = new Schema({
	_id: { type: String, default: () => generateId() },
	type: { type: String, required: true },
	taskId: { type: String, required: true },
	assignee: String,
	description: { type: String, required: true },
	severity: { type: String, enum: ['low', 'medium', 'high'], default: 'medium' },
	resolved: { type: Boolean, default: false },
	resolvedAt: Date,
	resolvedBy: String,
	timestamp: { type: Date, default: Date.now }
}, { timestamps: false });

workflowViolationSchema.index({ taskId: 1 });
workflowViolationSchema.index({ type: 1, resolved: 1 });
workflowViolationSchema.index({ timestamp: -1 });

export const WorkflowViolation = mongoose.models.WorkflowViolation || mongoose.model('WorkflowViolation', workflowViolationSchema, 'workflow_violations');
