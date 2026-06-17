import mongoose, { Schema } from 'mongoose';
import { generateId } from '../utils.js';

/**
 * BimsAnomaly — system-detected data integrity issue.
 *
 * Populated by the Phase 8.1 daily integrity scan (Vercel Cron, not yet
 * deployed) which runs the same checks as the `check_data_integrity` Ask BIMS
 * tool, but persists findings for trending and admin review.
 *
 * Each anomaly is keyed by (kind, targetType, targetId) so a recurring issue
 * on the same record produces ONE row that gets updated, not a stream of
 * duplicates. firstSeenAt tracks original detection; lastSeenAt updates on
 * every scan that still finds the issue. resolvedAt set when the anomaly no
 * longer fires.
 */

const bimsAnomalySchema = new Schema({
	_id: { type: String, default: () => generateId() },

	// Categorization
	kind: {
		type: String,
		required: true,
		enum: [
			'null_wax_source_lot',          // WaxFillingRun.waxSourceLot is null on completed run
			'over_consumed_receiving_lot',  // ReceivingLot.consumedUl > capacity
			'stale_temperature_read',       // Equipment.lastTemperatureReadAt > N hours
			'stuck_cartridge',              // CartridgeRecord in non-terminal status > N days
			'orphan_lot_reference',         // run.waxSourceLot does not match any ReceivingLot
			'denormalized_counter_drift',   // PartDefinition.inventoryCount != ReceivingLot sum
			'other'
		]
	},
	severity: { type: String, enum: ['info', 'warning', 'error'], default: 'warning' },

	// What's affected
	targetType: { type: String, required: true }, // 'WaxFillingRun', 'ReceivingLot', etc.
	targetId: { type: String, required: true },
	details: Schema.Types.Mixed, // arbitrary kind-specific context

	// Lifecycle
	firstSeenAt: { type: Date, required: true, default: () => new Date() },
	lastSeenAt: { type: Date, required: true, default: () => new Date() },
	resolvedAt: Date,
	occurrenceCount: { type: Number, default: 1 }, // increments on each scan that still finds it

	// Optional metadata
	scanRunId: String, // links related anomalies from the same scan invocation
	notes: String
}, { timestamps: true });

// One row per (kind, targetType, targetId) — ensures upsert semantics
bimsAnomalySchema.index({ kind: 1, targetType: 1, targetId: 1 }, { unique: true });
bimsAnomalySchema.index({ resolvedAt: 1, lastSeenAt: -1 }); // open anomalies, newest first
bimsAnomalySchema.index({ kind: 1, lastSeenAt: -1 });
bimsAnomalySchema.index({ scanRunId: 1 });

export const BimsAnomaly = mongoose.models.BimsAnomaly || mongoose.model('BimsAnomaly', bimsAnomalySchema, 'bims_anomalies');
