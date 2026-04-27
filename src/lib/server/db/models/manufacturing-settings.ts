import mongoose, { Schema } from 'mongoose';

const manufacturingSettingsSchema = new Schema({
	_id: { type: String, default: 'default' },
	waxFilling: {
		minOvenTimeMin: Number, runDurationMin: Number, removeDeckWarningMin: Number,
		coolingWarningMin: Number, deckLockoutMin: Number, incubatorTempC: Number,
		heaterTempC: Number, waxPerDeckUl: Number, tubeCapacityUl: Number,
		waxPerCartridgeUl: Number, cartridgesPerColumn: Number,
		meltDurationMin: { type: Number, default: 30 }
	},
	reagentFilling: {
		fillTimePerCartridgeMin: Number,
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
	rejectionReasonCodes: [{ _id: false, code: String, label: String, processType: String, sortOrder: Number }],
	temperatureAlerts: {
		emailRecipients: [String]
	},
	updatedAt: Date
}, { timestamps: false });

export const ManufacturingSettings = mongoose.models.ManufacturingSettings || mongoose.model('ManufacturingSettings', manufacturingSettingsSchema, 'manufacturing_settings');
