import mongoose, { Schema } from 'mongoose';
import { generateId } from '../utils.js';

const bomColumnMappingSchema = new Schema({
	_id: { type: String, default: () => generateId() },
	columnMappings: Schema.Types.Mixed, headerRow: Number, sheetName: String
}, { timestamps: true });

export const BomColumnMapping = mongoose.models.BomColumnMapping || mongoose.model('BomColumnMapping', bomColumnMappingSchema, 'bom_column_mapping');
