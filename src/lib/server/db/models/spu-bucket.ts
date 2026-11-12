import mongoose, { Schema } from 'mongoose';
import { generateId } from '../utils.js';

// SpuBucket — a physical bucket that carries one SPU's parts through assembly
// (SPU → SPU Assembly WI → Build SPUs). Each bucket wears a QR sticker; this
// registry ties that QR code to the number people call the bucket by
// ("Bucket 2"). Scanning a registered bucket opens — or starts — its SPU build.
//
// Not a ProductionBucket: those are the cartridge line's tubs, with their own
// state machine. New buckets are added from the Build SPUs page by scanning a
// QR code BIMS doesn't know yet; they take the next free number.

const addedBySchema = new Schema({
	name: { type: String, required: true },   // operator name, as entered or from their badge
	userId: { type: String, default: null },
	username: { type: String, default: null }
}, { _id: false });

const spuBucketSchema = new Schema({
	_id: { type: String, default: () => generateId() },
	number: { type: Number, required: true },  // "Bucket 3"
	qrCode: { type: String, required: true },  // as normalizeBucketCode() returns it: the sticker's UUID, lower case
	active: { type: Boolean, default: true },
	addedBy: { type: addedBySchema, default: null },
	addedAt: { type: Date, default: Date.now }
}, { timestamps: true });

spuBucketSchema.index({ number: 1 }, { unique: true });
spuBucketSchema.index({ qrCode: 1 }, { unique: true });

export const SpuBucket =
	mongoose.models.SpuBucket ||
	mongoose.model('SpuBucket', spuBucketSchema, 'spu_buckets');
