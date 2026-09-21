import mongoose, { Schema } from 'mongoose';
import { generateId } from '../utils.js';

/**
 * A recurring cleaning obligation for an area, e.g. "Mop floor - every Friday".
 * Occurrences are NOT materialized; they are expanded on read by
 * $lib/server/cleaning/recurrence.ts. A CleaningRecord is only written when
 * someone actually signs off (or skips) a given occurrence.
 *
 * NOTE: the frequency discriminator is named `kind`, not `type`, on purpose --
 * a nested `type` key inside a subdocument is ambiguous to Mongoose.
 */
const cleaningScheduleSchema = new Schema({
	_id: { type: String, default: () => generateId() },
	areaId: { type: String, required: true },
	areaName: String, // denormalized for display + history durability
	title: { type: String, required: true },
	instructions: String,
	frequency: {
		kind: { type: String, enum: ['daily', 'weekly', 'monthly'], default: 'weekly' },
		interval: { type: Number, default: 1, min: 1 },
		daysOfWeek: [Number], // weekly: 0=Sun .. 6=Sat
		dayOfMonth: Number    // monthly: 1..31, clamped to month length
	},
	startDate: { type: String, required: true }, // 'YYYY-MM-DD' lab-local calendar day
	endDate: String,                             // 'YYYY-MM-DD' | null = open ended
	assignedTo: { _id: String, username: String },
	isActive: { type: Boolean, default: true },
	createdBy: { _id: String, username: String }
}, { timestamps: true });

cleaningScheduleSchema.index({ isActive: 1, areaId: 1 });

export const CleaningSchedule =
	mongoose.models.CleaningSchedule ||
	mongoose.model('CleaningSchedule', cleaningScheduleSchema, 'cleaning_schedules');
