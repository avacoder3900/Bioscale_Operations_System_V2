import mongoose, { Schema } from 'mongoose';
import { generateId } from '../utils.js';

const agentQuerySchema = new Schema({
	_id: { type: String, default: () => generateId() },
	name: String, description: String,
	category: { type: String, enum: ['inventory', 'manufacturing', 'quality', 'projects', 'customer', 'audit', 'reporting'] },
	collectionName: String,
	mongoQuery: Schema.Types.Mixed,
	sqlTemplate: String, // deprecated — kept for backward compat
	parametersSchema: Schema.Types.Mixed, resultFormat: Schema.Types.Mixed,
	isActive: { type: Boolean, default: true }, maxRows: Number, timeoutMs: Number, createdBy: String
}, { timestamps: true });

export const AgentQuery = mongoose.models.AgentQuery || mongoose.model('AgentQuery', agentQuerySchema, 'agent_queries');
