import mongoose, { Schema } from 'mongoose';
import { generateId } from '../utils.js';
import { applyImmutableMiddleware } from '../middleware/immutable.js';

const electronicSignatureSchema = new Schema({
	_id: { type: String, default: () => generateId() },
	userId: String, entityType: String, entityId: String,
	meaning: String, signedAt: Date, ipAddress: String,
	userAgent: String, dataHash: String
}, { timestamps: false });

applyImmutableMiddleware(electronicSignatureSchema);

export const ElectronicSignature = mongoose.models.ElectronicSignature || mongoose.model('ElectronicSignature', electronicSignatureSchema, 'electronic_signatures');
