import mongoose, { Schema } from 'mongoose';

const BarcodeSheetBatchSchema = new Schema({
	_id: { type: String, required: true },
	sheetsUsed: { type: Number, required: true },
	labelsPerSheet: { type: Number, default: 30 },
	totalLabels: { type: Number, required: true },
	barcodeIds: [{ type: String }],
	firstBarcodeId: { type: String },
	lastBarcodeId: { type: String },
	printedAt: { type: Date, required: true },
	printedBy: {
		_id: { type: String },
		username: { type: String }
	},
	printerName: { type: String },
	templateVersion: { type: String },
	sheetsRemainingBefore: { type: Number },
	sheetsRemainingAfter: { type: Number },
	notes: { type: String },
	status: {
		type: String,
		enum: ['printed', 'partially_used', 'fully_consumed'],
		default: 'printed'
	},
	labelsUsed: { type: Number, default: 0 }
}, {
	timestamps: true,
	collection: 'barcode_sheet_batches'
});

export const BarcodeSheetBatch = mongoose.models.BarcodeSheetBatch
	|| mongoose.model('BarcodeSheetBatch', BarcodeSheetBatchSchema);
