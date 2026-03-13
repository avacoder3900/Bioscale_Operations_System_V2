import mongoose, { Schema } from 'mongoose';
import { generateId } from '../utils.js';

const workInstructionSchema = new Schema({
	_id: { type: String, default: () => generateId() },
	documentNumber: String, title: String, description: String,
	documentType: String,
	status: { type: String, enum: ['draft', 'active', 'retired'] },
	currentVersion: Number,
	originalFileName: String, fileSize: Number, mimeType: String,
	revision: String, category: String, effectiveDate: Date, fileId: String,
	preparedBy: String, preparedAt: Date, reviewedBy: String, reviewedAt: Date,
	approvedBy: String, approvedAt: Date,
	versions: [{
		_id: { type: String, default: () => generateId() },
		version: Number, content: String, rawContent: String,
		changeNotes: String, parsedAt: Date, parsedBy: String, createdAt: Date,
		steps: [{
			_id: { type: String, default: () => generateId() },
			stepNumber: Number, title: String, content: String,
			imageData: String, imageContentType: String,
			requiresScan: Boolean, scanPrompt: String, notes: String,
			partDefinitionId: String, partQuantity: { type: Number, default: 1 },
			partRequirements: [{
				_id: { type: String, default: () => generateId() },
				partNumber: String, partDefinitionId: String, quantity: Number, notes: String
			}],
			toolRequirements: [{
				_id: { type: String, default: () => generateId() },
				toolNumber: String, toolName: String, calibrationRequired: Boolean, notes: String
			}],
			fieldDefinitions: [{
				_id: { type: String, default: () => generateId() },
				fieldName: String, fieldLabel: String,
				fieldType: { type: String, enum: ['barcode_scan', 'manual_entry', 'date_picker', 'dropdown'] },
				isRequired: Boolean, validationPattern: String, options: Schema.Types.Mixed,
				barcodeFieldMapping: String, sortOrder: Number
			}]
		}]
	}],
	createdBy: String
}, { timestamps: true });

export const WorkInstruction = mongoose.models.WorkInstruction || mongoose.model('WorkInstruction', workInstructionSchema, 'work_instructions');
