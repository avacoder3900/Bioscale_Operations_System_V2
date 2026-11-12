import mongoose, { Schema } from 'mongoose';
import { generateId } from '../utils.js';

// SpuBuild — one SPU being assembled against the SPU Assembly WI, carried in
// its own physical bucket (SPU → SPU Assembly WI → Build SPUs). Several builds
// run at once: the operator scans a bucket to switch between them, and every
// part scanned is deducted against the build whose bucket was scanned last.
//
// Progress is keyed by WI step _id / material _id (see $lib/spu-build/progress),
// so WI edits made mid-build don't lose work. The bucket is a registered
// SpuBucket (QR sticker → "Bucket N"), not a ProductionBucket: those are the
// cartridge line's tubs with their own state machine. A bucket is reusable once its build is
// complete or cancelled — only one IN-PROGRESS build may hold a given bucket.
// Mistakes are corrected, never erased: an undone scan stays on the build with
// its reason, and every correction is appended to `corrections`.
//
// Stock movement is NOT stored here: each deducted scan goes through
// pullMaterialsForStep() → InventoryTransaction + DeviceAssemblyMaterialPull,
// and the scan row keeps both ids.

const operatorSchema = new Schema({
	name: { type: String, required: true },  // who is building, as entered or from their badge
	userId: { type: String, default: null },  // account the work is attributed to
	username: { type: String, default: null },
	badgeCode: { type: String, default: null } // set when they identified by badge
}, { _id: false });

const completedStepSchema = new Schema({
	stepId: { type: String, required: true },
	sectionNumber: { type: Number, default: null },
	stepNumber: { type: Number, default: null },
	how: { type: String, enum: ['scan', 'manual', 'section'], required: true }, // 'section' = the operator confirmed the whole section (scan/manual: older builds)
	operator: { type: operatorSchema, required: true },
	completedAt: { type: Date, default: Date.now }
}, { _id: false });

const scanSchema = new Schema({
	_id: { type: String, default: () => generateId() },
	// 'pending' = slot claimed, deduction in flight; 'recorded' = done;
	// 'undoing' = stock being returned; 'undone' = reversed (kept as history,
	// no longer fills its slot, so the part can be scanned again).
	status: { type: String, enum: ['pending', 'recorded', 'undoing', 'undone'], default: 'pending' },
	stepId: { type: String, required: true },
	sectionNumber: { type: Number, default: null },
	stepNumber: { type: Number, default: null },
	materialId: { type: String, required: true },
	partDefinitionId: { type: String, default: null },
	partNumber: { type: String, default: null },
	name: { type: String, default: '' },
	quantity: { type: Number, default: 1 },
	unit: { type: String, default: 'ea' },
	deducted: { type: Boolean, default: false },  // false: not in catalog / opted out of deduction
	scannedCode: { type: String, default: null }, // raw value from the scanner
	receivingLotId: { type: String, default: null },
	lotLabel: { type: String, default: null },    // lotNumber / bag barcode shown to people
	inventoryTransactionId: { type: String, default: null },
	materialPullId: { type: String, default: null },
	previousQuantity: { type: Number, default: null },
	newQuantity: { type: Number, default: null },
	operator: { type: operatorSchema, required: true },
	scannedAt: { type: Date, default: Date.now },
	// Undo: the stock goes back through a new reversing InventoryTransaction
	// (the original is immutable) plus a reversing DeviceAssemblyMaterialPull.
	undoneAt: { type: Date, default: null },
	undoneBy: { type: operatorSchema, default: null },
	undoReason: { type: String, default: null },
	reversalTransactionId: { type: String, default: null },
	reversalPullId: { type: String, default: null },
	returnedQuantity: { type: Number, default: null } // stock count after the return
}, { _id: false });

// Every correction made to a build, oldest first: what, why, who.
const correctionSchema = new Schema({
	_id: { type: String, default: () => generateId() },
	kind: { type: String, enum: ['undo_scan', 'reopen_step', 'reopen_section', 'reopen_build', 'cancel_build'], required: true },
	scanId: { type: String, default: null },
	stepId: { type: String, default: null },
	sectionNumber: { type: Number, default: null },
	stepNumber: { type: Number, default: null },
	summary: { type: String, required: true },
	reason: { type: String, required: true },
	operator: { type: operatorSchema, required: true },
	at: { type: Date, default: Date.now }
}, { _id: false });

const spuBuildSchema = new Schema({
	_id: { type: String, default: () => generateId() },
	buildNumber: { type: Number, required: true },  // "SPU 7" on the board
	bucketCode: { type: String, required: true },   // the bucket's QR code (SpuBucket.qrCode)
	bucketId: { type: String, default: null },      // SpuBucket._id
	bucketNumber: { type: Number, default: null },  // "Bucket 2", copied from the SpuBucket at start
	// 'cancelled' frees the bucket; a completed build reopens to in_progress when a step is undone.
	status: { type: String, enum: ['in_progress', 'completed', 'cancelled'], default: 'in_progress' },
	wiId: { type: String, default: null },
	wiDocumentNumber: { type: String, default: null },
	wiVersionAtStart: { type: Number, default: null },
	startedBy: { type: operatorSchema, required: true },
	startedAt: { type: Date, default: Date.now },
	lastActivityAt: { type: Date, default: null },
	lastActivityBy: { type: String, default: null },
	completedAt: { type: Date, default: null },
	cancelledAt: { type: Date, default: null },
	cancelledBy: { type: operatorSchema, default: null },
	cancelReason: { type: String, default: null },
	partsReturnedOnCancel: { type: Boolean, default: null },
	completedSteps: { type: [completedStepSchema], default: [] },
	scans: { type: [scanSchema], default: [] },
	corrections: { type: [correctionSchema], default: [] },
	spuId: { type: String, default: null }          // link to the Spu record once one exists
}, { timestamps: true });

spuBuildSchema.index({ buildNumber: 1 }, { unique: true });
spuBuildSchema.index({ bucketCode: 1 }, { unique: true, partialFilterExpression: { status: 'in_progress' } });
spuBuildSchema.index({ status: 1, completedAt: -1 });
spuBuildSchema.index({ status: 1, cancelledAt: -1 });

export const SpuBuild =
	mongoose.models.SpuBuild ||
	mongoose.model('SpuBuild', spuBuildSchema, 'spu_builds');
