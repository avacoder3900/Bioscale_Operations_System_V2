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
	rejectionReasonCodes: [{ code: String, label: String, processType: String, sortOrder: Number }],
	updatedAt: Date
}, { timestamps: false });

export const ManufacturingSettings = mongoose.models.ManufacturingSettings || mongoose.model('ManufacturingSettings', manufacturingSettingsSchema, 'manufacturing_settings');
