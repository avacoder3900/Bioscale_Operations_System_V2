import mongoose, { Schema } from 'mongoose';

const manufacturingSettingsSchema = new Schema({
	_id: { type: String, default: 'default' },
	waxFilling: {
		minOvenTimeMin: Number, runDurationMin: Number, removeDeckWarningMin: Number,
		coolingWarningMin: Number, deckLockoutMin: Number, incubatorTempC: Number,
		heaterTempC: Number, waxPerDeckUl: Number, tubeCapacityUl: Number,
		waxPerCartridgeUl: Number, cartridgesPerColumn: Number,
		meltDurationMin: { type: Number, default: 30 },
		// Dead volume added on top of waxPerCartridgeUl × count when computing
		// the 2ml-tube fill instruction (WAX-FLOW-3). Default keeps 24 carts
		// near the legacy flat 800 μL.
		waxFillDeadVolumeUl: { type: Number, default: 80 }
	},
	reagentFilling: {
		// Legacy flat rate. Superseded by the three tuning constants below, which
		// account for how many reagent rows the operator actually selected. Kept
		// only as a fallback for records written before the change.
		fillTimePerCartridgeMin: Number,
		// Run-duration model — see src/lib/manufacturing/reagent-run-estimate.ts.
		// seconds = startup + rows × perRow + wellsFilled × perDispense
		startupOverheadSec: Number,
		secondsPerReagentGroup: Number,
		secondsPerDispense: Number,
		minCoolingTimeMin: Number,
		// Top-seal deadline: minutes after run finishes before sealing is overdue.
		// Warn-only (not blocking); operator can still seal past the deadline,
		// but the queue row + per-run page show a red countdown and audit log
		// records the lateness for QA correlation.
		maxTimeBeforeSealMin: Number
	},
	general: {
		topSealLengthPerCutFt: Number, defaultRollLengthFt: Number,
		cartridgesPerLaserCutSheet: Number, sheetsPerLaserBatch: Number,
		defaultLaserTools: String, defaultCuttingProgramLink: String
	},
	// Thermoseal roll tracking (BUCKET-SYSTEM_PLAN v2 §3.4). Defaults live in
	// thermoseal-service.ts; these override when set.
	thermoseal: {
		notificationsEnabled: Boolean, // development toggle: kanban restock card + email only when true (default off)
		cmPerCartridge: Number,      // default 3.75 cm (averaged for excess)
		rollLengthCm: Number,        // default 6500 cm (65 m per roll)
		minRollsInInventory: Number  // default 2 — restock alert when on-hand drops below
	},
	rejectionReasonCodes: [{ _id: false, code: String, label: String, processType: String, sortOrder: Number }],
	temperatureAlerts: {
		emailRecipients: [String]
	},
	updatedAt: Date
}, { timestamps: false });

export const ManufacturingSettings = mongoose.models.ManufacturingSettings || mongoose.model('ManufacturingSettings', manufacturingSettingsSchema, 'manufacturing_settings');
