import mongoose, { Schema } from 'mongoose';
import { generateId } from '../utils.js';

// Binary fallback store for work-instruction images. Images are uploaded to
// R2 when the worker/S3 credentials are configured; when they are not (e.g.
// local dev, or an import script), the bytes land here and are served by
// /api/device-assembly/images/[id]. One document per image, so the 16 MB
// per-document limit is never a concern for the WI document itself.

const workInstructionImageSchema = new Schema({
	_id: { type: String, default: () => generateId() },
	wiId: { type: String, default: null, index: true },
	contentType: { type: String, required: true },
	size: { type: Number, required: true },
	data: { type: Buffer, required: true },
	originalName: { type: String, default: null },
	uploadedAt: { type: Date, default: Date.now },
	uploadedBy: { type: String, default: null }
}, { timestamps: false });

export const WorkInstructionImage =
	mongoose.models.WorkInstructionImage ||
	mongoose.model('WorkInstructionImage', workInstructionImageSchema, 'work_instruction_images');
