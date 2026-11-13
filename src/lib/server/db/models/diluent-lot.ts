import mongoose, { Schema } from 'mongoose';
import { generateId } from '../utils.js';

/**
 * DiluentLot — what a finished diluent fill leaves behind (DILUENT-FILL-1):
 * the tubes, the volume in each, and the reagent lot(s) they came from.
 * Lot numbers follow the fill-lot rule: DL-YYYYMMDD-NNN, NNN per day.
 */
const diluentLotSchema = new Schema({
	_id: { type: String, default: () => generateId() },
	lotNumber: { type: String, required: true },
	runId: String,
	robot: { _id: String, name: String },
	operator: { _id: String, username: String },
	pipette: String,
	volumeUl: Number,
	sources: [{
		_id: false,
		well: String,
		reagentLotId: String,
		reagentLotBarcode: String,
		templateName: String,
		tubes: Number
	}],
	tubesTotal: Number,
	status: { type: String, enum: ['active', 'retired'], default: 'active' },
	labelsPrintedAt: Date,
	notes: String
}, { timestamps: true });

diluentLotSchema.index({ lotNumber: 1 }, { unique: true });
diluentLotSchema.index({ createdAt: -1 });

export const DiluentLot = mongoose.models.DiluentLot || mongoose.model('DiluentLot', diluentLotSchema, 'diluent_lots');

const day = (d: Date) => {
	const y = d.getUTCFullYear();
	const m = String(d.getUTCMonth() + 1).padStart(2, '0');
	const dd = String(d.getUTCDate()).padStart(2, '0');
	return `${y}${m}${dd}`;
};

/** DL-YYYYMMDD-NNN — next free number for today (UTC day, like fill lots). */
export async function nextDiluentLotNumber(now: Date = new Date()): Promise<string> {
	const prefix = `DL-${day(now)}-`;
	const todays = await DiluentLot.countDocuments({ lotNumber: { $regex: `^${prefix}` } });
	return `${prefix}${String(todays + 1).padStart(3, '0')}`;
}
