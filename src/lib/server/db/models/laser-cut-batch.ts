import mongoose, { Schema } from 'mongoose';
import { generateId } from '../utils.js';

const laserCutBatchSchema = new Schema({
	_id: { type: String, default: () => generateId() },
	inputSheetCount: Number, outputSheetCount: Number,
	failureCount: Number, failureNotes: String,
	cuttingProgramLink: String, referencePhotos: Schema.Types.Mixed,
	toolsUsed: String, operatorId: String,
	// FIX-01: Link to part catalog for upstream/downstream traceability
	inputPartId: String,     // PartDefinition._id for acrylic sheets consumed
	outputPartId: String,    // PartDefinition._id for cut substrates produced
	inputPartName: String,   // denormalized
	outputPartName: String,  // denormalized
	outputCartridgeSubstrateCount: Number // usable substrates produced this batch
}, { timestamps: true });

export const LaserCutBatch = mongoose.models.LaserCutBatch || mongoose.model('LaserCutBatch', laserCutBatchSchema, 'laser_cut_batches');
