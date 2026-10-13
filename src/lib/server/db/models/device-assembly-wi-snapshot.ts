import mongoose, { Schema } from 'mongoose';
import { generateId } from '../utils.js';

// Full content snapshot of the SPU Assembly Work Instruction at a given version.
// One document per version, written by mutateDeviceAssemblyWI(), so any
// revision can be restored ("undo the last change", "go back to v7") without
// bloating the WI document itself.

const deviceAssemblyWISnapshotSchema = new Schema({
	_id: { type: String, default: () => generateId() },
	wiId: { type: String, required: true },
	version: { type: Number, required: true },
	label: { type: String, default: '' },
	title: { type: String, default: '' },
	documentNumber: { type: String, default: '' },
	assemblyNumber: { type: String, default: '' },
	status: { type: String, default: '' },
	frontMatter: { type: Schema.Types.Mixed, default: null },
	sections: { type: Schema.Types.Mixed, default: [] },
	takenAt: { type: Date, default: Date.now }
}, { timestamps: false });

deviceAssemblyWISnapshotSchema.index({ wiId: 1, version: 1 }, { unique: true });

export const DeviceAssemblyWISnapshot =
	mongoose.models.DeviceAssemblyWISnapshot ||
	mongoose.model('DeviceAssemblyWISnapshot', deviceAssemblyWISnapshotSchema, 'device_assembly_wi_snapshots');
