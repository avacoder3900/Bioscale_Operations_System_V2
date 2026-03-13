import mongoose, { Schema } from 'mongoose';
import { generateId } from '../utils.js';

const roleSchema = new Schema({
	_id: { type: String, default: () => generateId() },
	name: { type: String, required: true },
	description: String,
	permissions: [String],
	createdAt: { type: Date, default: Date.now }
}, { timestamps: false });

roleSchema.index({ name: 1 }, { unique: true });

export const Role = mongoose.models.Role || mongoose.model('Role', roleSchema, 'roles');
