import mongoose, { Schema } from 'mongoose';
import { generateId } from '../utils.js';

const operatorRef = { _id: String, username: String };

export const SERVICE_TYPES = [
	'inspection',
	'calibration',
	'repair',
	'part-replacement',
	'other'
] as const;

export const SERVICE_PRIORITIES = ['low', 'normal', 'high'] as const;

/**
 * One servicing job on one SPU.
 *
 * Servicing used to live only as `spu.status = 'servicing'` plus a free-text
 * AuditLog entry, which meant nobody could answer "what is open and where is
 * the unit sitting?". This model owns that: a record is `open` from the moment
 * the unit is pulled for service until it is closed and handed back, and it
 * carries the physical location (plus the trail of every move).
 *
 * `previousStatus` is the SPU status we took the unit out of, so closing the
 * job can put it back where it came from instead of guessing.
 */
const serviceRecordSchema = new Schema(
	{
		_id: { type: String, default: () => generateId() },

		spuId: { type: String, required: true },
		spuUdi: String, // snapshot: the list stays readable without a join
		spuBarcode: String,
		customerName: String,

		serviceType: { type: String, enum: SERVICE_TYPES, default: 'other' },
		priority: { type: String, enum: SERVICE_PRIORITIES, default: 'normal' },
		status: { type: String, enum: ['open', 'closed'], default: 'open' },

		/** Where the unit physically is right now, e.g. "Bench 3, Lab A". */
		location: { type: String, default: '' },
		locationHistory: [
			{
				_id: { type: String, default: () => generateId() },
				from: String,
				to: String,
				movedAt: { type: Date, default: () => new Date() },
				movedBy: operatorRef,
				note: String
			}
		],

		reason: String,
		assignedTo: operatorRef,

		notes: [
			{
				_id: { type: String, default: () => generateId() },
				text: String,
				addedAt: { type: Date, default: () => new Date() },
				addedBy: operatorRef
			}
		],

		/**
		 * What actually changed on the unit. These mirror the fields the older
		 * ServiceTicket lineage tracked; they are the DHR trail for a serviced
		 * unit, so they are append-only in practice (nothing edits them).
		 */
		partsReplaced: [
			{
				_id: { type: String, default: () => generateId() },
				/** The spu.parts[] subdocument that was swapped out. */
				spuPartId: String,
				partNumber: String,
				partName: String,
				oldLotNumber: String,
				newLotNumber: String,
				newSerialNumber: String,
				reason: String,
				replacedBy: operatorRef,
				replacedAt: { type: Date, default: () => new Date() }
			}
		],
		firmwareChanges: [
			{
				_id: { type: String, default: () => generateId() },
				deviceType: String,
				previousVersion: String,
				newVersion: String,
				reason: String,
				performedBy: operatorRef,
				performedAt: { type: Date, default: () => new Date() }
			}
		],
		otherChanges: [
			{
				_id: { type: String, default: () => generateId() },
				category: String,
				description: String,
				performedBy: operatorRef,
				performedAt: { type: Date, default: () => new Date() }
			}
		],

		previousStatus: String,
		openedAt: { type: Date, default: () => new Date() },
		openedBy: operatorRef,
		closedAt: Date,
		closedBy: operatorRef,
		resolution: String,
		/** Status the SPU was returned to when the job closed. */
		returnedToStatus: String
	},
	{ timestamps: true }
);

// A unit can only be in one place at a time, so it can only have one open job.
serviceRecordSchema.index(
	{ spuId: 1 },
	{ unique: true, partialFilterExpression: { status: 'open' } }
);
serviceRecordSchema.index({ status: 1, openedAt: -1 });
serviceRecordSchema.index({ status: 1, location: 1 });
serviceRecordSchema.index({ spuId: 1, openedAt: -1 });

export const ServiceRecord =
	mongoose.models.ServiceRecord ||
	mongoose.model('ServiceRecord', serviceRecordSchema, 'service_records');
