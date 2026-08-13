import mongoose, { Schema } from 'mongoose';

const BarcodeSheetBatchSchema = new Schema({
	_id: { type: String, required: true },
	sheetsUsed: { type: Number, required: true },
	labelsPerSheet: { type: Number, default: 30 },
	totalLabels: { type: Number, required: true },
	barcodeIds: [{ type: String }],
	firstBarcodeId: { type: String },
	lastBarcodeId: { type: String },
	// Set when the operator confirms "Add to inventory". Null while the batch
	// is still a `reserved` preview — not every reservation gets printed.
	printedAt: { type: Date },
	printedBy: {
		_id: { type: String },
		username: { type: String }
	},
	// Reservation window. A batch is minted (status 'reserved') at preview
	// time and may only be claimed into 'printed' before expiresAt. This is
	// what stops a stale browser tab from re-printing an already-committed
	// sheet: the UUIDs stay burned forever, but the batch can never be
	// confirmed a second time or after the window closes.
	mintedAt: { type: Date },
	expiresAt: { type: Date },
	printerName: { type: String },
	templateVersion: { type: String },
	sheetsRemainingBefore: { type: Number },
	sheetsRemainingAfter: { type: Number },
	notes: { type: String },
	status: {
		type: String,
		enum: ['reserved', 'expired', 'printed', 'partially_used', 'fully_consumed'],
		default: 'printed'
	},
	labelsUsed: { type: Number, default: 0 }
}, {
	timestamps: true,
	collection: 'barcode_sheet_batches'
});

// Supports the atomic reserved -> printed claim in ?/addToInventory and the
// lazy expiry sweep in the print-barcodes load function.
BarcodeSheetBatchSchema.index({ status: 1, expiresAt: 1 });

export const BarcodeSheetBatch = mongoose.models.BarcodeSheetBatch
	|| mongoose.model('BarcodeSheetBatch', BarcodeSheetBatchSchema);
