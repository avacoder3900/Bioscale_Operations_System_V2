import mongoose, { Schema } from 'mongoose';
import { generateId } from '../utils.js';

/**
 * Chunked device uploads (screen pipeline, 2026-10-13).
 *
 * The firmware publishes anything bigger than one Particle event as a series
 * of chunks, each carrying the envelope "<id>|<seq>|<total>|" followed by its
 * slice (firmware try_upload_sweep(); the screen record upload uses the same
 * envelope). Chunks are not acknowledged by the device and may arrive twice,
 * out of order, or not at all, so the receiver stores every chunk idempotently
 * by (device, kind, id, seq) and assembles only when every seq 0..total-1 is
 * present. A job document per (device, kind, id) tracks what has arrived, what
 * is still missing, and what the assembly produced, so an operator can see a
 * hole and ask for a resend instead of waiting on a sweep that never completes.
 *
 * kind: 'mag_sweep'      — bioscale/mag_sweep_chunk, text rows (fmt 3 means)
 *       'screen_record'  — bioscale/screen_record, base64 slices of one
 *                          BrevitestTestRecord from a SCREEN level-2 run
 */
export const DEVICE_CHUNK_KINDS = ['mag_sweep', 'screen_record'] as const;
export type DeviceChunkKind = (typeof DEVICE_CHUNK_KINDS)[number];

const deviceChunkSchema = new Schema(
	{
		_id: { type: String, default: () => generateId() },
		particleDeviceId: { type: String, required: true },
		kind: { type: String, enum: DEVICE_CHUNK_KINDS, required: true },
		/** The id in the envelope — a sweep's epoch id, or "<run>-<runIndex>" for a screen record. */
		chunkId: { type: String, required: true },
		seq: { type: Number, required: true },
		total: { type: Number, required: true },
		/** The slice, as text (sweep rows) or base64 (record bytes). */
		data: { type: String, required: true },
		bytes: Number,
		publishedAt: Date,
		receivedAt: { type: Date, default: () => new Date() }
	},
	{ timestamps: false }
);

// One row per chunk; a duplicate delivery is an upsert onto the same row.
deviceChunkSchema.index({ particleDeviceId: 1, kind: 1, chunkId: 1, seq: 1 }, { unique: true });
deviceChunkSchema.index({ receivedAt: 1 });

export const DeviceChunk =
	mongoose.models.DeviceChunk || mongoose.model('DeviceChunk', deviceChunkSchema, 'device_chunks');

const deviceChunkJobSchema = new Schema(
	{
		_id: { type: String, default: () => generateId() },
		particleDeviceId: { type: String, required: true },
		kind: { type: String, enum: DEVICE_CHUNK_KINDS, required: true },
		chunkId: { type: String, required: true },
		spuId: String,
		spuUdi: String,
		total: Number,
		/** Distinct seqs received so far. */
		received: { type: [Number], default: [] },
		firstChunkAt: Date,
		lastChunkAt: Date,
		status: {
			type: String,
			enum: ['receiving', 'assembled', 'failed'],
			default: 'receiving'
		},
		assembledAt: Date,
		/** validation_sessions._id (mag_sweep) or the screen session the record was attached to. */
		sessionId: String,
		lastError: String,
		/** Live progress published by the device while the sweep itself runs (bioscale/sweep_progress). */
		progress: {
			type: { i: Number, of: Number, at: Date },
			default: null,
			_id: false
		}
	},
	{ timestamps: true }
);

deviceChunkJobSchema.index({ particleDeviceId: 1, kind: 1, chunkId: 1 }, { unique: true });
deviceChunkJobSchema.index({ status: 1, updatedAt: -1 });
deviceChunkJobSchema.index({ spuId: 1, updatedAt: -1 });

export const DeviceChunkJob =
	mongoose.models.DeviceChunkJob ||
	mongoose.model('DeviceChunkJob', deviceChunkJobSchema, 'device_chunk_jobs');
