import mongoose, { Schema } from 'mongoose';
import { generateId } from '../utils.js';

/**
 * Robot arm chute barcode scans (2026-11-16): one row per scan the arm Pi ran
 * after a trapdoor fire step with "Scan Barcode After" ticked (barcode.py on
 * the Pi posts them to /api/robot-arm/chute-scans).
 *
 * A failed scan (nothing read, or a code that is not a whole cartridge label)
 * raises a warning on the robot arm pages; it never stops a run. Close sets
 * dismissedAt for everyone. The OT-2's own scan stays the check that the
 * cartridge is in the slot.
 */
const operatorRef = new Schema({ _id: { type: String }, username: { type: String } }, { _id: false });

const robotArmChuteScanSchema = new Schema(
	{
		_id: { type: String, default: () => generateId() },
		/** When the Pi finished the scan. */
		at: { type: Date, required: true },
		/** A whole cartridge label was read (ok + label on the Pi). */
		ok: { type: Boolean, required: true },
		/** What the scanner returned, whole label or not; null when nothing was read. */
		code: { type: String, default: null },
		/** The code is a whole cartridge label (isCartBarcode). */
		label: { type: Boolean, default: false },
		error: { type: String, default: null },
		elapsedMs: { type: Number, default: null },
		/** The step's Scan Delay (ms): the wait after the pulse before the scanner was triggered. */
		delayMs: { type: Number, default: null },
		solenoid: { type: String, default: null },
		pin: { type: Number, default: null },
		/** The Pi's run id (replay or fires- run) and the play's title, when known. */
		runId: { type: String, default: null },
		title: { type: String, default: null },
		host: { type: String, default: null },
		/** The Pi's own id for the scan, so a re-sent row is not stored twice. */
		piScanId: { type: String, default: null },
		/** The scanner was unplugged and the Pi skipped the scan: kept for the log, never a warning. */
		scannerMissing: { type: Boolean, default: false },
		dismissedAt: { type: Date, default: null },
		dismissedBy: { type: operatorRef, default: null }
	},
	{ timestamps: false, minimize: false, collection: 'robot_arm_chute_scans' }
);

robotArmChuteScanSchema.index({ at: -1 });
robotArmChuteScanSchema.index({ piScanId: 1 }, { unique: true, partialFilterExpression: { piScanId: { $type: 'string' } } });

export const RobotArmChuteScan =
	mongoose.models.RobotArmChuteScan || mongoose.model('RobotArmChuteScan', robotArmChuteScanSchema, 'robot_arm_chute_scans');
