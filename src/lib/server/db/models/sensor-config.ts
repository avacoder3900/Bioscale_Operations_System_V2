import mongoose, { Schema } from 'mongoose';

const sensorConfigSchema = new Schema({
	_id: { type: String },  // sensorId (thingName)
	sensorName: String,
	temperatureMinC: { type: Number, default: null },
	temperatureMaxC: { type: Number, default: null },
	alertsEnabled: { type: Boolean, default: true },
	emailRecipients: [String],
	mappedEquipmentId: { type: String, default: null },
	updatedAt: { type: Date, default: () => new Date() }
});

export const SensorConfig = mongoose.models.SensorConfig
	|| mongoose.model('SensorConfig', sensorConfigSchema, 'sensor_configs');
