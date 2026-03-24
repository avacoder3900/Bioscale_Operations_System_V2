import mongoose, { Schema } from 'mongoose';
import { generateId } from '../utils.js';

const generatedBarcodeSchema = new Schema({
	_id: { type: String, default: () => generateId() },
	prefix: String, sequence: Number, barcode: String, type: String,
	createdAt: { type: Date, default: Date.now }
}, { timestamps: false });

generatedBarcodeSchema.index({ barcode: 1 }, { unique: true });

export const GeneratedBarcode = mongoose.models.GeneratedBarcode || mongoose.model('GeneratedBarcode', generatedBarcodeSchema, 'generated_barcodes');
