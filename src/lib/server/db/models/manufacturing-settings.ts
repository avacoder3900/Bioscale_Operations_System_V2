import mongoose, { Schema } from 'mongoose';

const manufacturingSettingsSchema = new Schema({
	_id: { type: String, default: 'default' },
	waxFilling: {
		minOvenTimeMin: Number, runDurationMin: Number, removeDeckWarningMin: Number,
		coolingWarningMin: Number, deckLockoutMin: Number, incubatorTempC: Number,
		heaterTempC: Number, waxPerDeckUl: Number, tubeCapacityUl: Number,
		waxPerCartridgeUl: Number, cartridgesPerColumn: Number
	},
	reagentFilling: { fillTimePerCartridgeMin: Number, minCoolingTimeMin: Number },
	general: {
		topSealLengthPerCutFt: Number, defaultRollLengthFt: Number,
		cartridgesPerLaserCutSheet: Number, sheetsPerLaserBatch: Number,
		defaultLaserTools: String, defaultCuttingProgramLink: String
	},
	rejectionReasonCodes: [{ _id: false, code: String, label: String, processType: String, sortOrder: Number }],
	temperatureAlerts: {
		emailRecipients: [String]
	},
	opticalConfirmation: {
		parameters: [{ _id: false, name: String, channel: String, unit: String, min: Number, max: Number, target: Number, required: { type: Boolean, default: true } }],
		locked: { type: Boolean, default: false },
		lockedBy: { _id: String, username: String },
		lockedAt: Date,
		version: { type: Number, default: 1 }
	},
	updatedAt: Date
}, { timestamps: false });

export const ManufacturingSettings = mongoose.models.ManufacturingSettings || mongoose.model('ManufacturingSettings', manufacturingSettingsSchema, 'manufacturing_settings');
