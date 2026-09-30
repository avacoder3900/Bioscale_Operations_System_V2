import mongoose, { Schema } from 'mongoose';
import { generateId } from '../utils.js';

const operatorRef = { _id: String, username: String };

/**
 * Custody — who is responsible for a unit of work right now, one row per
 * stint (BADGE-SYSTEM_PLAN.md §15.2). Generic over `resourceType` so a bucket
 * pass is only the first consumer.
 *
 * Unlike capture_stations.currentOperator (which has no expiry and strands),
 * every row here is released by the same code path that closes the resource —
 * bucket-service.releaseCustody() from closeCycle() and voidCycle(). The
 * `open` flag exists for the partial unique index: at most ONE open custody
 * per resource, as a duplicate-key error rather than an app-level check.
 */
const custodySchema = new Schema({
	_id: { type: String, default: () => generateId() },
	resourceType: { type: String, enum: ['bucket_cycle'], required: true },
	resourceId: { type: String, required: true },   // BucketCycle._id
	bucketId: String,                               // denormalised for board/history queries
	operator: operatorRef,                          // the badge holder — the effective actor
	badgeId: String,                                // OperatorBadge._id when method === 'badge'
	method: { type: String, enum: ['badge', 'login', 'override'], required: true },
	enteredBy: operatorRef,                         // the web session that submitted the scan
	claimedAt: { type: Date, default: Date.now },
	open: { type: Boolean, default: true },
	releasedAt: Date,
	// 'scan_out' / 'takeover' / 'expired' are reserved for later phases (Part 1 §8).
	releaseReason: { type: String, enum: ['cycle_closed', 'voided', 'scan_out', 'takeover', 'expired'] }
}, { timestamps: false });

custodySchema.index({ resourceType: 1, resourceId: 1 }, { unique: true, partialFilterExpression: { open: true } });
custodySchema.index({ bucketId: 1, claimedAt: -1 });
custodySchema.index({ 'operator._id': 1, claimedAt: -1 });

export const Custody = mongoose.models.Custody || mongoose.model('Custody', custodySchema, 'custody');
