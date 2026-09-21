import mongoose, { Schema } from 'mongoose';
import { generateId } from '../utils.js';
import { SERVICE_TYPES, SERVICE_PRIORITIES } from './service-record.js';

const operatorRef = { _id: String, username: String };

/**
 * One task run across several SPUs at once.
 *
 * The floor regularly does the same job on a handful of units — recalibrate a
 * batch, swap a part across a lot, re-run a validation. Before this, that meant
 * N unrelated service records and the shared context (what we're doing and why)
 * lived in somebody's head or got copy-pasted into every record's notes.
 *
 * A group owns the shared half: the task definition and the notes that apply to
 * every unit. The per-unit half stays on ServiceRecord, which keeps its own
 * location, history and close — so a group is an organizing layer, never a
 * replacement for the individual job. Membership is the `groupId` on
 * ServiceRecord; this model deliberately holds no member array, so a unit can
 * never be in the group and missing its own job.
 */
const serviceGroupSchema = new Schema(
	{
		_id: { type: String, default: () => generateId() },

		/** The task, e.g. "Recalibrate magnetometer after thermistor fix". */
		name: { type: String, required: true },
		description: String,

		serviceType: { type: String, enum: SERVICE_TYPES, default: 'other' },
		priority: { type: String, enum: SERVICE_PRIORITIES, default: 'normal' },
		status: { type: String, enum: ['open', 'closed'], default: 'open' },

		/** Notes that apply to every unit in the group, not to any one of them. */
		notes: [
			{
				_id: { type: String, default: () => generateId() },
				text: String,
				addedAt: { type: Date, default: () => new Date() },
				addedBy: operatorRef
			}
		],

		openedAt: { type: Date, default: () => new Date() },
		openedBy: operatorRef,
		closedAt: Date,
		closedBy: operatorRef,
		resolution: String
	},
	{ timestamps: true }
);

serviceGroupSchema.index({ status: 1, openedAt: -1 });

export const ServiceGroup =
	mongoose.models.ServiceGroup ||
	mongoose.model('ServiceGroup', serviceGroupSchema, 'service_groups');
