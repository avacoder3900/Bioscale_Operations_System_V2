import mongoose, { Schema } from 'mongoose';
import { generateId } from '../utils.js';

/**
 * Proof that a specific occurrence (schedule + due day) was cleaned.
 * One record per occurrence, enforced by the unique compound index.
 */
const cleaningRecordSchema = new Schema({
	_id: { type: String, default: () => generateId() },
	scheduleId: { type: String, required: true },
	areaId: String,
	areaName: String, // snapshot: history stays readable if the area is renamed
	title: String,    // snapshot of the schedule title at sign-off time
	dueDate: { type: String, required: true }, // 'YYYY-MM-DD' occurrence key
	status: { type: String, enum: ['completed', 'skipped'], default: 'completed' },
	/**
	 * The account that entered this record. Always the authenticated session —
	 * never operator-supplied, so the audit trail cannot be spoofed from the form.
	 */
	completedBy: { _id: String, username: String },
	/**
	 * Who actually did the cleaning, when that is not the person entering it
	 * (e.g. a lead signs off work an operator performed). Free text on purpose:
	 * cleaners are not all BIMS users. Empty/absent means completedBy did it.
	 */
	performedBy: String,
	completedAt: { type: Date, default: Date.now },
	notes: String
}, { timestamps: true });

cleaningRecordSchema.index({ scheduleId: 1, dueDate: 1 }, { unique: true });
cleaningRecordSchema.index({ dueDate: -1 });
cleaningRecordSchema.index({ areaId: 1, dueDate: -1 });
cleaningRecordSchema.index({ 'completedBy._id': 1, completedAt: -1 });

export const CleaningRecord =
	mongoose.models.CleaningRecord ||
	mongoose.model('CleaningRecord', cleaningRecordSchema, 'cleaning_records');
