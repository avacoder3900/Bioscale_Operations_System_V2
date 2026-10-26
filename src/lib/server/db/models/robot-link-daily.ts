import mongoose, { Schema } from 'mongoose';
import { generateId } from '../utils.js';

/**
 * One robot, one UTC day of connectivity, rolled up from robot_link_samples,
 * ot2_direct_calls and audit_log by /api/cron/robot-link-daily (OT2-LOG-1 §3,
 * L5). Permanent — the samples it summarises expire after 50 days.
 * Upserted by `{robotId, day}`; re-running the cron for a day overwrites the
 * numbers, so a late replay from a daemon journal is picked up by a re-run.
 * The math lives in $lib/server/services/robot-link/rollup.ts.
 */
const pathStatsSchema = new Schema(
	{ n: Number, lossAvg: Number, lossMax: Number, rttAvg: Number },
	{ _id: false }
);

const robotLinkDailySchema = new Schema(
	{
		_id: { type: String, default: () => generateId() },
		robotId: { type: String, required: true },
		day: { type: String, required: true }, // 'YYYY-MM-DD' (UTC)
		samples: Number,                       // all sources
		hbGaps: { type: new Schema({ count: Number, maxS: Number }, { _id: false }), default: undefined },
		pollRtt: { type: new Schema({ avg: Number, p95: Number }, { _id: false }), default: undefined },
		relayMin: Number,                      // minutes the daemon saw tailscale.direct === false
		paths: {
			type: new Schema(
				{
					wifi: { type: pathStatsSchema, default: undefined },
					wired: { type: pathStatsSchema, default: undefined },
					tailnet: { type: pathStatsSchema, default: undefined }
				},
				{ _id: false }
			),
			default: undefined
		},
		// { count, errors, p95LatencyMs, byLine: { tailnet, queue } } — Mixed because
		// `errors` is a Mongoose-reserved path name inside a sub-schema; the shape is
		// fixed by DailyRollup in services/robot-link/rollup.ts and only the cron writes it.
		directCalls: Schema.Types.Mixed,
		firstProbeMisses: Number,
		resyncs: Number,          // audit_log run_start_auto_resync rows for the robot
		bridgeJobErrors: Number,  // audit_log bridge_job_result rows with ok:false for the device
		daemonVersions: { type: [String], default: undefined },
		computedAt: Date
	},
	{ timestamps: false }
);

robotLinkDailySchema.index({ robotId: 1, day: 1 }, { unique: true });

export const RobotLinkDaily = mongoose.models.RobotLinkDaily
	|| mongoose.model('RobotLinkDaily', robotLinkDailySchema, 'robot_link_daily');
