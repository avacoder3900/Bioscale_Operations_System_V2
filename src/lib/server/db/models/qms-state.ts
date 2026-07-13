import mongoose, { Schema } from 'mongoose';

/**
 * QMS regulated-environment state — a single global document (_id: 'default').
 *
 * `phase` is the master switch:
 *   - 'configuration' (default): open setup mode. Mutations are still audited and
 *      anti-lockout guards apply, but no step-up re-auth / e-signature is required.
 *   - 'regulated': the full GxP regime. Tier-2 actions require step-up re-auth
 *      (captured as an ElectronicSignature), sessions are killed on deactivate/reset,
 *      and guards are hard-enforced.
 *
 * The transition is driven by the "Start QMS Regulated Environment" button and is
 * itself a deliberate, audited Tier-2 action. See ADMIN-01 PRD.
 */
const transitionSchema = new Schema(
	{
		from: { type: String, enum: ['configuration', 'regulated'] },
		to: { type: String, enum: ['configuration', 'regulated'] },
		at: Date,
		by: { _id: String, username: String },
		reason: String
	},
	{ _id: false }
);

const qmsStateSchema = new Schema(
	{
		_id: { type: String, default: 'default' },
		phase: { type: String, enum: ['configuration', 'regulated'], default: 'configuration' },

		// Seconds a recent step-up re-auth stays valid before a Tier-2 action re-prompts.
		reauthWindowSec: { type: Number, default: 300 },

		activatedAt: Date,
		activatedBy: { _id: String, username: String },
		activationReason: String,

		deactivatedAt: Date,
		deactivatedBy: { _id: String, username: String },
		deactivationReason: String,

		transitions: [transitionSchema]
	},
	{ timestamps: true }
);

export const QmsState =
	mongoose.models.QmsState || mongoose.model('QmsState', qmsStateSchema, 'qms_state');
