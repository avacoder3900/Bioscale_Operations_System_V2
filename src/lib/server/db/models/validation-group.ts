import mongoose, { Schema } from 'mongoose';
import { generateId } from '../utils.js';

// A named, reusable pool of optical-test cartridges. Any SPU can draw a cartridge from any group.
const validationGroupSchema = new Schema(
	{
		_id: { type: String, default: () => generateId() },
		name: String,
		description: String,
		color: String,
		createdBy: String
	},
	{ timestamps: true }
);

validationGroupSchema.index({ name: 1 });

export const ValidationGroup =
	mongoose.models.ValidationGroup ||
	mongoose.model('ValidationGroup', validationGroupSchema, 'validation_groups');
