import mongoose, { Schema } from 'mongoose';
import { generateId } from '../utils.js';

const routingPatternSchema = new Schema({
	_id: { type: String, default: () => generateId() },
	contentType: String, keywords: Schema.Types.Mixed, stakeholderRoles: Schema.Types.Mixed,
	routingRules: Schema.Types.Mixed, confidenceScore: Number, successRate: Number,
	usageCount: { type: Number, default: 0 }, lastUsed: Date
}, { timestamps: true });

export const RoutingPattern = mongoose.models.RoutingPattern || mongoose.model('RoutingPattern', routingPatternSchema, 'routing_patterns');
