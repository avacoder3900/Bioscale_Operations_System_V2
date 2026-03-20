import mongoose, { Schema } from 'mongoose';
import { generateId } from '../utils.js';

const customerSchema = new Schema({
	_id: { type: String, default: () => generateId() },
	name: { type: String, required: true },
	customerType: String,
	contactName: String, contactEmail: String, contactPhone: String, address: String,
	status: { type: String, enum: ['active', 'inactive'], default: 'active' },
	customFields: Schema.Types.Mixed,
	notes: [{
		_id: { type: String, default: () => generateId() },
		noteText: String,
		createdBy: { _id: String, username: String },
		createdAt: Date
	}]
}, { timestamps: true });

export const Customer = mongoose.models.Customer || mongoose.model('Customer', customerSchema, 'customers');
