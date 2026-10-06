import mongoose, { Schema } from 'mongoose';
import { generateId } from '../utils.js';

/**
 * Reassembly buffer for device-uploaded magnetometer sweeps.
 *
 * A sweep arrives as ~130 separate Particle publishes, each landing in its own
 * serverless invocation, so the partial upload cannot live in process memory —
 * Mongo is the only state two invocations share.
 *
 * Deliberately NOT an immutable log: this is scratch space that is written
 * once per chunk and reaped by TTL. The durable record of a sweep is the
 * ValidationSession it produces.
 *
 * `chunks` is a sparse object keyed by chunk index as a string ("0", "1", ...)
 * so each chunk can be written with $set on its own path. That makes a
 * duplicate delivery a no-op rather than a double count, and lets chunks
 * arrive in any order.
 */
const sweepUploadSchema = new Schema({
	_id: { type: String, default: () => generateId() },
	// `${particleDeviceId}::${sweepId}` — one buffer per sweep per device.
	key: { type: String, required: true, unique: true },
	deviceId: String,
	sweepId: String,
	totalChunks: Number,
	// No default: Mongoose's setDefaultsOnInsert would add `chunks: {}` to the
	// upsert alongside `$set: {'chunks.N': ...}`, and Mongo rejects an update
	// that writes both a path and its parent.
	chunks: { type: Schema.Types.Mixed },
	receivedChunks: Number,
	assembledBytes: Number,
	status: {
		type: String,
		enum: ['receiving', 'assembling', 'completed', 'failed'],
		default: 'receiving'
	},
	// Set once assembly succeeds; makes a late duplicate chunk idempotent.
	sessionId: String,
	spuId: String,
	spuUdi: String,
	error: String,
	// Ingest succeeded but something was off — e.g. the device declared a column
	// list that is not the locked spec. Kept separate from `error` so a drifted
	// format is visible without looking like a failed upload.
	warning: String,
	createdAt: { type: Date, default: Date.now },
	firstChunkAt: Date,
	lastChunkAt: Date,
	completedAt: Date,
	// TTL: Mongo reaps abandoned buffers so a device that reboots mid-upload
	// does not leave its partial sweep behind forever.
	expiresAt: Date
}, { timestamps: false });

sweepUploadSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });
sweepUploadSchema.index({ deviceId: 1, status: 1 });

export const SweepUpload = mongoose.models.SweepUpload
	|| mongoose.model('SweepUpload', sweepUploadSchema, 'sweep_uploads');
