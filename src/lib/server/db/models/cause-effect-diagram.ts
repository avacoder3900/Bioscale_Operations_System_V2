import mongoose, { Schema } from 'mongoose';
import { generateId } from '../utils.js';

/**
 * Fishbone (Ishikawa) diagram stored per process. Structure is the 5M1E
 * categories (Man, Machine, Material, Method, Measurement, Environment) with
 * a flat list of contributing causes under each. Optional link to a specific
 * problem statement / defect mode. Edited manually; consumed by the
 * Failures tab.
 */
const causeNodeSchema = new Schema({
	_id: { type: String, default: () => generateId() },
	category: {
		type: String,
		enum: ['Man', 'Machine', 'Material', 'Method', 'Measurement', 'Environment'],
		required: true
	},
	cause: { type: String, required: true },
	subCauses: [{ _id: false, text: String }],
	weight: { type: Number, default: 0 }, // optional — operator's sense of importance
	linkedRejectionCodes: [String],
	addedBy: { _id: String, username: String },
	addedAt: Date
}, { _id: false });

const causeEffectDiagramSchema = new Schema({
	_id: { type: String, default: () => generateId() },
	processType: { type: String, required: true, index: true },
	problemStatement: { type: String, required: true }, // "Why do cartridges fail wax QC?"
	nodes: [causeNodeSchema],
	active: { type: Boolean, default: true },
	createdBy: { _id: String, username: String },
	updatedBy: { _id: String, username: String }
}, { timestamps: true });

causeEffectDiagramSchema.index({ processType: 1, active: 1 });

export const CauseEffectDiagram = mongoose.models.CauseEffectDiagram
	|| mongoose.model('CauseEffectDiagram', causeEffectDiagramSchema, 'cause_effect_diagrams');
