import mongoose, { Schema } from 'mongoose';
import { generateId } from '../utils.js';

const serviceTicketSchema = new Schema({
	_id: { type: String, default: () => generateId() },
	spuId: String,
	spuSerialNumber: String,
	title: String,
	description: String,
	priority: { type: String, enum: ['low', 'medium', 'high', 'critical'], default: 'medium' },
	status: { type: String, enum: ['open', 'in_progress', 'waiting', 'closed'], default: 'open' },
	assignedTo: { _id: String, username: String },
	createdBy: { _id: String, username: String },
	resolution: String,
	notes: [{ text: String, author: String, createdAt: { type: Date, default: Date.now } }]
}, { timestamps: true });

serviceTicketSchema.index({ spuId: 1 });
serviceTicketSchema.index({ status: 1 });
serviceTicketSchema.index({ createdAt: -1 });

export const ServiceTicket = mongoose.models.ServiceTicket || mongoose.model('ServiceTicket', serviceTicketSchema, 'service_tickets');
