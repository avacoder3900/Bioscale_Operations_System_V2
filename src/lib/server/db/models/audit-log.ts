import mongoose, { Schema } from 'mongoose';
import { generateId } from '../utils.js';
import { applyImmutableMiddleware } from '../middleware/immutable.js';

const auditLogSchema = new Schema({
	_id: { type: String, default: () => generateId() },
	tableName: String, recordId: String,
	// IMPROPER_ORDER_BLOCKED: written by protectLockedCarts() when a wax-flow
	// action (completeQC, goBack, etc) is attempted on a cartridge that's
	// already past wax (linked/underway/completed/voided/scrapped). Without
	// this enum value, the insertMany throws and the wrapping action 500s
	// mid-flight, leaving the run advanced but cartridges stuck.
	action: { type: String, enum: ['INSERT', 'UPDATE', 'DELETE', 'PHASE_ADVANCE', 'CHECKOUT', 'IMPROPER_ORDER_BLOCKED'] },
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
