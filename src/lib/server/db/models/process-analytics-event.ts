import mongoose, { Schema } from 'mongoose';
import { generateId } from '../utils.js';

/**
 * Manual / semi-automated observations that aren't covered by the automated
 * run documents. Deviations, environmental notes, MSA measurements, CAPA
 * entries, training events, etc. Surface in the same analytics views as the
 * auto-captured data.
 */
const processAnalyticsEventSchema = new Schema({
	_id: { type: String, default: () => generateId() },
	eventType: {
		type: String,
		enum: ['deviation', 'observation', 'environmental', 'msa_measurement',
			'corrective_action', 'preventive_action', 'training', 'calibration',
			'maintenance', 'visual_defect', 'rework', 'other'],
		required: true,
		index: true
	},
	processType: {
		type: String,
		enum: ['wi-01', 'laser-cut', 'cut-thermoseal', 'cut-top-seal', 'wax',
			'reagent', 'top-seal', 'qa-qc', 'storage', 'shipping', 'general'],
		required: true,
		index: true
	},
	occurredAt: { type: Date, required: true, index: true },
	operator: { _id: String, username: String },
	// Optional links to the record this event is about
	linkedRunId: String, // WaxFillingRun._id, ReagentBatchRecord._id, LotRecord._id, etc.
	linkedLotId: String, // Input material lot (ReceivingLot) or BackingLot._id
	linkedEquipmentId: String, // Robot, oven, deck, tray, printer, etc.
	linkedCartridgeIds: [String], // Specific cartridges this relates to
	// Measurement payload (optional — mostly for MSA / visual grading / environmental)
	numericValue: Number,
	numericUnit: String,
	categoricalValue: String,
	// Rejection-reason tagging — ties manual events into the Pareto chart
	rejectionReasonCode: String,
	severity: { type: String, enum: ['minor', 'major', 'critical', null], default: null },
	notes: { type: String, required: true },
	attachments: [{
		_id: false,
		label: String,
		url: String, // R2 URL
		contentType: String,
		uploadedAt: Date
	}],
	// Who authored / last touched
	createdBy: { _id: String, username: String },
	updatedBy: { _id: String, username: String }
}, { timestamps: true });

processAnalyticsEventSchema.index({ processType: 1, occurredAt: -1 });
processAnalyticsEventSchema.index({ eventType: 1, occurredAt: -1 });
processAnalyticsEventSchema.index({ 'operator._id': 1 });
processAnalyticsEventSchema.index({ linkedRunId: 1 });
processAnalyticsEventSchema.index({ rejectionReasonCode: 1 });

export const ProcessAnalyticsEvent = mongoose.models.ProcessAnalyticsEvent
	|| mongoose.model('ProcessAnalyticsEvent', processAnalyticsEventSchema, 'process_analytics_events');
