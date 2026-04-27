import mongoose, { Schema } from 'mongoose';
import { generateId } from '../utils.js';

const temperatureAlertSchema = new Schema({
	_id: { type: String, default: () => generateId() },
	sensorId: { type: String, required: true, index: true },
	sensorName: String,
	alertType: { type: String, required: true, enum: ['high_temp', 'low_temp', 'lost_connection', 'gateway_outage'] },
	threshold: Number,        // configured threshold that was breached
	actualValue: Number,      // the actual reading (null for lost_connection / gateway_outage)
	equipmentId: String,
	equipmentName: String,
	// gateway_outage: list of sensorIds that all went silent in the same sync.
	// lost_connection rows fired in the same window are tagged gatewayEvent: true
	// so the UI can group them under the umbrella event.
	gatewayEvent: { type: Boolean, default: false },
	affectedSensorIds: [String],
	acknowledged: { type: Boolean, default: false },
	acknowledgedBy: { _id: String, username: String },
	acknowledgedAt: Date,
	timestamp: { type: Date, required: true },
	createdAt: { type: Date, default: () => new Date() }
});

temperatureAlertSchema.index({ acknowledged: 1, timestamp: -1 });
temperatureAlertSchema.index({ sensorId: 1, alertType: 1, acknowledged: 1 });

export const TemperatureAlert = mongoose.models.TemperatureAlert
	|| mongoose.model('TemperatureAlert', temperatureAlertSchema, 'temperature_alerts');
