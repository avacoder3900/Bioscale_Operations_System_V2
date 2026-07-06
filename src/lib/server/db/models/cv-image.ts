import mongoose, { Schema } from 'mongoose';
import { generateId } from '../utils.js';

/**
 * CvImage — derived/technical data ONLY, keyed 1:1 with a
 * cartridge_records.photos[] entry by _id (= photos[].imageId).
 *
 * The photo itself — R2 pointer, phase, capture metadata, and ALL human QC
 * truth (qcLabel, labels, notes, annotations) — lives on the cartridge
 * record. This collection holds what doesn't belong on a sacred
 * manufacturing document: bulky re-computable embeddings and file/processing
 * technicalities. Deleting a row here loses nothing that can't be recomputed.
 */
const cvImageSchema = new Schema({
	_id: { type: String, default: () => generateId() },

	// Reverse lookup to the owning cartridge (photos[].imageId === _id).
	cartridgeRecordId: { type: String, index: true },
	phase: String,

	// File technicalities
	filename: String,
	width: Number,
	height: Number,
	fileSizeBytes: Number,
	cameraIndex: Number,
	metadata: Schema.Types.Mixed,

	// LIZA processing provenance
	processingMode: { type: String, enum: ['full', 'raw', null] },
	processingParams: {
		redCorrection: { type: Number, default: 0.85 },
		greenCorrection: { type: Number, default: 0.90 },
		blueCorrection: { type: Number, default: 1.0 },
		claheStrength: { type: Number, default: 2.0 },
		gamma: { type: Number, default: 0.85 },
		_id: false
	},
	processedAt: Date,

	// Embedding cache — feature vector for the classifier, keyed by version
	// so an embedding upgrade (e.g. color-spatial → DINOv2) invalidates
	// cleanly. Recomputed on demand from the R2 image when stale.
	embedding: [Number],
	embeddingVersion: String,
	embeddedAt: Date
}, { timestamps: true });

cvImageSchema.index({ embeddingVersion: 1 });

export const CvImage = mongoose.models.CvImage || mongoose.model('CvImage', cvImageSchema, 'cv_images');
