import mongoose, { Schema } from 'mongoose';
import { generateId } from '../utils.js';

const inspectionProcedureRevisionSchema = new Schema({
	_id: { type: String, default: () => generateId() },
	partId: { type: String, required: true }, // PartDefinition._id
	revisionNumber: { type: Number, required: true },
	documentUrl: { type: String, required: true }, // URL to original .docx
	renderedHtmlUrl: String, // URL to converted HTML
	formDefinition: Schema.Types.Mixed, // IP form JSON { tools[], steps[], references[] }
	uploadedBy: { _id: String, username: String },
	changeNotes: String,
	isCurrent: { type: Boolean, default: true }
}, { timestamps: true });

inspectionProcedureRevisionSchema.index({ partId: 1 });
inspectionProcedureRevisionSchema.index({ partId: 1, isCurrent: 1 });

export const InspectionProcedureRevision = mongoose.models.InspectionProcedureRevision
	|| mongoose.model('InspectionProcedureRevision', inspectionProcedureRevisionSchema, 'inspection_procedure_revisions');
