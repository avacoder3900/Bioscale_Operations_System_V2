import mongoose, { Schema } from 'mongoose';
import { generateId } from '../utils.js';

/**
 * A named set of cartridges.
 *
 * One kind of group (2026-09-10, per Jacob — "a linked group IS an analysis
 * group"): `purpose: 'optical_analysis'`, whether it was created by typing a name
 * on the optical-confirmation assign form or curated by hand on the optical log.
 * 'assign_batch' is a retired value: those groups were folded into same-named
 * analysis groups and archived by scripts/unify-optical-groups.ts.
 *
 * Membership lives HERE, as `cartridgeIds`, and not on `OpticalTestCartridge.groupId`.
 * That field cannot represent an analysis cohort: only BIMS-*assigned* cartridges get
 * an OpticalTestCartridge doc, while the optical log deliberately also lists
 * COMPARATOR cartridges (matched by assayId alone) that have no such doc at all.
 *
 * Nothing in this model or its actions ever writes to `cartridge_records` — that
 * collection is sacred, and its `rawData`/`device` fields are owned by brevitest-cloud.
 */
const cartridgeGroupSchema = new Schema(
	{
		_id: { type: String, default: () => generateId() },
		name: String,
		description: String,
		/**
		 * A palette KEY (e.g. 'cyan'), never a hex. Tailwind cannot generate classes
		 * from a runtime value, so an interpolated hex silently renders no colour.
		 */
		color: String,
		createdBy: String,

		purpose: {
			type: String,
			enum: ['assign_batch', 'optical_analysis'],
			default: 'optical_analysis'
		},

		/** cartridge_records._id — which, for optical cartridges, IS the scanned barcode. */
		cartridgeIds: { type: [String], default: [] },

		/** Soft delete. BIMS records are never hard-deleted. */
		archivedAt: Date
	},
	{ timestamps: true }
);

// Deliberately NOT unique on `name`: the assign endpoint has always created groups
// with a plain findOne({name}) and no uniqueness guarantee, so a unique index could
// fail to build on existing data and would 500 that endpoint on a collision. Name
// collisions are handled in the action layer with an explicit 409 instead.
cartridgeGroupSchema.index({ purpose: 1, name: 1 });
cartridgeGroupSchema.index({ cartridgeIds: 1 });
cartridgeGroupSchema.index({ archivedAt: 1 });

export const CartridgeGroup =
	mongoose.models.CartridgeGroup ||
	mongoose.model('CartridgeGroup', cartridgeGroupSchema, 'cartridge_groups');
