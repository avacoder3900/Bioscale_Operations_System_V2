import type { Schema } from 'mongoose';

/**
 * Immutable log middleware — blocks ALL updates and deletes.
 * Apply to Tier 3 immutable logs: audit_log, electronic_signatures,
 * inventory_transactions, device_events, manufacturing_material_transactions.
 */
export function applyImmutableMiddleware(schema: Schema) {
	const blockMutation = function (this: any, next: any) {
		return next(new Error('Immutable log documents cannot be modified'));
	};
	schema.pre('updateOne', blockMutation);
	schema.pre('updateMany', blockMutation);
	schema.pre('findOneAndUpdate', blockMutation);
	schema.pre('findOneAndReplace', blockMutation);

	const blockDelete = function (this: any, next: any) {
		return next(new Error('Immutable log documents cannot be deleted'));
	};
	schema.pre('deleteOne', blockDelete);
	schema.pre('deleteMany', blockDelete);
	schema.pre('findOneAndDelete', blockDelete);
}
