import mongoose, { Schema } from 'mongoose';
import { generateId } from '../utils.js';

/**
 * OpentronsScannerSweepRun
 *
 * Live state + history for a /api/scanner/sweep invocation. The sweep is
 * a long-running operation (~5s × N slots) and the operator needs live
 * visibility into where the gantry is, what's been decoded, what's failed,
 * plus the ability to pause or cancel mid-run. Persisting the state lets
 * the client poll without a hanging request and replays after refresh.
 */

const scanEntrySchema = new Schema(
	{
		slotIndex: { type: Number, required: true },
		barcode: { type: String, required: true },
		rawPayload: String,
		scannedAt: Date,
		x: Number,
		y: Number,
		z: Number,
		attempts: { type: Number, default: 1 }
	},
	{ _id: false }
);

const errorEntrySchema = new Schema(
	{
		slotIndex: { type: Number, required: true },
		message: { type: String, required: true },
		recordedAt: { type: Date, default: () => new Date() },
		attempts: { type: Number, default: 1 }
	},
	{ _id: false }
);

const logEntrySchema = new Schema(
	{
		ts: { type: Date, default: () => new Date() },
		level: { type: String, enum: ['info', 'warn', 'error'], default: 'info' },
		message: { type: String, required: true },
		slotIndex: Number
	},
	{ _id: false }
);

const sweepRunSchema = new Schema(
	{
		_id: { type: String, default: () => generateId() },
		robotId: { type: String, required: true, index: true },
		robotName: String,
		positionSetId: { type: String, required: true },
		positionSetTitle: String,
		deviceId: { type: String, required: true },
		source: {
			type: String,
			enum: ['wax_filling', 'reagent_filling', 'manual', 'test'],
			default: 'manual'
		},
		contextRef: String,
		status: {
			type: String,
			enum: ['running', 'paused', 'cancelled', 'completed', 'errored'],
			default: 'running',
			index: true
		},
		// Control signals set by client; sweep loop reads these between slots
		// and treats them as authoritative.
		pauseRequested: { type: Boolean, default: false },
		cancelRequested: { type: Boolean, default: false },

		slotsTotal: { type: Number, required: true },
		slotsDone: { type: Number, default: 0 },
		currentSlotIndex: Number,

		scans: { type: [scanEntrySchema], default: [] },
		errors: { type: [errorEntrySchema], default: [] },
		log: { type: [logEntrySchema], default: [] },

		startedAt: { type: Date, default: () => new Date() },
		completedAt: Date,
		abortReason: String,

		requestedBy: String,
		requestedByUsername: String
	},
	{ timestamps: true }
);

sweepRunSchema.index({ status: 1, startedAt: -1 });
sweepRunSchema.index({ robotId: 1, startedAt: -1 });
sweepRunSchema.index({ contextRef: 1, startedAt: -1 });

export const OpentronsScannerSweepRun =
	mongoose.models.OpentronsScannerSweepRun ||
	mongoose.model(
		'OpentronsScannerSweepRun',
		sweepRunSchema,
		'opentrons_scanner_sweep_runs'
	);
