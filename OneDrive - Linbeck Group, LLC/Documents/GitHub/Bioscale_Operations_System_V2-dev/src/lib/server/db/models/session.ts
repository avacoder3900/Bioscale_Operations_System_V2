import mongoose, { Schema } from 'mongoose';
import { generateId } from '../utils.js';

const sessionSchema = new Schema({
	_id: { type: String, default: () => generateId() },
	userId: { type: String, required: true },
	expiresAt: { type: Date, required: true }
}, { timestamps: false });

sessionSchema.index({ userId: 1 });
sessionSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

export const Session = mongoose.models.Session || mongoose.model('Session', sessionSchema, 'sessions');
