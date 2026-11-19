import mongoose, { Schema } from 'mongoose';
import { generateId } from '../utils.js';

/**
 * CALIB-5: where THIS robot's copy of a shared rack physically sits.
 *
 * `labware_definitions` holds one document per load name, shared by every
 * robot. That is right for a cartridge deck (each deck has its own definition)
 * and wrong for the tip rack (slot 11) and tube rack (slot 10): the same part
 * sits a millimetre or two differently on B07, R04 and B14. Editing the shared
 * definition for one robot moved every robot (2026-10-26: +2/+5 on the 20 µL
 * rack taught for R04 reached B07 by run_start_auto_resync and broke B07's
 * pick-ups). This row is the per-robot vector that is ADDED to the shared
 * definition — as `tiprack_offset_*` / `tuberack_offset_*` run-time parameters
 * (→ `Labware.set_offset`) in a fill, and as a maintenance-run labware offset in
 * the Deck Calibration Studio — so both frames move the same way.
 *
 * Keyed by robot × definition URI × slot. The definition URI
 * (namespace/loadName/version) is what Opentrons keys offsets on, so a
 * re-versioned definition starts from a clean (zero) offset on purpose.
 */
const vec = new Schema(
	{ x: { type: Number, default: 0 }, y: { type: Number, default: 0 }, z: { type: Number, default: 0 } },
	{ _id: false }
);

const operatorRef = new Schema({ _id: { type: String }, username: { type: String } }, { _id: false });

/** The vector this one replaced. Newest-first, capped at 10 by the writing service. */
const offsetHistoryEntry = new Schema(
	{
		vector: { type: vec, default: () => ({ x: 0, y: 0, z: 0 }) },
		taughtBy: { type: operatorRef },
		taughtAt: { type: Date, default: Date.now },
		source: { type: String, enum: ['studio', 'migration', 'manual', 'revert', 'lpc'], default: 'studio' },
		note: { type: String, default: null }
	},
	{ _id: false }
);

const robotLabwareOffsetSchema = new Schema({
	_id: { type: String, default: () => generateId() },
	robotId: { type: String, required: true, index: true },
	/** Human-facing load name, e.g. 'cosmasanddamian_96_tiprack_20ul'. */
	loadName: { type: String, required: true },
	/** namespace/loadName/version — the identity Opentrons keys offsets on. */
	definitionUri: { type: String, required: true },
	/** OT-2 slot the labware is loaded in: '10' / '11' for the Studio's racks; any slot for a Labware Position Check row (source 'lpc', DILUENT-FILL-1 S5). */
	slotName: { type: String, required: true },
	vector: { type: vec, required: true },
	taughtBy: { type: operatorRef },
	taughtAt: { type: Date, default: Date.now },
	source: { type: String, enum: ['studio', 'migration', 'manual', 'revert', 'lpc'], default: 'studio' },
	note: { type: String, default: null },
	history: { type: [offsetHistoryEntry], default: [] }
});

robotLabwareOffsetSchema.index({ robotId: 1, definitionUri: 1, slotName: 1 }, { unique: true });

export const RobotLabwareOffset =
	mongoose.models.RobotLabwareOffset ||
	mongoose.model('RobotLabwareOffset', robotLabwareOffsetSchema, 'robot_labware_offsets');

/**
 * The ROBOT-ARM line's copy of the same per-robot rack offsets (2026-11-19).
 *
 * The arm line runs the stage protocol (Wax_Filling_GEN7_ArmStage*.py) on the same
 * OT-2 that also runs the normal carriage fill, but its tube rack (slot 10) and
 * tip rack (slot 11) are taught separately: teaching B07's tube rack for the arm
 * moved B07's normal wax fill too, and the reverse. Same shape, same key
 * (robot × definition URI × slot), its own collection, so neither line's unique
 * index or rows are touched by the other. Read by rack-offsets.ts with line 'arm'.
 */
const armLineLabwareOffsetSchema = robotLabwareOffsetSchema.clone();

export const ArmLineLabwareOffset =
	mongoose.models.ArmLineLabwareOffset ||
	mongoose.model('ArmLineLabwareOffset', armLineLabwareOffsetSchema, 'arm_line_labware_offsets');
