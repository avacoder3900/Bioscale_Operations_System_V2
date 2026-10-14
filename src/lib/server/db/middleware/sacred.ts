import type { Schema } from 'mongoose';

/**
 * Sacred document middleware — blocks mutations after finalizedAt is set.
 * Apply to Tier 1 sacred documents: cartridge_records, spus, assay_definitions, reagent_batch_records, users.
 * Users use deactivatedAt instead of finalizedAt (handled separately).
 *
 * ANNOTATION OPT-IN (2026-10-14): a query with the option `allowFinalized: true`
 * skips the check. It exists for writes that annotate a finalized record
 * without changing any fact it records — the only user today is the Deck
 * Calibration Studio stamping resolvedAt/By/Note on a reagent run's
 * well-tracker entries (the run is finalized minutes after those entries are
 * logged, so the stamp could never land). Every such write must also create
 * an AuditLog row. Corrections to the record's facts still go through the
 * `corrections` pattern; this is not a general bypass.
 */
export const ALLOW_FINALIZED_OPTION = 'allowFinalized';

export function applySacredMiddleware(schema: Schema, finalizedField = 'finalizedAt') {
	const checkFinalized = async function (this: any) {
		const opts = this.getOptions?.() ?? this.options;
		if (opts && opts[ALLOW_FINALIZED_OPTION] === true) {
			// Consumed here so the driver never sees an unknown option.
			delete opts[ALLOW_FINALIZED_OPTION];
			return;
		}
		const filter = this.getFilter?.();
		if (!filter) return;

		const Model = this.model;
		const doc = await Model.findOne(filter).select(finalizedField).lean();
		if (doc && doc[finalizedField]) {
			throw new Error(`Cannot modify a finalized sacred document (${finalizedField} is set)`);
		}
	};

	schema.pre('updateOne', checkFinalized);
	schema.pre('updateMany', checkFinalized);
	schema.pre('findOneAndUpdate', checkFinalized);
	schema.pre('findOneAndReplace', checkFinalized);

	// Block deletes on sacred documents
	const blockDelete = function (this: any) {
		throw new Error('Sacred documents cannot be deleted');
	};
	schema.pre('deleteOne', blockDelete);
	schema.pre('deleteMany', blockDelete);
	schema.pre('findOneAndDelete', blockDelete);
}
