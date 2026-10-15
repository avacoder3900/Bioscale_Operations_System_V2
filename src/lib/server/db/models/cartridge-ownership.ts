import mongoose, { Schema } from 'mongoose';
import { generateId } from '../utils.js';

/**
 * Cartridge ownership — which consumer-app account (and, for clinics, which
 * patient "subject") a physical cartridge belongs to. One row per stint, at
 * most ONE open row per cartridge (partial unique index), modelled on `custody`.
 *
 * Why a separate collection and not a field on cartridge_records: that
 * collection is sacred, the consumer app reads it with the raw driver and must
 * never write it, and brevitest-cloud owns the run-side fields — a field added
 * there could be clobbered by any of those writers. Rows here are written by
 * BIMS only (the consumer API in src/routes/api/consumer and the ship-time hook
 * on the shipping page); the app reads them directly from the shared database.
 *
 * Identity keys (docs/CONSUMER-OWNERSHIP.md):
 *   accountId  = app_users._id  (`${provider}:${sub}`) — never an email
 *   customerId = customers._id   — the purchasing/shipping party (clinic or person)
 *   subjectId  = subjects._id    — the app-owned patient record; null means
 *                "the account holder themselves" (or, for a clinic row, not yet
 *                assigned to a patient).
 */
const actorRef = {
	kind: { type: String, enum: ['account', 'operator', 'system'] },
	id: String,     // app_users._id | users._id | 'shipping-hook'
	label: String   // email or username, for display only
};

const cartridgeOwnershipSchema = new Schema({
	_id: { type: String, default: () => generateId() },
	cartridgeId: { type: String, required: true },   // cartridge_records._id (the QR payload)
	accountId: String,                               // owning account; null on a clinic row not yet assigned
	customerId: String,                              // scope for clinic visibility
	subjectId: String,                               // app-owned patient; null = account holder / unassigned
	source: { type: String, enum: ['shipment', 'claim', 'device', 'operator'], required: true },
	// Recorded, not enforced: did the cartridge's shipment customer match one of
	// the claimer's customers at claim time? False claims surface on the
	// cartridge-admin ownership report for review.
	matchedShipment: { type: Boolean, default: false },
	shipmentCustomerId: String,
	open: { type: Boolean, default: true },
	claimedAt: { type: Date, default: Date.now },
	claimedBy: actorRef,
	releasedAt: Date,
	releasedBy: actorRef,
	releaseReason: { type: String, enum: ['user', 'operator', 'reassigned', 'transfer'] },
	releaseNote: String
}, { timestamps: true });

cartridgeOwnershipSchema.index({ cartridgeId: 1 }, { unique: true, partialFilterExpression: { open: true } });
cartridgeOwnershipSchema.index({ cartridgeId: 1, claimedAt: -1 });
cartridgeOwnershipSchema.index({ accountId: 1, open: 1 });
cartridgeOwnershipSchema.index({ customerId: 1, open: 1 });
cartridgeOwnershipSchema.index({ subjectId: 1, open: 1 });
cartridgeOwnershipSchema.index({ open: 1, matchedShipment: 1, claimedAt: -1 });

export const CartridgeOwnership = mongoose.models.CartridgeOwnership
	|| mongoose.model('CartridgeOwnership', cartridgeOwnershipSchema, 'cartridge_ownership');
