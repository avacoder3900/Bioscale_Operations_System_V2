import mongoose, { Schema } from 'mongoose';
import { generateId } from '../utils.js';
import { applyImmutableMiddleware } from '../middleware/immutable.js';

const auditLogSchema = new Schema({
	_id: { type: String, default: () => generateId() },
	tableName: String, recordId: String,
	action: { type: String, enum: ['INSERT', 'UPDATE', 'DELETE', 'PHASE_ADVANCE'] },
	oldData: Schema.Types.Mixed, newData: Schema.Types.Mixed,
	changedAt: { type: Date, default: Date.now }, changedBy: String,
	changedFields: Schema.Types.Mixed, reason: String,
	sessionId: String, ipAddress: String, userAgent: String
}, { timestamps: false });

auditLogSchema.index({ tableName: 1, recordId: 1 });
auditLogSchema.index({ changedAt: -1 });
auditLogSchema.index({ changedBy: 1, changedAt: -1 });

applyImmutableMiddleware(auditLogSchema);

export const AuditLog = mongoose.models.AuditLog || mongoose.model('AuditLog', auditLogSchema, 'audit_log');
