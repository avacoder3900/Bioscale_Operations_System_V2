import mongoose, { Schema } from 'mongoose';
import { generateId } from '../utils.js';

const toolConfirmationSchema = new Schema({
	_id: { type: String, default: () => generateId() },
	lotId: { type: String, required: true }, // ReceivingLot._id
	toolId: { type: String, required: true }, // e.g., "TOOL-SPU-007"
	toolName: { type: String, required: true },
	confirmedBy: { _id: String, username: String },
	confirmedAt: { type: Date, default: Date.now }
}, { timestamps: true });

toolConfirmationSchema.index({ lotId: 1 });

export const ToolConfirmation = mongoose.models.ToolConfirmation
	|| mongoose.model('ToolConfirmation', toolConfirmationSchema, 'tool_confirmations');
