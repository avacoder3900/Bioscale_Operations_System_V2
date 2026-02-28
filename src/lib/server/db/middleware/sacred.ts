import type { Schema } from 'mongoose';

/**
 * Sacred document middleware — blocks mutations after finalizedAt is set.
 * Apply to Tier 1 sacred documents: cartridge_records, spus, assay_definitions, reagent_batch_records, users.
 * Users use deactivatedAt instead of finalizedAt (handled separately).
 */
export function applySacredMiddleware(schema: Schema, finalizedField = 'finalizedAt') {
	const checkFinalized = async function (this: any, next: any) {
		const update = this.getUpdate?.();
		const filter = this.getFilter?.();
		if (!filter) return next();

		const Model = this.model;
		const doc = await Model.findOne(filter).select(finalizedField).lean();
		if (doc && doc[finalizedField]) {
			return next(new Error(`Cannot modify a finalized sacred document (${finalizedField} is set)`));
		}
		next();
	};

	schema.pre('updateOne', checkFinalized);
	schema.pre('updateMany', checkFinalized);
	schema.pre('findOneAndUpdate', checkFinalized);
	schema.pre('findOneAndReplace', checkFinalized);

	// Block deletes on sacred documents
	const blockDelete = function (this: any, next: any) {
		return next(new Error('Sacred documents cannot be deleted'));
	};
	schema.pre('deleteOne', blockDelete);
	schema.pre('deleteMany', blockDelete);
	schema.pre('findOneAndDelete', blockDelete);
}
