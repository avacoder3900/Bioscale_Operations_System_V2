import mongoose, { Schema } from 'mongoose';
import { generateId } from '../utils.js';

/**
 * One blank-cartridge optical run (2026-09-15 plan, firmware v96).
 *
 * A reusable BLANK cartridge is scanned on a unit; the firmware recognises the
 * BLANK- barcode type, runs the locally loaded blank assay (A87934B1) without
 * any cloud validation, and publishes the finished test record under the
 * `blank-test` event, which a Particle webhook forwards to
 * /api/particle/webhook. BIMS parses the binary record and stores it HERE —
 * never as a cartridge_records document, so the cloud's single-use cartridge
 * rule is never involved and the same physical blank works on every unit.
 *
 * Append-only: one document per scan. Analysis is derive-on-read
 * (analyzeCartridge over all 42 positions), never written back.
 */
const opticalBlankRunSchema = new Schema(
	{
		_id: { type: String, default: () => generateId() },
		/** Particle device id (webhook coreid). */
		deviceId: { type: String, required: true },
		spuId: String,
		spuUdi: String,
		/** The BLANK- code that was scanned (test record cartridge_id field). */
		barcode: String,
		assayId: String,
		/** Device clock at test start. */
		startTime: Date,
		durationS: Number,
		numberOfReadings: Number,
		checksum: Number,
		readings: Schema.Types.Mixed,
		publishedAt: Date,
		receivedAt: { type: Date, default: () => new Date() }
	},
	{ timestamps: false }
);

opticalBlankRunSchema.index({ spuUdi: 1, startTime: -1 });
opticalBlankRunSchema.index({ deviceId: 1, startTime: -1 });
opticalBlankRunSchema.index({ barcode: 1, startTime: -1 });

export const OpticalBlankRun =
	mongoose.models.OpticalBlankRun ||
	mongoose.model('OpticalBlankRun', opticalBlankRunSchema, 'optical_blank_runs');
