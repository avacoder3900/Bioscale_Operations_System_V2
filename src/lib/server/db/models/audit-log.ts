import mongoose, { Schema } from 'mongoose';
import { generateId } from '../utils.js';
import { applyImmutableMiddleware } from '../middleware/immutable.js';

const auditLogSchema = new Schema({
	_id: { type: String, default: () => generateId() },
	tableName: String, recordId: String,
	// Free-form string. The codebase writes 10+ distinct values
	// (INSERT/UPDATE/DELETE/PHASE_ADVANCE/CHECKOUT plus IMPROPER_ORDER_BLOCKED,
	// GO_BACK, SYNC, IMPORT, UPSERT, RETIRE, REASSIGN_STORAGE, OVERRIDE,
	// manual_inventory_edit, create, ...). The previous enum was incomplete and
	// caused 500s mid-action whenever a new value was introduced (e.g. the
	// goBack action on the wax assign-fridge page). Audit-log action is
	// telemetry, not a state machine — keep it permissive.
	action: { type: String },
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
