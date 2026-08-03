import mongoose, { Schema } from 'mongoose';
import { generateId } from '../utils.js';

/**
 * KB2-11 — workflow templates for ultra-defined recurring work ("Build &
 * validate SPU", "Fill 50 cartridges"). Capturing from a template lands the
 * item already processed and DoR-complete. Spikes cannot be templated —
 * a templated investigation is a contradiction.
 */
const kanbanTemplateSchema = new Schema(
	{
		_id: { type: String, default: () => generateId() },
		name: { type: String, required: true },
		board: { type: String, enum: ['ops', 'software'], default: 'ops' },
		active: { type: Boolean, default: true },
		itemType: { type: String, enum: ['deliverable', 'chore'], default: 'deliverable' },
		sizeClass: { type: String, enum: ['short', 'medium', 'long'], required: true },
		classOfService: { type: String, enum: ['standard', 'fixed_date', 'chore', 'expedite'], default: 'standard' },
		titleTemplate: { type: String, required: true },
		// deliverable = what will exist/be true when done + how you'd verify it
		// (single field, collapsed from outcome + acceptanceCriteria — KB2-12 addendum).
		dor: {
			deliverable: { type: String, required: true },
			handoffBrief: String
		},
		tags: [String],
		defaultProjectId: String,
		notes: String,
		createdBy: String
	},
	{ timestamps: true }
);

export const KanbanTemplate =
	mongoose.models.KanbanTemplate || mongoose.model('KanbanTemplate', kanbanTemplateSchema, 'kanban_templates');
