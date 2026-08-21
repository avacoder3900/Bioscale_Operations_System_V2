import mongoose, { Schema } from 'mongoose';
import { generateId } from '../utils.js';

const agentMessageSchema = new Schema({
	_id: { type: String, default: () => generateId() },
	fromUserId: String, toUserId: String,
	messageType: { type: String, enum: ['info', 'alert', 'request', 'approval', 'status_update', 'meeting_summary'] },
	subject: String, content: String,
	priority: { type: String, enum: ['low', 'normal', 'high', 'urgent'] },
	status: { type: String, enum: ['pending', 'sent', 'delivered', 'read', 'actioned', 'failed'] },
	relatedEntityType: String, relatedEntityId: String,
	routingReason: String, audienceTier: String, failureReason: String,
	retryCount: { type: Number, default: 0 },
	sentAt: Date, deliveredAt: Date, readAt: Date, actionedAt: Date
}, { timestamps: true });

// Messages endpoints filter/sort by user + status with no indexes at all —
// two full scans per list request (Atlas query-targeting audit, 2026-07-31).
agentMessageSchema.index({ toUserId: 1, createdAt: -1 });
agentMessageSchema.index({ fromUserId: 1, createdAt: -1 });
agentMessageSchema.index({ status: 1, createdAt: -1 });

export const AgentMessage = mongoose.models.AgentMessage || mongoose.model('AgentMessage', agentMessageSchema, 'agent_messages');
