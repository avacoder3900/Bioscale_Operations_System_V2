import mongoose, { Schema } from 'mongoose';
import { generateId } from '../utils.js';

const schemaMetadataSchema = new Schema({
	_id: { type: String, default: () => generateId() },
	collectionName: String,
	tableName: String, // deprecated — kept for backward compat
	businessName: String, businessPurpose: String,
	businessDomain: String, keyRelationships: Schema.Types.Mixed,
	commonQueries: Schema.Types.Mixed, businessConcepts: String
}, { timestamps: true });

export const SchemaMetadata = mongoose.models.SchemaMetadata || mongoose.model('SchemaMetadata', schemaMetadataSchema, 'schema_metadata');
