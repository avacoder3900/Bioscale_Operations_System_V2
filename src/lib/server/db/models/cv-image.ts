import mongoose, { Schema } from 'mongoose';
import { generateId } from '../utils.js';

const cvImageSchema = new Schema({
	_id: { type: String, default: () => generateId() },
	sampleId: String,
	projectId: { type: String, index: true },
	filename: String,
	filePath: String,
	thumbnailPath: String,
	width: Number,
	height: Number,
	fileSizeBytes: Number,
	cameraIndex: Number,
	metadata: Schema.Types.Mixed,
	capturedAt: Date,
	imageUrl: String,
	cartridgeTag: {
		cartridgeRecordId: String,
		phase: String,
		labels: [String],
		notes: String,
		_id: false
	},
	label: { type: String, enum: ['approved', 'rejected', null], default: null }
}, { timestamps: true });

cvImageSchema.index({ sampleId: 1 });
cvImageSchema.index({ label: 1 });

export const CvImage = mongoose.models.CvImage || mongoose.model('CvImage', cvImageSchema, 'cv_images');
