import mongoose, { Schema } from 'mongoose';
import { generateId } from '../utils.js';

/**
 * A physical area/room that gets cleaned (e.g. "Wax Room", "Assembly Bench 2").
 * Areas are the target of CleaningSchedules and are managed in-app.
 */
const cleaningAreaSchema = new Schema({
	_id: { type: String, default: () => generateId() },
	name: { type: String, required: true },
	description: String,
	color: { type: String, default: '#00d4ff' },
	sortOrder: { type: Number, default: 0 },
	isActive: { type: Boolean, default: true },
	createdBy: { _id: String, username: String }
}, { timestamps: true });

cleaningAreaSchema.index({ isActive: 1, sortOrder: 1 });

export const CleaningArea =
	mongoose.models.CleaningArea ||
	mongoose.model('CleaningArea', cleaningAreaSchema, 'cleaning_areas');
