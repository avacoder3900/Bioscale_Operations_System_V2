import mongoose, { Schema } from 'mongoose';
import { generateId } from '../utils.js';

const operatorRef = { _id: String, username: String };

const cvImageSchema = new Schema({
	_id: { type: String, default: () => generateId() },

	// Identity — cartridge-first. Required after the refactor.
	cartridgeTag: {
		cartridgeRecordId: { type: String, required: true, index: true },
		phase: { type: String, required: true },
		labels: [String],
		notes: String,
		_id: false
	},
	cartridgeImageNumber: { type: String, index: true },

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

	// Capture metadata
	capturedAt: Date,
	capturedBy: operatorRef,

	// QC label — optional, demoted from identity to a side field
	qcLabel: { type: String, enum: ['approved', 'rejected', null], default: null },
	qcLabeledBy: operatorRef,
	qcLabeledAt: Date
}, { timestamps: true });

cvImageSchema.index({ qcLabel: 1 });
cvImageSchema.index({ capturedAt: -1 });

export const CvImage = mongoose.models.CvImage || mongoose.model('CvImage', cvImageSchema, 'cv_images');
