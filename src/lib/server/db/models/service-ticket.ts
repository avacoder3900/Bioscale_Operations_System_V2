import mongoose, { Schema } from 'mongoose';
import { generateId } from '../utils.js';

const operatorRef = { _id: String, username: String };

const serviceTicketSchema = new Schema({
	_id: { type: String, default: () => generateId() },
	spuId: { type: String, required: true },
	spuUdi: String,
	spuBarcode: String,

	status: {
		type: String,
		enum: ['open', 'in_progress', 'pending_parts', 'resolved', 'closed'],
		default: 'open'
	},

	reason: String,
	priority: { type: String, enum: ['low', 'medium', 'high', 'critical'], default: 'medium' },

	previousSpuStatus: String,

	openedBy: operatorRef,
	assignedTo: operatorRef,
	openedAt: { type: Date, default: () => new Date() },
	resolvedAt: Date,
	closedAt: Date,

	partsReplaced: [{
		_id: { type: String, default: () => generateId() },
		spuPartId: String,
		partNumber: String,
		partName: String,
		oldLotNumber: String,
		newLotNumber: String,
		newSerialNumber: String,
		reason: String,
		replacedBy: operatorRef,
		replacedAt: Date
	}],

	firmwareChanges: [{
		_id: { type: String, default: () => generateId() },
		deviceType: String,
		previousVersion: String,
		newVersion: String,
		reason: String,
		performedBy: operatorRef,
		performedAt: Date
	}],

	otherChanges: [{
		_id: { type: String, default: () => generateId() },
		category: String,
		description: String,
		performedBy: operatorRef,
		performedAt: Date
	}],

	notes: [{
		_id: { type: String, default: () => generateId() },
		text: String,
		addedBy: operatorRef,
		addedAt: { type: Date, default: () => new Date() }
	}],

	resolution: {
		summary: String,
		returnStatus: String,
		resolvedBy: operatorRef,
		resolvedAt: Date
	}
}, { timestamps: true });

serviceTicketSchema.index({ spuId: 1 });
serviceTicketSchema.index({ status: 1, openedAt: -1 });
serviceTicketSchema.index({ 'openedBy._id': 1 });

export const ServiceTicket = mongoose.models.ServiceTicket || mongoose.model('ServiceTicket', serviceTicketSchema, 'service_tickets');
