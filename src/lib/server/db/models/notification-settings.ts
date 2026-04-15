import mongoose, { Schema } from 'mongoose';

/**
 * NotificationSettings — singleton doc (_id = 'default') controlling which
 * team members receive which notification types and configurable thresholds.
 *
 * Each `recipients` field is an array of User._id values. When an event
 * fires, we fetch those users' emails and send via Resend.
 */
const notificationSettingsSchema = new Schema({
	_id: { type: String, default: 'default' },

	// Recipient lists — arrays of User._id
	temperatureAlerts: { type: [String], default: [] },
	lowWaxBatch: { type: [String], default: [] },
	lowInventory: { type: [String], default: [] },
	runComplete: { type: [String], default: [] },
	runAborted: { type: [String], default: [] },
	equipmentOffline: { type: [String], default: [] },
	dailyDigest: { type: [String], default: [] },
	adminEvents: { type: [String], default: [] },

	// Per-type on/off toggles (defaults enabled)
	enabled: {
		type: {
			temperatureAlerts: { type: Boolean, default: true },
			lowWaxBatch: { type: Boolean, default: true },
			lowInventory: { type: Boolean, default: true },
			runComplete: { type: Boolean, default: true },
			runAborted: { type: Boolean, default: true },
			equipmentOffline: { type: Boolean, default: true },
			dailyDigest: { type: Boolean, default: true },
			adminEvents: { type: Boolean, default: true }
		},
		_id: false,
		default: () => ({})
	},

	// Thresholds
	lowWaxBatchThresholdUl: { type: Number, default: 1600 }, // warn when batch remaining < 1600 μL (2 fills)
	lowInventoryPercentThreshold: { type: Number, default: 20 } // warn when inventoryCount < minimumOrderQty * 1.2
}, { timestamps: true });

export const NotificationSettings = mongoose.models.NotificationSettings
	|| mongoose.model('NotificationSettings', notificationSettingsSchema, 'notification_settings');
