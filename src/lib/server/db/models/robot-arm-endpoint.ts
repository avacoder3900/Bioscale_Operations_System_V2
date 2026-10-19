import mongoose, { Schema } from 'mongoose';

// Alternate routes BIMS can use to reach the robot-arm Pi, keyed by route name.
// Today there is one row, _id 'tunnel': the Pi's current Cloudflare quick-tunnel
// URL. Quick-tunnel URLs change on every cloudflared restart, so the Pi
// re-registers here (POST /api/robot-arm/tunnel) on change and every few
// minutes as a heartbeat; registeredAt is that heartbeat. The Tailscale Funnel
// URL stays in ROBOT_ARM_BASE_URL and is the fallback route.
const robotArmEndpointSchema = new Schema(
	{
		_id: { type: String, required: true },
		url: { type: String, required: true },
		registeredAt: { type: Date, required: true },
		previousUrl: { type: String, default: null }
	},
	{ timestamps: true }
);

export const RobotArmEndpoint =
	mongoose.models.RobotArmEndpoint ||
	mongoose.model('RobotArmEndpoint', robotArmEndpointSchema, 'robot_arm_endpoints');
