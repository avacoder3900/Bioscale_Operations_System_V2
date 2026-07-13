import mongoose, { Schema } from 'mongoose';
import { generateId } from '../utils.js';

const operatorRef = { _id: String, username: String };

const cvImageSchema = new Schema({
	_id: { type: String, default: () => generateId() },

	// Identity — cartridge-first for phase captures. Not required at the schema level:
	// project-scoped demo/R&D uploads (POST /api/cv/images) have no cartridge. The
	// capture endpoint still enforces cartridge presence for phase captures.
	cartridgeTag: {
		cartridgeRecordId: { type: String, index: true },
		phase: String,
		labels: [String],
		notes: String,
		_id: false
	},
	cartridgeImageNumber: { type: String, index: true },

	// Project-scoped uploads without a cartridge (demo/R&D via POST /api/cv/images)
	projectId: { type: String, index: true },
	sampleId: String,

	// Where the pixels live
	filename: String,
	filePath: String,
	thumbnailPath: String,
	imageUrl: String,
	width: Number,
	height: Number,
	fileSizeBytes: Number,
	cameraIndex: Number,
	metadata: Schema.Types.Mixed,

	// Processing pipeline
	processedPath: String,
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

	// Embedding cache (cv-color-spatial-v1, 156 floats) — select:false so routine
	// queries never drag it; the trainer selects it explicitly.
	embedding: { type: [Number], select: false },
	embeddingVersion: String,

	// Capture metadata
	capturedAt: Date,
	capturedBy: operatorRef,

	// Camera view the photo was shot from. Top and bottom of a cartridge look
	// completely different, so a model trains on and grades exactly one view.
	// null = untagged legacy photo (only graded by view-less projects).
	view: { type: String, enum: ['top', 'bottom', null], default: null },

	// How `view` was assigned: 'manual' = operator's Top/Bottom toggle;
	// 'barcode-auto' = inferred at capture from barcode presence (barcode ⇒ top);
	// null = untagged (no toggle and detection unavailable).
	viewSource: { type: String, enum: ['manual', 'barcode-auto', null], default: null },

	// Photo type descriptor (CV-MICROSCOPE-01): 'inspection' = standard station
	// photo, phase-bound; 'microscope' = timed grid-sequence shot. Microscope is
	// a descriptor, not a mfg state — phase stays unset and view auto-classify +
	// phase inference are skipped at ingest.
	photoType: { type: String, enum: ['inspection', 'microscope'], default: 'inspection' },

	// Microscope grid-sequence identity, stamped by the station agent:
	// sequenceId groups one run, sequenceIndex = order taken (1-based),
	// location = named grid slot (row letter / column number, e.g. B4).
	sequenceId: { type: String, index: true },
	sequenceIndex: Number,
	location: { row: String, col: Number, _id: false },

	// QC label — optional, demoted from identity to a side field
	qcLabel: { type: String, enum: ['approved', 'rejected', null], default: null },
	qcLabeledBy: operatorRef,
	qcLabeledAt: Date
}, { timestamps: true });

cvImageSchema.index({ qcLabel: 1 });
cvImageSchema.index({ capturedAt: -1 });
cvImageSchema.index({ 'cartridgeTag.labels': 1 });

export const CvImage = mongoose.models.CvImage || mongoose.model('CvImage', cvImageSchema, 'cv_images');
