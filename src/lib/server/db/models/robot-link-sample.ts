import mongoose, { Schema } from 'mongoose';
import { generateId } from '../utils.js';

/**
 * One connectivity sample for one robot line (OT2-LOG-1 §3).
 *
 * Two writers:
 *  - source 'daemon': the heartbeat route (POST /api/agent/scanner/event)
 *    samples `metadata.link` from the on-robot daemon at most once a minute
 *    per device (the heartbeat itself is 10 s and stays ONE overwritten doc).
 *  - source 'imac': the lab iMac link monitor posts ICMP loss / RTT / /health
 *    latency per path (wifi, wired, tailnet) through
 *    POST /api/agent/robot-link/samples.
 *
 * Flight recorder, not a system of record: 50-day TTL on `at`, rolled up
 * nightly into robot_link_daily (permanent) by /api/cron/robot-link-daily.
 */
const ifaceSchema = new Schema(
	{
		default: String, // 'eth0' | 'wlan0' | null — the default-route interface
		eth0: { type: new Schema({ carrier: Boolean, ip: String }, { _id: false }), default: undefined },
		wlan0: { type: new Schema({ ip: String, rssi: Number, freq: Number }, { _id: false }), default: undefined }
	},
	{ _id: false }
);

const tailscaleSchema = new Schema(
	{
		direct: Boolean,       // false = traffic is going through a DERP relay
		relay: String,         // relay region name when not direct
		curAddr: String,       // current peer endpoint
		handshakeAgeS: Number  // seconds since the last WireGuard handshake
	},
	{ _id: false }
);

const bimsSchema = new Schema(
	{
		pollRttMs: Number,        // last long-poll round trip as seen by the daemon
		pollErrors: Number,       // poll failures since the previous heartbeat
		hbErrors: Number,         // heartbeat post failures since the previous heartbeat
		hbAgeAtReceiptMs: Number  // BIMS-side: now − previous heartbeat receivedAt
	},
	{ _id: false }
);

const workerSchema = new Schema({ busyAgeS: Number, queueDepth: Number }, { _id: false });

const daemonSchema = new Schema(
	{ version: String, sha256: String, uptimeS: Number, journalBacklog: Number },
	{ _id: false }
);

const serverSchema = new Schema({ healthOk: Boolean, engineOk: Boolean }, { _id: false });

const pathSchema = new Schema(
	{
		name: { type: String, enum: ['wifi', 'wired', 'tailnet'], required: true },
		ip: String,
		lossPct: Number,   // ICMP loss 0..100, null when the probe did not run
		rttMs: Number,     // average ICMP RTT
		healthMs: Number,  // GET /health latency, null on error
		healthErr: String  // error class when /health failed
	},
	{ _id: false }
);

const robotLinkSampleSchema = new Schema(
	{
		_id: { type: String, default: () => generateId() },
		robotId: String,  // OpentronsRobot._id; null when the deviceId maps to no robot
		deviceId: String, // ot2-<slot>-bridge
		at: { type: Date, required: true },
		source: { type: String, enum: ['daemon', 'imac'], required: true },
		iface: { type: ifaceSchema, default: undefined },
		tailscale: { type: tailscaleSchema, default: undefined },
		bims: { type: bimsSchema, default: undefined },
		worker: { type: workerSchema, default: undefined },
		daemon: { type: daemonSchema, default: undefined },
		server: { type: serverSchema, default: undefined },
		paths: { type: [pathSchema], default: undefined }
	},
	{ timestamps: false }
);

robotLinkSampleSchema.index({ robotId: 1, at: -1 });
robotLinkSampleSchema.index({ source: 1, at: -1 });
// The heartbeat sampling rule ("last sample for this device ≥ 55 s old") is one
// findOne per heartbeat; it needs the device key, not the (possibly null) robot.
robotLinkSampleSchema.index({ deviceId: 1, at: -1 });
// 50-day retention (OT2-LOG-1 decision). Remember: indexes are created by
// scripts/ensure-indexes.ts --apply, not on boot.
robotLinkSampleSchema.index({ at: 1 }, { expireAfterSeconds: 50 * 24 * 3600 });

export const RobotLinkSample = mongoose.models.RobotLinkSample
	|| mongoose.model('RobotLinkSample', robotLinkSampleSchema, 'robot_link_samples');
