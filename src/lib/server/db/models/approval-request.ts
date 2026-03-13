import mongoose, { Schema } from 'mongoose';
import { generateId } from '../utils.js';

const approvalRequestSchema = new Schema({
	_id: { type: String, default: () => generateId() },
	requesterId: String, changeTitle: String, changeDescription: String,
	changeType: { type: String, enum: ['code', 'configuration', 'infrastructure', 'process', 'documentation', 'database'] },
	priority: { type: String, enum: ['low', 'normal', 'high', 'urgent', 'emergency'] },
	affectedSystems: Schema.Types.Mixed, impactAnalysis: Schema.Types.Mixed,
	status: { type: String, enum: ['pending', 'in_review', 'approved', 'rejected', 'cancelled', 'expired'] },
	dueDate: Date, approvedAt: Date, approvedBy: String,
	history: [{
		_id: { type: String, default: () => generateId() },
		stakeholderId: String,
		action: { type: String, enum: ['requested', 'reviewed', 'approved', 'rejected', 'escalated', 'cancelled', 'commented'] },
		comments: String, decisionRationale: String, timestamp: Date, ipAddress: String
	}]
}, { timestamps: true });

export const ApprovalRequest = mongoose.models.ApprovalRequest || mongoose.model('ApprovalRequest', approvalRequestSchema, 'approval_requests');
