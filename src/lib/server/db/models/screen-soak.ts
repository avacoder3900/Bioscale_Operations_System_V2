import mongoose, { Schema } from 'mongoose';
import { generateId } from '../utils.js';

/**
 * SCREEN SOAK — an overnight motion stress test (2026-11-17).
 *
 * The device's run_screen caps level 2 (assay motion) at SCREEN_MAX_REPS = 5
 * runs per screen, ~27 min each. A soak chains level-2-only screens of up to 5
 * runs until `targetRuns` is reached, so e.g. 16 runs ≈ 7.5 h unattended. No
 * firmware change: each block is an ordinary `run_screen("2,<reps>,")`.
 *
 * Each block's results land as a normal 'screen' validation session (tagged
 * rawData.soakId) but DO NOT touch the unit's validation.screen rollup — a
 * level-2-only block is not a screen of the unit.
 *
 * Operational, not sacred: the document is the job state of the chain.
 */
const blockSchema = new Schema(
	{
		requestedAt: Date,
		reps: Number,
		/** The 'screen' validation session the device's events landed in. */
		sessionId: { type: String, default: null },
		completedAt: { type: Date, default: null },
		/** Level-2 runs the block actually reported (≤ reps; fewer on an abort). */
		runs: { type: Number, default: null },
		failed: { type: Boolean, default: null },
		aborted: { type: String, default: null }
	},
	{ _id: false }
);

const screenSoakSchema = new Schema(
	{
		_id: { type: String, default: () => generateId() },
		spuId: String,
		spuUdi: String,
		particleDeviceId: String,
		status: { type: String, enum: ['running', 'completed', 'stopped', 'failed'], default: 'running' },
		targetRuns: Number,
		/** Stop the chain after a block with any FAIL row (limit hit, abort, …). */
		stopOnFail: { type: Boolean, default: true },
		assayId: { type: String, default: null },
		blocks: { type: [blockSchema], default: [] },
		runsDone: { type: Number, default: 0 },
		/** True from a successful run_screen until that block's summary arrives. */
		awaiting: { type: Boolean, default: false },
		/** Short lease so two invocations never fire run_screen at once. */
		lockUntil: { type: Date, default: null },
		lastAttemptAt: { type: Date, default: null },
		lastError: { type: String, default: null },
		startedAt: Date,
		startedBy: { _id: String, username: String },
		endedAt: { type: Date, default: null },
		endReason: { type: String, default: null }
	},
	{ timestamps: false }
);

export const ScreenSoak = mongoose.models.ScreenSoak || mongoose.model('ScreenSoak', screenSoakSchema, 'screen_soaks');
