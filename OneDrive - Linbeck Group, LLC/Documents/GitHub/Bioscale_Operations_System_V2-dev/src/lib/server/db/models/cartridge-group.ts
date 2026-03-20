import mongoose, { Schema } from 'mongoose';
import { generateId } from '../utils.js';

const cartridgeGroupSchema = new Schema({
	_id: { type: String, default: () => generateId() },
	name: String, description: String, color: String, createdBy: String
}, { timestamps: true });

export const CartridgeGroup = mongoose.models.CartridgeGroup || mongoose.model('CartridgeGroup', cartridgeGroupSchema, 'cartridge_groups');
