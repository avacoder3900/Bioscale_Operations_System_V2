import mongoose, { Schema } from 'mongoose';
import { generateId } from '../utils.js';

/**
 * DeviceFinding — what the daily monitor review (or a person) concluded about
 * one device. Persistent: no TTL. The raw material it was drawn from
 * (device_logs, device_events, webhook_logs) expires; the conclusion must not.
 *
 * One `daily_review` row per (deviceId, dayKey) — re-running the cron for the
 * same day overwrites rather than duplicates. Individual findings the review
 * raised are `review_finding` rows that point back at the review via reviewId.
 */
const deviceFindingSchema = new Schema({
	_id: { type: String, default: () => generateId() },

	deviceId: { type: String, required: true },
	spuId: String,
	udi: String,

	kind: { type: String, required: true, enum: ['daily_review', 'review_finding', 'manual'] },
	dayKey: String, // YYYY-MM-DD (UTC) of the review window end; set on daily_review rows
	reviewId: String, // review_finding -> its daily_review row

	// Review verdict (daily_review rows)
	status: { type: String, enum: ['healthy', 'watch', 'suspect', 'no_data', 'error'] },
	summary: String,

	// Finding payload (review_finding and manual rows)
	severity: { type: String, enum: ['info', 'warning', 'error'] },
	category: String, // stage | heater | cloud | optics | crash | assay | other
	title: String,
	detail: String,
	recommendation: String,
	confidence: Number, // 0..1
	evidence: [{
		_id: false,
		source: String, // firmware | webhook | crash | event | record
		at: Date,
		text: String
	}],

	// Window the review looked at
	windowFrom: Date,
	windowTo: Date,
	inputCounts: Schema.Types.Mixed, // { logLines, events, webhooks, crashes, records, controls }

	// Model telemetry
	model: String,
	inputTokens: Number,
	outputTokens: Number,
	costUsd: Number,
	durationMs: Number,

	// Lifecycle
	acknowledgedAt: Date,
	acknowledgedBy: { _id: String, username: String },
	resolvedAt: Date,
	notes: String,
	createdBy: { _id: String, username: String }
}, { timestamps: true, collection: 'device_findings' });

deviceFindingSchema.index({ deviceId: 1, kind: 1, dayKey: 1 }, { unique: true, partialFilterExpression: { kind: 'daily_review' } });
deviceFindingSchema.index({ deviceId: 1, createdAt: -1 });
deviceFindingSchema.index({ kind: 1, severity: 1, resolvedAt: 1, createdAt: -1 });
deviceFindingSchema.index({ reviewId: 1 });

export const DeviceFinding = mongoose.models.DeviceFinding || mongoose.model('DeviceFinding', deviceFindingSchema, 'device_findings');
