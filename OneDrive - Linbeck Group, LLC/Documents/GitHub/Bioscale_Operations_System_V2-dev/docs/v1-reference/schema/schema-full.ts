import {
	pgTable,
	text,
	timestamp,
	jsonb,
	boolean,
	integer,
	bigint,
	uuid,
	numeric,
	varchar,
	real,
	customType
} from 'drizzle-orm/pg-core';

// Custom type for PostgreSQL BYTEA columns (used by firmware tables)
const bytea = customType<{ data: Buffer; driverData: Buffer }>({
	dataType() {
		return 'bytea';
	}
});

// ============================================================================
// AUTH & RBAC
// ============================================================================

export const user = pgTable('user', {
	id: text('id').primaryKey(),
	username: text('username').notNull().unique(),
	passwordHash: text('password_hash').notNull(),
	firstName: text('first_name'),
	lastName: text('last_name'),
	email: text('email').unique(),
	phone: text('phone'),
	isActive: boolean('is_active').notNull().default(true),
	lastLoginAt: timestamp('last_login_at', { withTimezone: true }),
	invitedBy: text('invited_by'), // FK to user.id — self-referential, no .references() to avoid circular
	createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
	updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow()
});

export const session = pgTable('session', {
	id: text('id').primaryKey(),
	userId: text('user_id')
		.notNull()
		.references(() => user.id),
	expiresAt: timestamp('expires_at', { withTimezone: true, mode: 'date' }).notNull()
});

export const role = pgTable('role', {
	id: text('id').primaryKey(),
	name: text('name').notNull().unique(),
	description: text('description'),
	createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow()
});

export const permission = pgTable('permission', {
	id: text('id').primaryKey(),
	name: text('name').notNull().unique(), // e.g., 'spu:read', 'project:write'
	description: text('description'),
	createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow()
});

export const userRole = pgTable('user_role', {
	id: text('id').primaryKey(),
	userId: text('user_id')
		.notNull()
		.references(() => user.id),
	roleId: text('role_id')
		.notNull()
		.references(() => role.id),
	assignedAt: timestamp('assigned_at', { withTimezone: true }).notNull().defaultNow(),
	assignedBy: text('assigned_by').references(() => user.id)
});

export const rolePermission = pgTable('role_permission', {
	id: text('id').primaryKey(),
	roleId: text('role_id')
		.notNull()
		.references(() => role.id),
	permissionId: text('permission_id')
		.notNull()
		.references(() => permission.id),
	createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow()
});

// Invite tokens for email-based user onboarding (PRD-CART-DASH)
export const inviteToken = pgTable('invite_token', {
	id: text('id').primaryKey(),
	email: text('email').notNull(),
	token: text('token').notNull().unique(), // 32-byte crypto-random hex
	roleId: text('role_id').references(() => role.id), // Pre-assigned role
	invitedBy: text('invited_by')
		.notNull()
		.references(() => user.id),
	status: text('status').notNull().default('pending'), // pending | accepted | expired | revoked
	expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
	acceptedAt: timestamp('accepted_at', { withTimezone: true }),
	createdUserId: text('created_user_id').references(() => user.id), // Set when accepted
	createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow()
});

// ============================================================================
// AUDIT LOG (matches existing Supabase table structure)
// ============================================================================

export const auditLog = pgTable('audit_log', {
	id: text('id').primaryKey().default('gen_random_uuid()'),
	tableName: text('table_name').notNull(),
	recordId: text('record_id').notNull(),
	action: text('action').notNull(), // 'INSERT', 'UPDATE', 'DELETE'
	oldData: jsonb('old_data'),
	newData: jsonb('new_data'),
	changedAt: timestamp('changed_at', { withTimezone: true }).notNull().$defaultFn(() => new Date()),
	changedBy: text('changed_by')
});

// ============================================================================
// CUSTOMERS & FLEET
// ============================================================================

export const customer = pgTable('customer', {
	id: text('id').primaryKey(),
	name: text('name').notNull(),
	customerType: text('customer_type').notNull(), // 'b2b' | 'b2c'
	contactName: text('contact_name'),
	contactEmail: text('contact_email'),
	contactPhone: text('contact_phone'),
	address: text('address'),
	notes: text('notes'),
	status: text('status').notNull().default('active'), // 'active' | 'inactive'
	customFields: jsonb('custom_fields'),
	createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
	updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow()
});

// Customer notes with timestamps and author tracking (PRD-CART-DASH)
export const customerNote = pgTable('customer_note', {
	id: text('id').primaryKey(),
	customerId: text('customer_id')
		.notNull()
		.references(() => customer.id),
	noteText: text('note_text').notNull(),
	createdBy: text('created_by')
		.notNull()
		.references(() => user.id),
	createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow()
});

// ============================================================================
// SPU TRACKING
// ============================================================================

export const batch = pgTable('batch', {
	id: text('id').primaryKey(),
	batchNumber: text('batch_number').notNull().unique(),
	description: text('description'),
	targetQuantity: integer('target_quantity'),
	startedAt: timestamp('started_at', { withTimezone: true }),
	completedAt: timestamp('completed_at', { withTimezone: true }),
	createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
	createdBy: text('created_by').references(() => user.id)
});

// Device state values: 'production' | 'development_a' | 'development_b' | 'assembly' | 'out_of_service'
export type SpuDeviceState =
	| 'production'
	| 'development_a'
	| 'development_b'
	| 'assembly'
	| 'out_of_service';

export const spu = pgTable('spu', {
	id: text('id').primaryKey(),
	udi: text('udi').notNull().unique(),
	status: text('status').notNull().default('draft'),
	// Device lifecycle state (separate from assembly workflow status)
	deviceState: text('device_state').notNull().default('assembly'),
	owner: text('owner'),
	ownerNotes: text('owner_notes'),
	batchId: text('batch_id').references(() => batch.id),
	assembledBy: text('assembled_by').references(() => user.id),
	assemblyStartedAt: timestamp('assembly_started_at', { withTimezone: true }),
	assemblyCompletedAt: timestamp('assembly_completed_at', { withTimezone: true }),
	assemblySignatureId: text('assembly_signature_id'),
	// Fleet & Assignment
	assignmentType: text('assignment_type'), // 'rnd' | 'manufacturing' | 'customer'
	assignmentCustomerId: text('assignment_customer_id').references(() => customer.id),
	// QC Tracking
	qcStatus: text('qc_status').notNull().default('pending'), // 'pending' | 'pass' | 'fail'
	qcDocumentUrl: text('qc_document_url'),
	// Assembly lifecycle (separate from legacy `status` field)
	assemblyStatus: text('assembly_status').notNull().default('created'), // 'created' | 'in_progress' | 'assembled' | 'tested' | 'released' | 'on_hold' | 'scrapped'
	createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
	createdBy: text('created_by').references(() => user.id),
	updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow()
});

export const particleLink = pgTable('particle_link', {
	id: text('id').primaryKey(),
	spuId: text('spu_id')
		.references(() => spu.id)
		.unique(),
	particleSerial: text('particle_serial').notNull().unique(),
	particleDeviceId: text('particle_device_id'),
	linkedAt: timestamp('linked_at', { withTimezone: true }).notNull().defaultNow(),
	linkedBy: text('linked_by').references(() => user.id),
	previousSpuId: text('previous_spu_id'),
	unlinkReason: text('unlink_reason')
});

export const partDefinition = pgTable('part_definition', {
	id: text('id').primaryKey(),
	partNumber: text('part_number').notNull().unique(),
	name: text('name').notNull(),
	description: text('description'),
	category: text('category'),
	// Sourcing fields (populated from BOM sync)
	supplier: text('supplier'),
	manufacturer: text('manufacturer'),
	vendorPartNumber: text('vendor_part_number'),
	unitCost: numeric('unit_cost', { precision: 12, scale: 4 }),
	unitOfMeasure: text('unit_of_measure'),
	leadTimeDays: integer('lead_time_days'),
	minimumOrderQty: integer('minimum_order_qty'),
	hazardClass: text('hazard_class'),
	certifications: jsonb('certifications'),
	expirationDate: timestamp('expiration_date', { withTimezone: true }),
	msdsFileId: uuid('msds_file_id').references(() => files.id),
	// Assembly & receiving config
	inspectionPathway: text('inspection_pathway').notNull().default('coc'), // 'coc' | 'ip'
	sampleSize: integer('sample_size').notNull().default(1),
	percentAccepted: real('percent_accepted').notNull().default(100), // 0-100
	scanRequired: boolean('scan_required').notNull().default(true),
	sortOrder: integer('sort_order').notNull().default(0),
	isActive: boolean('is_active').notNull().default(true),
	createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
	createdBy: text('created_by').references(() => user.id),
	updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow()
});

export const spuPart = pgTable('spu_part', {
	id: text('id').primaryKey(),
	spuId: text('spu_id')
		.notNull()
		.references(() => spu.id),
	partDefinitionId: text('part_definition_id')
		.notNull()
		.references(() => partDefinition.id),
	lotNumber: text('lot_number'),
	serialNumber: text('serial_number'),
	scannedAt: timestamp('scanned_at', { withTimezone: true }).notNull().defaultNow(),
	scannedBy: text('scanned_by').references(() => user.id),
	barcodeData: text('barcode_data'),
	isReplaced: boolean('is_replaced').notNull().default(false),
	replacedBy: text('replaced_by'),
	replaceReason: text('replace_reason')
});

export const assemblySession = pgTable('assembly_session', {
	id: text('id').primaryKey(),
	spuId: text('spu_id')
		.notNull()
		.references(() => spu.id),
	userId: text('user_id')
		.notNull()
		.references(() => user.id),
	status: text('status').notNull().default('in_progress'),
	currentStepIndex: integer('current_step_index').notNull().default(0),
	startedAt: timestamp('started_at', { withTimezone: true }).notNull().defaultNow(),
	pausedAt: timestamp('paused_at', { withTimezone: true }),
	completedAt: timestamp('completed_at', { withTimezone: true }),
	workstationId: text('workstation_id'),
	notes: text('notes')
});

export const electronicSignature = pgTable('electronic_signature', {
	id: text('id').primaryKey(),
	userId: text('user_id')
		.notNull()
		.references(() => user.id),
	entityType: text('entity_type').notNull(),
	entityId: text('entity_id').notNull(),
	meaning: text('meaning').notNull(),
	signedAt: timestamp('signed_at', { withTimezone: true }).notNull().defaultNow(),
	ipAddress: text('ip_address'),
	userAgent: text('user_agent'),
	dataHash: text('data_hash')
});

// ============================================================================
// DOCUMENTS & FILES
// ============================================================================

// Controlled documents with revision tracking (FDA 21 CFR Part 11 compliant)
export const document = pgTable('document', {
	id: text('id').primaryKey(),
	documentNumber: text('document_number').notNull().unique(),
	title: text('title').notNull(),
	category: text('category'), // SOP, work_instruction, form, specification, etc.
	currentRevision: text('current_revision').notNull().default('A'),
	status: text('status').notNull().default('draft'), // draft, pending_review, approved, effective, retired
	effectiveDate: timestamp('effective_date', { withTimezone: true }),
	retiredDate: timestamp('retired_date', { withTimezone: true }),
	ownerId: text('owner_id').references(() => user.id),
	createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
	createdBy: text('created_by').references(() => user.id),
	updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow()
});

// Document revisions for version history tracking
export const documentRevision = pgTable('document_revision', {
	id: text('id').primaryKey(),
	documentId: text('document_id')
		.notNull()
		.references(() => document.id),
	revision: text('revision').notNull(),
	content: text('content'),
	changeDescription: text('change_description'),
	status: text('status').notNull().default('draft'), // draft, pending_approval, approved, rejected
	createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
	createdBy: text('created_by').references(() => user.id),
	approvedAt: timestamp('approved_at', { withTimezone: true }),
	approvedBy: text('approved_by').references(() => user.id),
	approvalSignatureId: text('approval_signature_id').references(() => electronicSignature.id)
});

// Document training records for tracking user training on document revisions
export const documentTraining = pgTable('document_training', {
	id: text('id').primaryKey(),
	documentRevisionId: text('document_revision_id')
		.notNull()
		.references(() => documentRevision.id),
	userId: text('user_id')
		.notNull()
		.references(() => user.id),
	trainedAt: timestamp('trained_at', { withTimezone: true }).notNull().defaultNow(),
	trainerId: text('trainer_id').references(() => user.id),
	signatureId: text('signature_id').references(() => electronicSignature.id),
	notes: text('notes')
});

// File types: raw_data, image, document, spreadsheet, other
export const files = pgTable('files', {
	id: uuid('id').primaryKey().defaultRandom(),
	projectId: uuid('project_id'),
	datasetId: uuid('dataset_id'),
	filename: text('filename').notNull(),
	storagePath: text('storage_path').notNull(),
	mimeType: text('mime_type').notNull(),
	fileSize: bigint('file_size', { mode: 'number' }),
	checksum: text('checksum'),
	fileType: text('file_type').default('other'), // raw_data, image, document, spreadsheet, other
	description: text('description'),
	tags: jsonb('tags'),
	metadata: jsonb('metadata'),
	version: integer('version').notNull().default(1),
	isLatest: boolean('is_latest').default(true),
	previousVersionId: uuid('previous_version_id'),
	uploadedAt: timestamp('uploaded_at', { withTimezone: true }).notNull().defaultNow(),
	uploadedBy: text('uploaded_by'),
	deletedAt: timestamp('deleted_at', { withTimezone: true })
});

// Work instruction categories: assembly, testing, packaging, labeling, inspection
// Status: draft, released, obsolete
export const workInstructions = pgTable('work_instructions', {
	id: uuid('id').primaryKey().defaultRandom(),
	documentNumber: text('document_number').notNull(),
	title: text('title').notNull(),
	revision: text('revision').notNull().default('A'),
	status: text('status').notNull().default('draft'), // draft, released, obsolete
	category: text('category'), // assembly, testing, packaging, labeling, inspection
	effectiveDate: timestamp('effective_date', { withTimezone: true }),
	fileId: uuid('file_id'),
	preparedBy: text('prepared_by'),
	preparedAt: timestamp('prepared_at', { withTimezone: true }),
	reviewedBy: text('reviewed_by'),
	reviewedAt: timestamp('reviewed_at', { withTimezone: true }),
	approvedBy: text('approved_by'),
	approvedAt: timestamp('approved_at', { withTimezone: true }),
	createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
	createdBy: text('created_by'),
	updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
	updatedBy: text('updated_by')
});

// ============================================================================
// WORK INSTRUCTION MANAGEMENT (Parsed from uploaded documents)
// ============================================================================

// Parsed work instructions with automatic version control
export const workInstruction = pgTable('work_instruction', {
	id: text('id').primaryKey(),
	documentNumber: text('document_number').notNull().unique(), // e.g., WIMF-SPU-001
	title: text('title').notNull(),
	description: text('description'),
	documentType: text('document_type').notNull().default('spu_assembly'), // 'spu_assembly' | 'general'
	status: text('status').notNull().default('draft'), // 'draft' | 'active' | 'archived'
	currentVersion: integer('current_version').notNull().default(1),
	originalFileName: text('original_file_name'),
	fileSize: integer('file_size'),
	mimeType: text('mime_type'),
	createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
	updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
	createdBy: text('created_by').references(() => user.id)
});

// Version history for work instructions - tracks all versions with full content
export const workInstructionVersion = pgTable('work_instruction_version', {
	id: text('id').primaryKey(),
	workInstructionId: text('work_instruction_id')
		.notNull()
		.references(() => workInstruction.id),
	version: integer('version').notNull(),
	content: text('content'), // Full parsed text content
	rawContent: text('raw_content'), // Original file content as base64
	changeNotes: text('change_notes'),
	parsedAt: timestamp('parsed_at', { withTimezone: true }),
	parsedBy: text('parsed_by').references(() => user.id),
	createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow()
});

// Individual steps extracted from work instructions
export const workInstructionStep = pgTable('work_instruction_step', {
	id: text('id').primaryKey(),
	workInstructionVersionId: text('work_instruction_version_id')
		.notNull()
		.references(() => workInstructionVersion.id),
	stepNumber: integer('step_number').notNull(),
	title: text('title'),
	content: text('content'),
	imageData: text('image_data'), // Base64 encoded image for this step
	imageContentType: text('image_content_type'), // MIME type of the image
	requiresScan: boolean('requires_scan').notNull().default(false),
	scanPrompt: text('scan_prompt'), // What to scan (e.g., "Scan PT# lot number")
	notes: text('notes'),
	// Part linkage for inventory deduction on scan (PRD-INVWI)
	partDefinitionId: text('part_definition_id').references(() => partDefinition.id),
	partQuantity: integer('part_quantity').notNull().default(1),
	createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow()
});

// Parts (PT#) required for each step
export const stepPartRequirement = pgTable('step_part_requirement', {
	id: text('id').primaryKey(),
	stepId: text('step_id')
		.notNull()
		.references(() => workInstructionStep.id),
	partNumber: text('part_number').notNull(), // The PT# extracted from document
	partDefinitionId: text('part_definition_id').references(() => partDefinition.id), // Link to master data
	quantity: integer('quantity').notNull().default(1),
	notes: text('notes'),
	createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow()
});

// Tools (Tool#) required for each step
export const stepToolRequirement = pgTable('step_tool_requirement', {
	id: text('id').primaryKey(),
	stepId: text('step_id')
		.notNull()
		.references(() => workInstructionStep.id),
	toolNumber: text('tool_number').notNull(), // The Tool# extracted from document
	toolName: text('tool_name'),
	calibrationRequired: boolean('calibration_required').notNull().default(false),
	notes: text('notes'),
	createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow()
});

// Custom field definitions for work instruction steps (PRD-WINSTX)
// Allows configuring dynamic scan/input fields per step
export const stepFieldDefinition = pgTable('step_field_definition', {
	id: text('id').primaryKey(),
	stepId: text('step_id')
		.notNull()
		.references(() => workInstructionStep.id),
	fieldName: text('field_name').notNull(), // Internal name like "lot_number"
	fieldLabel: text('field_label').notNull(), // Display label like "Lot Number"
	fieldType: text('field_type').notNull(), // 'barcode_scan' | 'manual_entry' | 'date_picker' | 'dropdown'
	isRequired: boolean('is_required').notNull().default(true),
	validationPattern: text('validation_pattern'), // Regex for validation
	options: jsonb('options'), // Dropdown options array
	barcodeFieldMapping: text('barcode_field_mapping'), // GS1 AI to extract: 'lot' | 'serial' | 'expiry' | 'gtin'
	sortOrder: integer('sort_order').notNull().default(0),
	createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow()
});

// Captured field values during assembly (PRD-WINSTX)
// Stores actual values entered/scanned for each custom field per assembly step
export const stepFieldRecord = pgTable('step_field_record', {
	id: text('id').primaryKey(),
	assemblyStepRecordId: text('assembly_step_record_id')
		.notNull()
		.references(() => assemblyStepRecord.id),
	stepFieldDefinitionId: text('step_field_definition_id')
		.notNull()
		.references(() => stepFieldDefinition.id),
	fieldValue: text('field_value').notNull(), // The captured value
	rawBarcodeData: text('raw_barcode_data'), // Full scanned barcode for traceability
	bomItemId: uuid('bom_item_id').references(() => bomItem.id), // Linked BOM item if matched by lot/part
	scannedAt: timestamp('scanned_at', { withTimezone: true }), // If captured via barcode scan
	enteredAt: timestamp('entered_at', { withTimezone: true }), // If manual entry
	capturedBy: text('captured_by').references(() => user.id)
});

// General document repository for non-work-instruction documents
export const documentRepository = pgTable('document_repository', {
	id: text('id').primaryKey(),
	fileName: text('file_name').notNull(),
	originalFileName: text('original_file_name').notNull(),
	fileSize: integer('file_size'),
	mimeType: text('mime_type'),
	category: text('category'),
	tags: jsonb('tags'),
	content: text('content'), // Base64 encoded file content
	description: text('description'),
	uploadedAt: timestamp('uploaded_at', { withTimezone: true }).notNull().defaultNow(),
	uploadedBy: text('uploaded_by').references(() => user.id)
});

// Record of step completion during assembly with scanned lot numbers
export const assemblyStepRecord = pgTable('assembly_step_record', {
	id: text('id').primaryKey(),
	assemblySessionId: text('assembly_session_id')
		.notNull()
		.references(() => assemblySession.id),
	workInstructionStepId: text('work_instruction_step_id')
		.notNull()
		.references(() => workInstructionStep.id),
	scannedLotNumber: text('scanned_lot_number'),
	scannedPartNumber: text('scanned_part_number'),
	completedAt: timestamp('completed_at', { withTimezone: true }),
	completedBy: text('completed_by').references(() => user.id),
	signatureId: text('signature_id').references(() => electronicSignature.id),
	notes: text('notes')
});

// ============================================================================
// INVENTORY TRANSACTIONS (PRD-INVWI)
// ============================================================================

// Tracks all inventory movements (deductions, retractions, adjustments, receipts)
// Provides full audit trail for regulatory compliance and FIFO tracking
// Indexes recommended on: partDefinitionId, assemblySessionId for query performance
export const inventoryTransaction = pgTable('inventory_transaction', {
	id: text('id').primaryKey(),
	// References
	partDefinitionId: text('part_definition_id')
		.notNull()
		.references(() => partDefinition.id),
	bomItemId: uuid('bom_item_id').references(() => bomItem.id),
	assemblySessionId: text('assembly_session_id').references(() => assemblySession.id),
	assemblyStepRecordId: text('assembly_step_record_id').references(() => assemblyStepRecord.id),
	// Transaction details
	transactionType: text('transaction_type').notNull(), // 'deduction' | 'retraction' | 'adjustment' | 'receipt'
	quantity: integer('quantity').notNull(), // Negative for deductions
	previousQuantity: integer('previous_quantity').notNull(),
	newQuantity: integer('new_quantity').notNull(),
	reason: text('reason'),
	// Performed by
	performedBy: text('performed_by')
		.notNull()
		.references(() => user.id),
	performedAt: timestamp('performed_at', { withTimezone: true }).notNull().defaultNow(),
	// Retraction tracking (for admin corrections)
	retractedBy: text('retracted_by').references(() => user.id),
	retractedAt: timestamp('retracted_at', { withTimezone: true }),
	retractionReason: text('retraction_reason')
});

// ============================================================================
// PRODUCTION RUN TRACKING
// ============================================================================

// Tracks multi-unit manufacturing runs linked to work instructions
export const productionRun = pgTable('production_run', {
	id: text('id').primaryKey(),
	workInstructionId: text('work_instruction_id')
		.notNull()
		.references(() => workInstruction.id),
	workInstructionVersionId: text('work_instruction_version_id')
		.notNull()
		.references(() => workInstructionVersion.id),
	quantity: integer('quantity').notNull(),
	status: text('status').notNull().default('planning'),
	leadBuilderId: text('lead_builder_id')
		.notNull()
		.references(() => user.id),
	runNumber: text('run_number').notNull().unique(),
	startedAt: timestamp('started_at', { withTimezone: true }),
	pausedAt: timestamp('paused_at', { withTimezone: true }),
	completedAt: timestamp('completed_at', { withTimezone: true }),
	createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
	updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow()
});

// Individual units within a production run, each linked to an SPU
export const productionRunUnit = pgTable('production_run_unit', {
	id: text('id').primaryKey(),
	productionRunId: text('production_run_id')
		.notNull()
		.references(() => productionRun.id),
	spuId: text('spu_id')
		.notNull()
		.references(() => spu.id),
	assemblySessionId: text('assembly_session_id').references(() => assemblySession.id),
	unitIndex: integer('unit_index').notNull(),
	status: text('status').notNull().default('pending'),
	startedAt: timestamp('started_at', { withTimezone: true }),
	completedAt: timestamp('completed_at', { withTimezone: true }),
	createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow()
});

// ============================================================================
// VALIDATION TESTING
// ============================================================================

// Generated barcodes for validation sessions - tracking unique validation identifiers
export const generatedBarcode = pgTable('generated_barcode', {
	id: text('id').primaryKey(),
	prefix: text('prefix').notNull(), // 'SPEC', 'THERMO', 'MAG'
	sequence: integer('sequence').notNull(),
	barcode: text('barcode').notNull().unique(), // Full barcode string e.g., 'SPEC-000001'
	type: text('type').notNull(), // 'spectrophotometer', 'thermocouple', 'magnetometer'
	createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow()
});

// Validation session - core record for each validation test run
export const validationSession = pgTable('validation_session', {
	id: text('id').primaryKey(),
	type: text('type').notNull(), // 'spec', 'thermo', 'mag'
	spuId: text('spu_id').references(() => spu.id), // Nullable - validation may not be SPU-specific
	generatedBarcodeId: text('generated_barcode_id')
		.notNull()
		.references(() => generatedBarcode.id),
	status: text('status').notNull().default('pending'), // 'pending', 'in_progress', 'completed', 'failed'
	startedAt: timestamp('started_at', { withTimezone: true }),
	completedAt: timestamp('completed_at', { withTimezone: true }),
	userId: text('user_id')
		.notNull()
		.references(() => user.id),
	createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow()
});

// Validation result - individual test results within a validation session
export const validationResult = pgTable('validation_result', {
	id: text('id').primaryKey(),
	sessionId: text('session_id')
		.notNull()
		.references(() => validationSession.id),
	testType: text('test_type').notNull(), // Specific test within the validation type
	rawData: jsonb('raw_data'), // Raw sensor/measurement data
	processedData: jsonb('processed_data'), // Calculated/processed results
	passed: boolean('passed'), // Null until test is evaluated
	notes: text('notes'),
	createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow()
});

// ============================================================================
// MANUFACTURING - WORK INSTRUCTION FRAMEWORK (PRD-MFG-WI-001)
// ============================================================================

// Process configuration - defines each work instruction process (WI-01, WI-02, etc.)
export const processConfiguration = pgTable('process_configuration', {
	configId: text('config_id').primaryKey(),
	processName: text('process_name').notNull(),
	processType: text('process_type').notNull(), // 'PART_TO_PART' | 'SUB_ASSEMBLY'
	inputMaterials: jsonb('input_materials').notNull(), // Array of { partId, name, scanOrder }
	outputMaterial: jsonb('output_material').notNull(), // { partId, name, inventoryTarget }
	maxBatchSize: integer('max_batch_size').notNull(),
	handoffPrompt: text('handoff_prompt').notNull(),
	downstreamQueue: text('downstream_queue'), // Next process config id or null for finished goods
	workInstructionId: text('work_instruction_id').references(() => workInstruction.id),
	createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
	updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow()
});

// Universal lot record - one per batch across all WI configurations
export const lotRecord = pgTable('lot_record', {
	lotId: text('lot_id').primaryKey(),
	qrCodeRef: text('qr_code_ref').notNull().unique(),
	configId: text('config_id')
		.notNull()
		.references(() => processConfiguration.configId),
	operatorId: text('operator_id')
		.notNull()
		.references(() => user.id),
	inputLots: jsonb('input_lots').notNull(), // [{ materialId, lotNumber }]
	quantityProduced: integer('quantity_produced').notNull(),
	startTime: timestamp('start_time', { withTimezone: true }), // Set when operator presses Start
	finishTime: timestamp('finish_time', { withTimezone: true }),
	cycleTime: integer('cycle_time'), // seconds
	wiRevision: text('wi_revision'),
	status: text('status').notNull(), // 'In Progress' | 'Completed' | 'Awaiting Next Process' | 'In Next Process'
	ovenEntryTime: timestamp('oven_entry_time', { withTimezone: true }), // Set on WI-01 handoff for Wax Filling
	createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
	updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow()
});

// Configurable process steps (admin-defined reference steps per WI config)
export const processStep = pgTable('process_step', {
	id: text('id').primaryKey(),
	configId: text('config_id')
		.notNull()
		.references(() => processConfiguration.configId),
	stepNumber: integer('step_number').notNull(),
	title: text('title').notNull(),
	description: text('description'),
	imageUrl: text('image_url'), // Supabase Storage URL for reference photo
	createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
	updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow()
});

// Operator notes/photos per lot per step
export const lotStepEntry = pgTable('lot_step_entry', {
	id: text('id').primaryKey(),
	lotId: text('lot_id')
		.notNull()
		.references(() => lotRecord.lotId),
	stepId: text('step_id')
		.references(() => processStep.id),
	note: text('note'),
	imageUrl: text('image_url'), // Supabase Storage URL for operator photo
	operatorId: text('operator_id')
		.notNull()
		.references(() => user.id),
	createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow()
});

// ============================================================================
// WAX FILLING (PRD-MFG-002)
// ============================================================================

export const deckRecord = pgTable('deck_record', {
	deckId: text('deck_id').primaryKey(),
	status: text('status').notNull(), // Available | In Use | Cooldown Lockout | Needs Cleaning | Out of Service
	currentRobotId: text('current_robot_id'),
	lockoutUntil: timestamp('lockout_until', { withTimezone: true }),
	lastUsed: timestamp('last_used', { withTimezone: true }),
	createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
	updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow()
});

export const coolingTrayRecord = pgTable('cooling_tray_record', {
	trayId: text('tray_id').primaryKey(),
	status: text('status').notNull(), // Available | In Use | In QC | Needs Cleaning
	currentCartridges: jsonb('current_cartridges'), // Array of cartridge_id
	assignedRunId: text('assigned_run_id'),
	createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
	updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow()
});

export const rejectionReasonCode = pgTable('rejection_reason_code', {
	id: text('id').primaryKey(),
	code: text('code').notNull().unique(), // e.g. REJ-01, RREJ-01
	label: text('label').notNull(),
	processType: text('process_type').notNull().default('wax_filling'), // wax_filling | reagent_filling
	sortOrder: integer('sort_order').notNull().default(0),
	createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
	updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow()
});

export const waxFillingSettings = pgTable('wax_filling_settings', {
	id: text('id').primaryKey().default('default'),
	minOvenTimeMin: integer('min_oven_time_min').notNull().default(60),
	runDurationMin: integer('run_duration_min').notNull().default(30),
	removeDeckWarningMin: integer('remove_deck_warning_min').notNull().default(3),
	coolingWarningMin: integer('cooling_warning_min').notNull().default(15),
	deckLockoutMin: integer('deck_lockout_min').notNull().default(25),
	incubatorTempC: integer('incubator_temp_c').notNull().default(70),
	heaterTempC: integer('heater_temp_c').notNull().default(50),
	waxPerDeckUl: integer('wax_per_deck_ul').notNull().default(540),
	tubeCapacityUl: integer('tube_capacity_ul').notNull().default(2000),
	waxPerCartridgeUl: integer('wax_per_cartridge_ul').notNull().default(24),
	cartridgesPerColumn: integer('cartridges_per_column').notNull().default(8),
	updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow()
});

export const waxFillingRun = pgTable('wax_filling_run', {
	runId: text('run_id').primaryKey(),
	robotId: text('robot_id').notNull(),
	deckId: text('deck_id').references(() => deckRecord.deckId),
	waxSourceLot: text('wax_source_lot'),
	waxTubeId: text('wax_tube_id'),
	waxTubeTimestamp: timestamp('wax_tube_timestamp', { withTimezone: true }),
	setupTimestamp: timestamp('setup_timestamp', { withTimezone: true }),
	runStartTime: timestamp('run_start_time', { withTimezone: true }),
	runEndTime: timestamp('run_end_time', { withTimezone: true }),
	deckRemovedTime: timestamp('deck_removed_time', { withTimezone: true }),
	coolingConfirmedTime: timestamp('cooling_confirmed_time', { withTimezone: true }),
	coolingTrayId: text('cooling_tray_id').references(() => coolingTrayRecord.trayId),
	ovenLocationId: text('oven_location_id').references(() => equipmentLocation.id),
	coolingLocationId: text('cooling_location_id').references(() => equipmentLocation.id),
	status: text('status').notNull(), // Setup | Loading | Running | Awaiting Removal | Cooling | QC | Storage | Completed | Aborted
	operatorId: text('operator_id')
		.notNull()
		.references(() => user.id),
	abortReason: text('abort_reason'),
	plannedCartridgeCount: integer('planned_cartridge_count'),
	createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
	updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow()
});

export const waxCartridgeRecord = pgTable('wax_cartridge_record', {
	cartridgeId: text('cartridge_id').primaryKey(),
	backedLotId: text('backed_lot_id')
		.notNull()
		.references(() => lotRecord.lotId),
	ovenEntryTime: timestamp('oven_entry_time', { withTimezone: true }),
	waxRunId: text('wax_run_id').references(() => waxFillingRun.runId),
	deckPosition: integer('deck_position'), // 1-24
	waxTubeId: text('wax_tube_id'),
	coolingTrayId: text('cooling_tray_id').references(() => coolingTrayRecord.trayId),
	transferTimeSeconds: integer('transfer_time_seconds'),
	qcStatus: text('qc_status').notNull().default('Pending'), // Pending | Accepted | Rejected
	rejectionReason: text('rejection_reason'),
	qcTimestamp: timestamp('qc_timestamp', { withTimezone: true }),
	currentInventory: text('current_inventory').notNull(), // Oven Queue | In Process | Cooling | Cooled Cartridge | Stored | Rejected | Scrapped
	storageLocation: text('storage_location'),
	storageTimestamp: timestamp('storage_timestamp', { withTimezone: true }),
	storageOperatorId: text('storage_operator_id').references(() => user.id),
	createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
	updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow()
});

// ============================================================================
// REAGENT FILLING - ASSAY TYPES & REAGENT DEFINITIONS (PRD-MFG-RGF)
// ============================================================================

// Assay/SKU type registry (e.g. Cortisol) — each cartridge is filled for a specific assay
export const assayType = pgTable('assay_type', {
	id: text('id').primaryKey(),
	name: text('name').notNull(), // e.g. 'Cortisol'
	skuCode: text('sku_code').notNull().unique(), // e.g. 'CORT'
	isActive: boolean('is_active').notNull().default(true),
	shelfLifeDays: integer('shelf_life_days').default(90), // Expiration = reagent fill date + shelf_life_days
	bomCostOverride: numeric('bom_cost_override', { precision: 12, scale: 4 }), // Manual BOM cost per cartridge (future: auto-calculated from parts)
	useSingleCost: boolean('use_single_cost').notNull().default(false), // When true, use bomCostOverride only; when false, show per-reagent details
	createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
	updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow()
});

// Per-assay reagent well name definitions — each assay type has 6 reagent names for wells 2-7
export const reagentDefinition = pgTable('reagent_definition', {
	id: text('id').primaryKey(),
	assayTypeId: text('assay_type_id')
		.notNull()
		.references(() => assayType.id),
	wellPosition: integer('well_position').notNull(), // 2-7
	reagentName: text('reagent_name').notNull(),
	unitCost: numeric('unit_cost', { precision: 12, scale: 4 }),
	volumeMicroliters: real('volume_microliters'),
	unit: text('unit').default('µL'),
	classification: text('classification').default('raw'), // 'raw' | 'processed'
	hasBreakdown: boolean('has_breakdown').notNull().default(false),
	sortOrder: integer('sort_order').notNull().default(0),
	isActive: boolean('is_active').notNull().default(true),
	createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
	updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow()
});
// Unique constraint on (assay_type_id, well_position) enforced at application level

// Sub-components for reagent cost breakdown
export const reagentSubComponent = pgTable('reagent_sub_component', {
	id: text('id').primaryKey(),
	reagentDefinitionId: text('reagent_definition_id')
		.notNull()
		.references(() => reagentDefinition.id),
	name: text('name').notNull(),
	unitCost: numeric('unit_cost', { precision: 12, scale: 4 }),
	unit: text('unit').default('µL'),
	volumeMicroliters: real('volume_microliters'),
	classification: text('classification').default('raw'), // 'raw' | 'processed'
	sortOrder: integer('sort_order').notNull().default(0),
	createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
	updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow()
});

// Reagent filling settings — singleton configuration for fill timing and cooling requirements
export const reagentFillingSettings = pgTable('reagent_filling_settings', {
	id: text('id').primaryKey().default('default'),
	fillTimePerCartridgeMin: real('fill_time_per_cartridge_min').notNull().default(1.25),
	minCoolingTimeMin: integer('min_cooling_time_min').notNull().default(10),
	updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow()
});

// Reagent filling run — one per robotic filling execution
export const reagentFillingRun = pgTable('reagent_filling_run', {
	runId: text('run_id').primaryKey(), // RGF-XXXXXXXX
	robotId: text('robot_id').notNull(),
	operatorId: text('operator_id')
		.notNull()
		.references(() => user.id),
	assayTypeId: text('assay_type_id')
		.notNull()
		.references(() => assayType.id),
	deckId: text('deck_id').references(() => deckRecord.deckId),
	status: text('status').notNull(), // Setup | Loading | Running | Inspection | Top Sealing | Completed | Aborted | Cancelled
	setupTimestamp: timestamp('setup_timestamp', { withTimezone: true }),
	runStartTime: timestamp('run_start_time', { withTimezone: true }),
	runEndTime: timestamp('run_end_time', { withTimezone: true }),
	cartridgeCount: integer('cartridge_count'),
	abortReason: text('abort_reason'),
	abortPhotoUrl: text('abort_photo_url'),
	createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
	updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow()
});

// Per-reagent tracking: source lot and 2ml transfer tube per well per run
export const reagentTubeRecord = pgTable('reagent_tube_record', {
	id: text('id').primaryKey(),
	runId: text('run_id')
		.notNull()
		.references(() => reagentFillingRun.runId),
	wellPosition: integer('well_position').notNull(), // 2-7
	reagentName: text('reagent_name').notNull(), // Snapshot of name at time of use
	sourceLotId: text('source_lot_id').notNull(), // Barcode of source reagent lot
	transferTubeId: text('transfer_tube_id').notNull(), // Barcode of 2ml transfer tube
	createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow()
});

// Top seal batch — groups of up to 12 cartridges sealed together
export const topSealBatch = pgTable('top_seal_batch', {
	batchId: text('batch_id').primaryKey(), // TPS-XXXXXXXX
	reagentRunId: text('reagent_run_id')
		.notNull()
		.references(() => reagentFillingRun.runId),
	topSealLotId: text('top_seal_lot_id').notNull(), // Barcode of top seal raw material lot
	operatorId: text('operator_id')
		.notNull()
		.references(() => user.id),
	firstScanTime: timestamp('first_scan_time', { withTimezone: true }),
	completionTime: timestamp('completion_time', { withTimezone: true }),
	durationSeconds: integer('duration_seconds'),
	cartridgeCount: integer('cartridge_count').notNull().default(0),
	status: text('status').notNull(), // In Progress | Completed
	createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
	updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow()
});

// Per-cartridge traceability through reagent filling lifecycle
export const reagentCartridgeRecord = pgTable('reagent_cartridge_record', {
	id: text('id').primaryKey(),
	cartridgeId: text('cartridge_id')
		.notNull()
		.references(() => waxCartridgeRecord.cartridgeId),
	reagentRunId: text('reagent_run_id')
		.notNull()
		.references(() => reagentFillingRun.runId),
	assayTypeId: text('assay_type_id')
		.notNull()
		.references(() => assayType.id),
	deckPosition: integer('deck_position').notNull(), // 1-24
	inspectionStatus: text('inspection_status').notNull().default('Pending'), // Pending | Accepted | Rejected | QA/QC
	inspectionReason: text('inspection_reason'),
	inspectionTimestamp: timestamp('inspection_timestamp', { withTimezone: true }),
	inspectionOperatorId: text('inspection_operator_id'),
	topSealBatchId: text('top_seal_batch_id').references(() => topSealBatch.batchId),
	topSealTimestamp: timestamp('top_seal_timestamp', { withTimezone: true }),
	storageLocation: text('storage_location'),
	storageTimestamp: timestamp('storage_timestamp', { withTimezone: true }),
	fridgeId: text('fridge_id'), // fridge-1, fridge-2, fridge-3, fridge-4
	storageLocationId: text('storage_location_id').references(() => equipmentLocation.id),
	storageContainerBarcode: text('storage_container_barcode'), // scanned deck/tray/bucket barcode
	storageOperatorId: text('storage_operator_id').references(() => user.id),
	shippingLotId: text('shipping_lot_id'), // FK added after shippingLot table definition
	linkedAt: timestamp('linked_at', { withTimezone: true }),
	linkedBy: text('linked_by').references(() => user.id),
	currentStatus: text('current_status').notNull(), // In Process | Filled | Inspecting | Accepted | Rejected | QA/QC | Top Sealing | Completed | Stored | Scrapped
	createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
	updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow()
});

// ============================================================================
// SHIPPING LOT & QA/QC RELEASE (PRD-CART-FILL)
// ============================================================================

// Shipping lots — groups released cartridges for customer fulfillment
export const shippingLot = pgTable('shipping_lot', {
	id: text('id').primaryKey(), // LOT-XXXXXXXX
	assayTypeId: text('assay_type_id')
		.notNull()
		.references(() => assayType.id),
	customerId: text('customer_id').references(() => customer.id),
	status: text('status').notNull().default('open'), // open | released | shipped | delivered
	cartridgeCount: integer('cartridge_count').default(0),
	releasedAt: timestamp('released_at', { withTimezone: true }),
	releasedBy: text('released_by').references(() => user.id),
	notes: text('notes'),
	createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
	updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow()
});

// QA/QC release records — tracks testing per shipping lot
export const qaqcRelease = pgTable('qaqc_release', {
	id: text('id').primaryKey(),
	shippingLotId: text('shipping_lot_id')
		.notNull()
		.references(() => shippingLot.id),
	reagentRunId: text('reagent_run_id')
		.notNull()
		.references(() => reagentFillingRun.runId),
	qaqcCartridgeIds: jsonb('qaqc_cartridge_ids').notNull(), // array of cartridge record IDs
	testResult: text('test_result').default('pending'), // pending | passed | failed
	testedBy: text('tested_by').references(() => user.id),
	testedAt: timestamp('tested_at', { withTimezone: true }),
	notes: text('notes'),
	createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow()
});

// ============================================================================
// SHIPPING & FULFILLMENT (PRD-CART-DASH)
// ============================================================================

// Shipping packages — groups cartridges for fulfillment with barcode tracking
export const shippingPackage = pgTable('shipping_package', {
	id: text('id').primaryKey(), // PKG-XXXXXXXX
	barcode: text('barcode').notNull().unique(), // Scannable barcode value
	customerId: text('customer_id')
		.notNull()
		.references(() => customer.id),
	trackingNumber: text('tracking_number'),
	carrier: text('carrier'), // FedEx, UPS, USPS, etc.
	status: text('status').notNull().default('created'), // created | packed | shipped | delivered
	notes: text('notes'),
	packedBy: text('packed_by').references(() => user.id),
	packedAt: timestamp('packed_at', { withTimezone: true }),
	shippedAt: timestamp('shipped_at', { withTimezone: true }),
	deliveredAt: timestamp('delivered_at', { withTimezone: true }),
	createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
	updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow()
});

// Junction table linking cartridges to shipping packages
export const packageCartridge = pgTable('package_cartridge', {
	id: text('id').primaryKey(),
	packageId: text('package_id')
		.notNull()
		.references(() => shippingPackage.id),
	cartridgeId: text('cartridge_id')
		.notNull()
		.references(() => waxCartridgeRecord.cartridgeId),
	addedAt: timestamp('added_at', { withTimezone: true }).notNull().defaultNow()
});

// ============================================================================
// BOM & BOX.COM INTEGRATION
// ============================================================================

// BOM Item - Bill of Materials entries synced from Box.com "Live Equipment Overview"
export const bomItem = pgTable('bom_item', {
	id: uuid('id').primaryKey().defaultRandom(),
	partNumber: text('part_number').notNull().unique(),
	name: text('name').notNull(),
	description: text('description'),
	category: text('category'),
	quantityPerUnit: integer('quantity_per_unit').notNull().default(1),
	unitOfMeasure: text('unit_of_measure'),
	// Sourcing fields
	supplier: text('supplier'),
	manufacturer: text('manufacturer'),
	vendorPartNumber: text('vendor_part_number'),
	unitCost: numeric('unit_cost', { precision: 12, scale: 4 }),
	leadTimeDays: integer('lead_time_days'),
	minimumOrderQty: integer('minimum_order_qty'),
	// Compliance fields
	certifications: jsonb('certifications'), // Array of certification objects
	expirationDate: timestamp('expiration_date', { withTimezone: true }),
	msdsFileId: uuid('msds_file_id').references(() => files.id),
	hazardClass: text('hazard_class'),
	// Inventory fields
	inventoryCount: integer('inventory_count'),
	minimumStockLevel: integer('minimum_stock_level').notNull().default(0),
	// Tracking fields
	isActive: boolean('is_active').notNull().default(true),
	boxRowIndex: integer('box_row_index'), // Row index in source Excel file
	createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
	updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
	createdBy: text('created_by').references(() => user.id)
});

// Cartridge BOM Item - Bill of Materials for cartridge manufacturing (PRD-CART-DASH)
export const cartridgeBomItem = pgTable('cartridge_bom_item', {
	id: uuid('id').primaryKey().defaultRandom(),
	partNumber: text('part_number').notNull().unique(),
	name: text('name').notNull(),
	description: text('description'),
	category: text('category'),
	quantityPerUnit: real('quantity_per_unit').notNull().default(1),
	unitOfMeasure: text('unit_of_measure'),
	// Sourcing fields
	manufacturer: text('manufacturer'),
	vendorPartNumber: text('vendor_part_number'),
	unitCost: numeric('unit_cost', { precision: 12, scale: 4 }),
	leadTimeDays: integer('lead_time_days'),
	minimumOrderQty: integer('minimum_order_qty'),
	// Compliance fields
	certifications: jsonb('certifications'),
	expirationDate: timestamp('expiration_date', { withTimezone: true }),
	hazardClass: text('hazard_class'),
	// Inventory fields
	inventoryCount: integer('inventory_count'),
	minimumStockLevel: integer('minimum_stock_level').notNull().default(0),
	// Tracking fields
	isActive: boolean('is_active').notNull().default(true),
	createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
	updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow()
});

// BOM Item Version - Change tracking for audit compliance
export const bomItemVersion = pgTable('bom_item_version', {
	id: uuid('id').primaryKey().defaultRandom(),
	bomItemId: uuid('bom_item_id')
		.notNull()
		.references(() => bomItem.id),
	version: integer('version').notNull(),
	changeType: text('change_type').notNull(), // 'create', 'update', 'delete'
	previousValues: jsonb('previous_values'),
	newValues: jsonb('new_values'),
	changedBy: text('changed_by').references(() => user.id),
	changedAt: timestamp('changed_at', { withTimezone: true }).notNull().defaultNow(),
	changeReason: text('change_reason')
});

// Box.com Integration - OAuth tokens and sync status (singleton table)
export const boxIntegration = pgTable('box_integration', {
	id: uuid('id').primaryKey().defaultRandom(),
	accessToken: text('access_token'),
	refreshToken: text('refresh_token'),
	expiresAt: timestamp('expires_at', { withTimezone: true }),
	bomFolderId: text('bom_folder_id'), // "Inventory & Materials" folder ID
	bomFileId: text('bom_file_id'), // "Live Equipment Overview" file ID
	lastSyncAt: timestamp('last_sync_at', { withTimezone: true }),
	lastSyncStatus: text('last_sync_status'), // 'success', 'error', 'in_progress'
	lastSyncError: text('last_sync_error'),
	createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
	updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow()
});

// Particle IoT Cloud Integration - API tokens and sync status (singleton table)
export const particleIntegration = pgTable('particle_integration', {
	id: uuid('id').primaryKey().defaultRandom(),
	accessToken: text('access_token'),
	organizationSlug: text('organization_slug'),
	lastSyncAt: timestamp('last_sync_at', { withTimezone: true }),
	lastSyncStatus: text('last_sync_status'), // 'success', 'error', 'in_progress'
	lastSyncError: text('last_sync_error'),
	syncIntervalMinutes: integer('sync_interval_minutes').notNull().default(30),
	isActive: boolean('is_active').notNull().default(false),
	createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
	updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow()
});

// Particle Device - Cached device data from Particle Cloud
export const particleDevice = pgTable('particle_device', {
	id: text('id').primaryKey(),
	particleDeviceId: text('particle_device_id').notNull().unique(),
	name: text('name').notNull(),
	serialNumber: text('serial_number'),
	platformId: integer('platform_id'),
	firmwareVersion: text('firmware_version'),
	systemVersion: text('system_version'),
	status: text('status'), // 'online', 'offline', 'breathing', etc.
	lastHeardAt: timestamp('last_heard_at', { withTimezone: true }),
	lastIpAddress: text('last_ip_address'),
	notes: text('notes'),
	linkedSpuId: text('linked_spu_id').references(() => spu.id),
	linkedAt: timestamp('linked_at', { withTimezone: true }),
	linkedBy: text('linked_by').references(() => user.id),
	needsAttention: boolean('needs_attention').notNull().default(false),
	attentionReason: text('attention_reason'),
	createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
	updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow()
});

// BOM to Part Definition Link - Bridges BOM (purchasing) and partDefinition (assembly)
export const bomPartLink = pgTable('bom_part_link', {
	id: uuid('id').primaryKey().defaultRandom(),
	bomItemId: uuid('bom_item_id')
		.notNull()
		.references(() => bomItem.id),
	partDefinitionId: text('part_definition_id')
		.notNull()
		.references(() => partDefinition.id),
	linkType: text('link_type').notNull().default('primary'), // 'primary', 'alternate', 'substitute'
	notes: text('notes'),
	createdBy: text('created_by').references(() => user.id),
	createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow()
});

// BOM Column Mapping - Configuration for Excel column to field mapping (singleton)
export const bomColumnMapping = pgTable('bom_column_mapping', {
	id: uuid('id').primaryKey().defaultRandom(),
	columnMappings: jsonb('column_mappings').notNull(), // { partNumber: 'A', name: 'B', ... }
	headerRow: integer('header_row').notNull().default(1),
	sheetName: text('sheet_name'),
	createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
	updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow()
});

// ============================================================================
// CARTRIDGE MANAGEMENT (PRD-CART)
// ============================================================================

// Logical grouping for cartridges (e.g., 'Measurement', 'Calibration', 'Reference Standard')
export const cartridgeGroup = pgTable('cartridge_group', {
	id: text('id').primaryKey(),
	name: text('name').notNull().unique(),
	description: text('description'),
	color: text('color'), // Hex color for UI badge (e.g., '#00ffff')
	createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
	updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
	createdBy: text('created_by').references(() => user.id)
});

// Core cartridge record — each physical cartridge tracked by barcode
export const cartridge = pgTable('cartridge', {
	id: text('id').primaryKey(),
	barcode: text('barcode').notNull().unique(),
	serialNumber: text('serial_number').unique(),
	lotNumber: text('lot_number').notNull(),
	cartridgeType: text('cartridge_type').notNull(), // 'measurement' | 'calibration' | 'reference' | 'test'
	status: text('status').notNull().default('available'), // 'available' | 'in_use' | 'depleted' | 'expired' | 'quarantine' | 'disposed'
	groupId: text('group_id').references(() => cartridgeGroup.id),
	partDefinitionId: text('part_definition_id').references(() => partDefinition.id),
	manufacturer: text('manufacturer'),
	expirationDate: timestamp('expiration_date', { withTimezone: true }),
	receivedDate: timestamp('received_date', { withTimezone: true }),
	openedDate: timestamp('opened_date', { withTimezone: true }),
	usesRemaining: integer('uses_remaining'),
	totalUses: integer('total_uses'),
	storageLocation: text('storage_location'),
	storageConditions: text('storage_conditions'),
	notes: text('notes'),
	isActive: boolean('is_active').notNull().default(true),
	createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
	updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
	createdBy: text('created_by').references(() => user.id)
});

// Full audit trail for every cartridge action (ALCOA+ compliance)
export const cartridgeUsageLog = pgTable('cartridge_usage_log', {
	id: text('id').primaryKey(),
	cartridgeId: text('cartridge_id')
		.notNull()
		.references(() => cartridge.id),
	action: text('action').notNull(), // 'registered' | 'scanned' | 'used' | 'returned' | 'quarantined' | 'disposed' | 'status_changed' | 'group_changed' | 'exported' | 'deleted'
	previousValue: text('previous_value'),
	newValue: text('new_value'),
	spuId: text('spu_id').references(() => spu.id),
	validationSessionId: text('validation_session_id').references(() => validationSession.id),
	notes: text('notes'),
	performedBy: text('performed_by')
		.notNull()
		.references(() => user.id),
	performedAt: timestamp('performed_at', { withTimezone: true }).notNull().defaultNow()
});

// ============================================================================
// FIRMWARE TABLES (PRD-ASSAY)
// These tables already exist in the shared Supabase PostgreSQL database.
// They are created/owned by the firmware's schema.sql and edge functions.
// DO NOT run Drizzle push/migrate on these — read-only Drizzle definitions.
// ============================================================================

// Assay test protocol definitions with compiled BCODE
// id is UUID in firmware DB (uuid_generate_v4)
export const assay = pgTable('assays', {
	id: uuid('id').primaryKey().defaultRandom(),
	assayId: varchar('assay_id', { length: 9 }).notNull().unique(),
	name: text('name').notNull(),
	description: text('description'),
	duration: integer('duration'), // milliseconds
	bcode: bytea('bcode'),
	bcodeLength: integer('bcode_length'),
	checksum: integer('checksum'), // CRC32, signed INT32
	version: integer('version'),
	isActive: boolean('is_active').notNull().default(true),
	metadata: jsonb('metadata'),
	createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
	updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow()
});

// Firmware devices registered with the system
// id is UUID in firmware DB
export const firmwareDevice = pgTable('devices', {
	id: uuid('id').primaryKey().defaultRandom(),
	deviceId: varchar('device_id', { length: 64 }).notNull().unique(),
	apiKey: text('api_key'),
	firmwareVersion: text('firmware_version'),
	dataFormatVersion: text('data_format_version'),
	lastSeen: timestamp('last_seen', { withTimezone: true }),
	metadata: jsonb('metadata'),
	createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
	updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow()
});

// Firmware cartridge records (UUID-based, device operations)
// NOTE: This is DIFFERENT from the webapp's 'cartridge' table (barcode-based, inventory/QMS).
// The firmware table uses cartridge_uuid; the webapp table uses barcode.
// ASSAY-007 bridges the two systems.
// id, last_validated_by, test_result_id are UUID in firmware DB
export const firmwareCartridge = pgTable('cartridges', {
	id: uuid('id').primaryKey().defaultRandom(),
	cartridgeUuid: varchar('cartridge_uuid', { length: 37 }).notNull().unique(),
	assayId: varchar('assay_id', { length: 9 }),
	status: text('status').notNull().default('unused'), // unused | validated | used | expired | invalid | cancelled
	lotNumber: text('lot_number'),
	expirationDate: timestamp('expiration_date', { withTimezone: true }),
	serialNumber: text('serial_number'),
	siteId: text('site_id'),
	program: text('program'),
	experiment: text('experiment'),
	arm: text('arm'),
	quantity: integer('quantity'),
	validationErrors: jsonb('validation_errors'),
	statusUpdatedAt: timestamp('status_updated_at', { withTimezone: true }),
	validationCount: integer('validation_count').default(0),
	lastValidatedAt: timestamp('last_validated_at', { withTimezone: true }),
	lastValidatedBy: uuid('last_validated_by'),
	testResultId: uuid('test_result_id'),
	metadata: jsonb('metadata'),
	createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
	updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow()
});

// Test results uploaded from devices after running assays
// id and device_id are UUID in firmware DB; has processed_at instead of updated_at
export const testResult = pgTable('test_results', {
	id: uuid('id').primaryKey().defaultRandom(),
	dataFormatCode: text('data_format_code'),
	cartridgeUuid: varchar('cartridge_uuid', { length: 37 }),
	assayId: varchar('assay_id', { length: 9 }),
	deviceId: uuid('device_id'),
	startTime: bigint('start_time', { mode: 'number' }),
	duration: integer('duration'),
	astep: integer('astep'),
	atime: integer('atime'),
	again: integer('again'),
	numberOfReadings: integer('number_of_readings'),
	baselineScans: integer('baseline_scans'),
	testScans: integer('test_scans'),
	checksum: bigint('checksum', { mode: 'number' }),
	rawRecord: bytea('raw_record'),
	status: text('status').notNull().default('uploaded'), // uploaded | processed | flagged | archived
	metadata: jsonb('metadata'),
	createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
	processedAt: timestamp('processed_at', { withTimezone: true })
});

// Spectrophotometer readings from AS7341 sensor (per test result)
export const spectroReading = pgTable('spectro_readings', {
	id: uuid('id').primaryKey().defaultRandom(),
	testResultId: uuid('test_result_id').notNull(),
	readingNumber: integer('reading_number').notNull(),
	channel: varchar('channel', { length: 1 }).notNull(), // A | B | C
	position: integer('position'),
	temperature: real('temperature'),
	laserOutput: real('laser_output'),
	timestampMs: bigint('timestamp_ms', { mode: 'number' }),
	f1: integer('f1'), // 415nm violet
	f2: integer('f2'), // 445nm blue
	f3: integer('f3'), // 480nm cyan
	f4: integer('f4'), // 515nm green
	f5: integer('f5'), // 555nm yellow-green
	f6: integer('f6'), // 590nm orange
	f7: integer('f7'), // 630nm red
	f8: integer('f8'), // 680nm deep-red
	clearChannel: integer('clear_channel'),
	nirChannel: integer('nir_channel')
});

// Device event audit trail (validate, load_assay, upload, reset, error)
export const deviceEvent = pgTable('device_events', {
	id: uuid('id').primaryKey().defaultRandom(),
	deviceId: varchar('device_id', { length: 64 }).notNull(),
	eventType: text('event_type').notNull(), // validate | load_assay | upload | reset | error
	eventData: jsonb('event_data'),
	cartridgeUuid: varchar('cartridge_uuid', { length: 37 }),
	success: boolean('success'),
	errorMessage: text('error_message'),
	createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow()
});

// ============================================================================
// EQUIPMENT LOCATION REGISTRY (Opentrons Dashboard)
// ============================================================================

// Scannable fridge/oven locations for equipment tracking
export const equipmentLocation = pgTable('equipment_location', {
	id: text('id').primaryKey(), // LOC-XXXXXXXX
	barcode: text('barcode').notNull().unique(),
	locationType: text('location_type').notNull(), // 'fridge' | 'oven'
	displayName: text('display_name').notNull(),
	isActive: boolean('is_active').notNull().default(true),
	capacity: integer('capacity'),
	notes: text('notes'),
	createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
	updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow()
});

// Append-only log of item placements in/out of locations
export const locationPlacement = pgTable('location_placement', {
	id: text('id').primaryKey(),
	locationId: text('location_id')
		.notNull()
		.references(() => equipmentLocation.id),
	itemType: text('item_type').notNull(), // 'deck' | 'tray' | 'cartridge_batch'
	itemId: text('item_id').notNull(),
	placedBy: text('placed_by')
		.notNull()
		.references(() => user.id),
	placedAt: timestamp('placed_at', { withTimezone: true }).notNull().defaultNow(),
	removedBy: text('removed_by').references(() => user.id),
	removedAt: timestamp('removed_at', { withTimezone: true }),
	runId: text('run_id'),
	notes: text('notes'),
	createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow()
});

// ============================================================================
// ASSAY VERSION HISTORY (PRD-ASSAY, ASSAY-009)
// Webapp-managed table for tracking assay edit history.
// ============================================================================

export const assayVersion = pgTable('assay_version', {
	id: text('id').primaryKey(),
	assayId: varchar('assay_id', { length: 9 }).notNull(),
	versionNumber: integer('version_number').notNull(),
	previousName: text('previous_name').notNull(),
	previousDescription: text('previous_description'),
	previousBcode: bytea('previous_bcode'),
	previousBcodeLength: integer('previous_bcode_length'),
	previousChecksum: integer('previous_checksum'),
	previousDuration: integer('previous_duration'),
	previousMetadata: jsonb('previous_metadata'),
	changedBy: text('changed_by').references(() => user.id),
	changedAt: timestamp('changed_at', { withTimezone: true }).notNull().defaultNow(),
	changeNotes: text('change_notes')
});

// ============================================================================
// BOM LABOR & SPU PART TRACEABILITY
// ============================================================================

export const laborEntry = pgTable('labor_entry', {
	id: text('id').primaryKey(),
	taskName: text('task_name').notNull(),
	timeHours: real('time_hours').notNull(),
	laborRate: real('labor_rate').notNull(),
	associatedPartId: text('associated_part_id').references(() => partDefinition.id),
	createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
	updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow()
});

export const spuPartUsage = pgTable('spu_part_usage', {
	id: text('id').primaryKey(),
	spuId: text('spu_id')
		.notNull()
		.references(() => spu.id),
	lotId: text('lot_id'), // FK to lot table added later when lot model exists
	partId: text('part_id')
		.notNull()
		.references(() => partDefinition.id),
	quantityUsed: integer('quantity_used').notNull(),
	recordedAt: timestamp('recorded_at', { withTimezone: true }).notNull().defaultNow(),
	recordedBy: text('recorded_by').references(() => user.id)
});

// ============================================================================
// INCUBATOR TUBE TRACKING (PRD-MFX)
// ============================================================================

// Individual incubator tube (formerly "wax transfer tube") with volume tracking
export const incubatorTube = pgTable('incubator_tube', {
	tubeId: text('tube_id').primaryKey(), // Physical barcode
	initialVolumeUl: integer('initial_volume_ul').notNull().default(2000),
	remainingVolumeUl: integer('remaining_volume_ul').notNull().default(2000),
	status: text('status').notNull().default('Active'), // Active | Depleted | Retired
	totalCartridgesFilled: integer('total_cartridges_filled').notNull().default(0),
	totalRunsUsed: integer('total_runs_used').notNull().default(0),
	firstUsedAt: timestamp('first_used_at', { withTimezone: true }),
	lastUsedAt: timestamp('last_used_at', { withTimezone: true }),
	registeredBy: text('registered_by'),
	createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
	updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow()
});

// Per-transaction usage log for incubator tubes (fill, refund, adjustment)
export const incubatorTubeUsage = pgTable('incubator_tube_usage', {
	id: text('id').primaryKey(), // nanoid()
	tubeId: text('tube_id').notNull(),
	waxRunId: text('wax_run_id'),
	cartridgeCount: integer('cartridge_count').notNull(),
	volumeChangedUl: integer('volume_changed_ul').notNull(), // positive = consumption, negative = refund
	remainingVolumeUlBefore: integer('remaining_volume_ul_before').notNull(),
	remainingVolumeUlAfter: integer('remaining_volume_ul_after').notNull(),
	usageType: text('usage_type').notNull(), // fill | abort_refund | manual_adjustment
	operatorId: text('operator_id').notNull(),
	notes: text('notes'),
	createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow()
});

// ============================================================================
// TOP SEAL CUTTING (PRD-MFX)
// ============================================================================

// Individual polyethylene rolls tracked by length
export const topSealRoll = pgTable('top_seal_roll', {
	rollId: text('roll_id').primaryKey(), // ROLL- + nanoid(8).toUpperCase()
	barcode: text('barcode').unique(), // Optional physical barcode
	initialLengthFt: real('initial_length_ft').notNull().default(54),
	remainingLengthFt: real('remaining_length_ft').notNull().default(54),
	status: text('status').notNull().default('Active'), // Active | Depleted | Retired
	createdBy: text('created_by'),
	createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
	updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow()
});

// Per-session cutting records from a roll
export const topSealCutRecord = pgTable('top_seal_cut_record', {
	id: text('id').primaryKey(), // nanoid()
	rollId: text('roll_id').notNull(),
	quantityCut: integer('quantity_cut').notNull(),
	lengthPerCutFt: real('length_per_cut_ft').notNull(), // Snapshot from settings at time of cut
	totalLengthUsedFt: real('total_length_used_ft').notNull(), // quantityCut * lengthPerCutFt
	operatorId: text('operator_id').notNull(),
	notes: text('notes'),
	createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow()
});

// ============================================================================
// LASER CUT THERMOSEAL (PRD-MFX)
// ============================================================================

// Per-batch laser cutting records
export const laserCutBatch = pgTable('laser_cut_batch', {
	batchId: text('batch_id').primaryKey(), // LCB- + nanoid(8).toUpperCase()
	inputSheetCount: integer('input_sheet_count').notNull(), // Raw cut thermoseal strips consumed
	outputSheetCount: integer('output_sheet_count').notNull(), // Successfully laser cut sheets produced
	failureCount: integer('failure_count').notNull().default(0),
	failureNotes: text('failure_notes'),
	cuttingProgramLink: text('cutting_program_link'), // URL to external cutting program
	referencePhotos: jsonb('reference_photos'), // Array of photo URL strings
	toolsUsed: text('tools_used'),
	operatorId: text('operator_id').notNull(),
	createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
	updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow()
});

// ============================================================================
// MANUFACTURING SETTINGS (PRD-MFX)
// ============================================================================

// Singleton settings for manufacturing-wide parameters
export const manufacturingSettings = pgTable('manufacturing_settings', {
	id: text('id').primaryKey().default('default'),
	topSealLengthPerCutFt: real('top_seal_length_per_cut_ft').notNull().default(1.5),
	defaultRollLengthFt: real('default_roll_length_ft').notNull().default(54),
	cartridgesPerLaserCutSheet: integer('cartridges_per_laser_cut_sheet').notNull().default(16),
	sheetsPerLaserBatch: integer('sheets_per_laser_batch').notNull().default(3),
	defaultLaserTools: text('default_laser_tools'),
	defaultCuttingProgramLink: text('default_cutting_program_link'),
	updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow()
});

// ============================================================================
// MANUFACTURING MATERIAL INVENTORY (PRD-MFX)
// ============================================================================

// Tracked manufacturing materials (e.g. cut thermoseal strips, laser cut sheets)
export const manufacturingMaterial = pgTable('manufacturing_material', {
	materialId: text('material_id').primaryKey(),
	name: text('name').notNull().unique(), // e.g. 'Cut Thermoseal Strips'
	unit: text('unit').notNull(), // e.g. 'strips', 'sheets'
	currentQuantity: integer('current_quantity').notNull().default(0),
	updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow()
});

// Transaction history for material inventory changes
export const manufacturingMaterialTransaction = pgTable('manufacturing_material_transaction', {
	id: text('id').primaryKey(), // nanoid()
	materialId: text('material_id').notNull(),
	transactionType: text('transaction_type').notNull(), // produce | consume | adjustment
	quantityChanged: integer('quantity_changed').notNull(), // positive = produce/add, negative = consume
	quantityBefore: integer('quantity_before').notNull(),
	quantityAfter: integer('quantity_after').notNull(),
	relatedBatchId: text('related_batch_id'), // References laser_cut_batch or other batch
	operatorId: text('operator_id').notNull(),
	notes: text('notes'),
	createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow()
});

// ============================================================================
// EQUIPMENT MANAGEMENT (PRD-MFX)
// ============================================================================

// Equipment registry with Mocreo sensor integration fields
export const equipment = pgTable('equipment', {
	equipmentId: text('equipment_id').primaryKey(), // EQ- + nanoid(8).toUpperCase()
	name: text('name').notNull(), // e.g. 'Fridge A', 'Oven 1'
	equipmentType: text('equipment_type').notNull(), // fridge | oven
	location: text('location'), // Physical location description
	status: text('status').notNull().default('active'), // active | maintenance | offline
	mocreoDeviceId: text('mocreo_device_id'), // Mocreo sensor device ID if linked
	mocreoAssetId: text('mocreo_asset_id'), // Mocreo asset ID for API
	temperatureMinC: real('temperature_min_c'), // Warning range min celsius
	temperatureMaxC: real('temperature_max_c'), // Warning range max celsius
	currentTemperatureC: real('current_temperature_c'), // Last known temperature
	lastTemperatureReadAt: timestamp('last_temperature_read_at', { withTimezone: true }),
	notes: text('notes'),
	createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
	updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow()
});

// Unified event log for all equipment types
export const equipmentEventLog = pgTable('equipment_event_log', {
	id: text('id').primaryKey(), // nanoid()
	equipmentId: text('equipment_id').notNull(), // Can be equipment.equipmentId, deckRecord.deckId, etc.
	equipmentType: text('equipment_type').notNull(), // fridge | oven | deck | tray | robot
	eventType: text('event_type').notNull(), // item_placed | item_removed | door_opened | door_closed | temperature_reading | maintenance_start | maintenance_end
	description: text('description'), // e.g. 'Deck DK-001 placed in oven'
	relatedRunId: text('related_run_id'), // Wax or reagent run ID if applicable
	relatedItemId: text('related_item_id'), // Deck/tray/cartridge ID if applicable
	temperatureC: real('temperature_c'), // Temperature at time of event
	operatorId: text('operator_id'),
	notes: text('notes'),
	createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow()
});

// ============================================================================
// OPENTRONS OT-2 INTEGRATION
// ============================================================================

// Robot registry — tracks OT-2 robots by IP for network control
export const opentronsRobot = pgTable('opentrons_robot', {
	robotId: text('robot_id').primaryKey(), // OTR-{nanoid(8)}
	name: text('name').notNull(),
	ip: text('ip').notNull(),
	port: integer('port').notNull().default(31950),
	robotSide: text('robot_side'), // left | right (maps to protocol param)
	legacyRobotId: text('legacy_robot_id'), // robot-1 | robot-2 (bridges existing wax/reagent runs)
	isActive: boolean('is_active').notNull().default(true),
	firmwareVersion: text('firmware_version'),
	apiVersion: text('api_version'),
	robotModel: text('robot_model'),
	robotSerial: text('robot_serial'),
	lastHealthAt: timestamp('last_health_at', { withTimezone: true }),
	lastHealthOk: boolean('last_health_ok'),
	source: text('source').notNull().default('ui'), // env | ui
	createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
	updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow()
});

// Protocol records — mirrors protocols uploaded to robots, persisted in DB for Vercel viewing
export const opentronsProtocolRecord = pgTable('opentrons_protocol_record', {
	id: text('id').primaryKey(), // OTP-{nanoid(8)}
	robotId: text('robot_id').notNull(),
	opentronsProtocolId: text('opentrons_protocol_id').notNull(), // ID from OT-2 API
	protocolName: text('protocol_name').notNull(),
	protocolType: text('protocol_type'), // wax_filling | reagent_filling | custom
	fileHash: text('file_hash'), // SHA-256 for version tracking
	parametersSchema: jsonb('parameters_schema'), // parsed add_parameters() definition
	analysisStatus: text('analysis_status'), // pending | completed | failed
	analysisData: jsonb('analysis_data'), // full analysis result
	labwareDefinitions: jsonb('labware_definitions'), // labware from analysis
	pipettesRequired: jsonb('pipettes_required'), // pipettes from analysis
	uploadedBy: text('uploaded_by'),
	createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
	updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow()
});

// Health check history — snapshots for monitoring and diagnostics
export const opentronsHealthSnapshot = pgTable('opentrons_health_snapshot', {
	id: text('id').primaryKey(), // nanoid()
	robotId: text('robot_id').notNull(),
	firmwareVersion: text('firmware_version'),
	apiVersion: text('api_version'),
	systemVersion: text('system_version'),
	robotSerial: text('robot_serial'),
	leftPipette: jsonb('left_pipette'), // {model, id, has_tip}
	rightPipette: jsonb('right_pipette'), // {model, id, has_tip}
	modules: jsonb('modules'), // [{serial, type, status, data}]
	isHealthy: boolean('is_healthy').notNull(),
	responseTimeMs: integer('response_time_ms'),
	errorMessage: text('error_message'),
	createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow()
});

// ============================================================================
// RECEIVING OF GOODS & INSPECTION (PRD-03)
// ============================================================================

export const inspectionProcedureRevision = pgTable('inspection_procedure_revision', {
	id: text('id').primaryKey(),
	partId: text('part_id')
		.notNull()
		.references(() => partDefinition.id),
	revisionNumber: integer('revision_number').notNull(),
	documentUrl: text('document_url').notNull(), // original .docx URL in Supabase Storage
	renderedHtmlUrl: text('rendered_html_url'), // converted HTML URL
	formDefinition: jsonb('form_definition'), // IP form JSON (tools, steps, references)
	uploadedBy: text('uploaded_by')
		.notNull()
		.references(() => user.id),
	uploadedAt: timestamp('uploaded_at', { withTimezone: true }).notNull().defaultNow(),
	changeNotes: text('change_notes'),
	isCurrent: boolean('is_current').notNull().default(true)
});

export const receivingLot = pgTable('receiving_lot', {
	lotId: text('lot_id').primaryKey(), // scanned barcode value
	partId: text('part_id')
		.notNull()
		.references(() => partDefinition.id),
	quantity: integer('quantity').notNull(),
	operatorId: text('operator_id')
		.notNull()
		.references(() => user.id),
	createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
	inspectionPathway: text('inspection_pathway').notNull(), // 'coc' | 'ip'
	cocDocumentUrl: text('coc_document_url'),
	ipResults: jsonb('ip_results'),
	ipRevisionId: text('ip_revision_id').references(() => inspectionProcedureRevision.id),
	poReference: text('po_reference'),
	supplier: text('supplier'),
	vendorLotNumber: text('vendor_lot_number'),
	expirationDate: timestamp('expiration_date', { withTimezone: true }),
	photos: jsonb('photos').$type<string[]>().default([]),
	additionalDocuments: jsonb('additional_documents').$type<string[]>().default([]),
	overrideApplied: boolean('override_applied').notNull().default(false),
	overrideReason: text('override_reason'),
	overrideBy: text('override_by').references(() => user.id),
	overrideAt: timestamp('override_at', { withTimezone: true }),
	status: text('status').notNull().default('accepted') // 'accepted' | 'rejected'
});

export const inspectionResult = pgTable('inspection_result', {
	id: text('id').primaryKey(),
	lotId: text('lot_id')
		.notNull()
		.references(() => receivingLot.lotId),
	sampleNumber: integer('sample_number').notNull(),
	stepOrder: integer('step_order').notNull(),
	inputType: text('input_type').notNull(), // 'pass_fail' | 'yes_no' | 'dimension' | 'visual_inspection'
	questionLabel: text('question_label').notNull(),
	expectedValue: text('expected_value'),
	actualValue: text('actual_value').notNull(),
	result: text('result').notNull(), // 'pass' | 'fail' | 'manual_review'
	toolUsed: text('tool_used'),
	notes: text('notes')
});

export const toolConfirmation = pgTable('tool_confirmation', {
	id: text('id').primaryKey(),
	lotId: text('lot_id')
		.notNull()
		.references(() => receivingLot.lotId),
	toolId: text('tool_id').notNull(), // e.g., "TOOL-SPU-007"
	toolName: text('tool_name').notNull(),
	confirmedBy: text('confirmed_by')
		.notNull()
		.references(() => user.id),
	confirmedAt: timestamp('confirmed_at', { withTimezone: true }).notNull().defaultNow()
});

// ============================================================================
// TYPE EXPORTS
// ============================================================================

export type Session = typeof session.$inferSelect;
export type User = typeof user.$inferSelect;
export type Role = typeof role.$inferSelect;
export type Permission = typeof permission.$inferSelect;
export type UserRole = typeof userRole.$inferSelect;
export type RolePermission = typeof rolePermission.$inferSelect;
export type InviteToken = typeof inviteToken.$inferSelect;
export type AuditLog = typeof auditLog.$inferSelect;
export type Customer = typeof customer.$inferSelect;
export type CustomerNote = typeof customerNote.$inferSelect;
export type ShippingPackage = typeof shippingPackage.$inferSelect;
export type PackageCartridge = typeof packageCartridge.$inferSelect;
export type Batch = typeof batch.$inferSelect;
export type Spu = typeof spu.$inferSelect;
export type ParticleLink = typeof particleLink.$inferSelect;
export type PartDefinition = typeof partDefinition.$inferSelect;
export type SpuPart = typeof spuPart.$inferSelect;
export type AssemblySession = typeof assemblySession.$inferSelect;
export type ElectronicSignature = typeof electronicSignature.$inferSelect;
export type Document = typeof document.$inferSelect;
export type DocumentRevision = typeof documentRevision.$inferSelect;
export type DocumentTraining = typeof documentTraining.$inferSelect;
export type File = typeof files.$inferSelect;
export type WorkInstruction = typeof workInstructions.$inferSelect;

export type BomItem = typeof bomItem.$inferSelect;
export type CartridgeBomItem = typeof cartridgeBomItem.$inferSelect;
export type BomItemVersion = typeof bomItemVersion.$inferSelect;
export type BoxIntegration = typeof boxIntegration.$inferSelect;
export type BomPartLink = typeof bomPartLink.$inferSelect;
export type BomColumnMapping = typeof bomColumnMapping.$inferSelect;
export type ParticleIntegration = typeof particleIntegration.$inferSelect;
export type ParticleDevice = typeof particleDevice.$inferSelect;
export type LaborEntry = typeof laborEntry.$inferSelect;
export type SpuPartUsage = typeof spuPartUsage.$inferSelect;

// Work Instruction Management types
export type WorkInstructionParsed = typeof workInstruction.$inferSelect;
export type WorkInstructionVersionRecord = typeof workInstructionVersion.$inferSelect;
export type WorkInstructionStepRecord = typeof workInstructionStep.$inferSelect;
export type StepPartRequirementRecord = typeof stepPartRequirement.$inferSelect;
export type StepToolRequirementRecord = typeof stepToolRequirement.$inferSelect;
export type StepFieldDefinitionRecord = typeof stepFieldDefinition.$inferSelect;
export type StepFieldRecordType = typeof stepFieldRecord.$inferSelect;
export type DocumentRepositoryItem = typeof documentRepository.$inferSelect;
export type AssemblyStepRecordType = typeof assemblyStepRecord.$inferSelect;
export type WorkInstructionDocType = 'spu_assembly' | 'general';
export type WorkInstructionStatus = 'draft' | 'active' | 'archived';

// Enum types for documents
export type FileType = 'raw_data' | 'image' | 'document' | 'spreadsheet' | 'other';
export type WorkInstructionCategory =
	| 'assembly'
	| 'testing'
	| 'packaging'
	| 'labeling'
	| 'inspection';
export type DocumentStatus = 'draft' | 'released' | 'obsolete';

// Enum types for BOM
export type BomChangeType = 'create' | 'update' | 'delete';
export type BomLinkType = 'primary' | 'alternate' | 'substitute';
export type BoxSyncStatus = 'success' | 'error' | 'in_progress';

// Enum types for Step Field Definitions (PRD-WINSTX)
export type StepFieldType = 'barcode_scan' | 'manual_entry' | 'date_picker' | 'dropdown';
export type BarcodeFieldMapping = 'lot' | 'serial' | 'expiry' | 'gtin' | 'part_number';

// Validation types
export type GeneratedBarcodeRecord = typeof generatedBarcode.$inferSelect;
export type ValidationSessionRecord = typeof validationSession.$inferSelect;
export type ValidationResultRecord = typeof validationResult.$inferSelect;

// Enum types for Validation
export type ValidationType = 'spec' | 'thermo' | 'mag';
export type ValidationBarcodeType = 'spectrophotometer' | 'thermocouple' | 'magnetometer';
export type ValidationSessionStatus = 'pending' | 'in_progress' | 'completed' | 'failed';

// Inventory Transaction types (PRD-INVWI)
export type InventoryTransaction = typeof inventoryTransaction.$inferSelect;
export type InventoryTransactionType = 'deduction' | 'retraction' | 'adjustment' | 'receipt';

// Production Run types (PRD-PRUN)
export type ProductionRun = typeof productionRun.$inferSelect;
export type ProductionRunStatus =
	| 'planning'
	| 'inventory_check'
	| 'approved'
	| 'in_progress'
	| 'paused'
	| 'completed'
	| 'cancelled';
export type ProductionRunUnit = typeof productionRunUnit.$inferSelect;
export type ProductionRunUnitStatus = 'pending' | 'in_progress' | 'completed' | 'cancelled';
export type InspectionPathway = 'coc' | 'ip';

// Cartridge Management types (PRD-CART)
export type CartridgeGroup = typeof cartridgeGroup.$inferSelect;
export type Cartridge = typeof cartridge.$inferSelect;
export type CartridgeType = 'measurement' | 'calibration' | 'reference' | 'test';
export type CartridgeStatus = 'available' | 'in_use' | 'depleted' | 'expired' | 'quarantine' | 'disposed';
export type CartridgeUsageLog = typeof cartridgeUsageLog.$inferSelect;
export type CartridgeAction = 'registered' | 'scanned' | 'used' | 'returned' | 'quarantined' | 'disposed' | 'status_changed' | 'group_changed' | 'exported' | 'deleted';

// Firmware table types (PRD-ASSAY)
export type Assay = typeof assay.$inferSelect;
export type FirmwareDevice = typeof firmwareDevice.$inferSelect;
export type FirmwareCartridge = typeof firmwareCartridge.$inferSelect;
export type TestResult = typeof testResult.$inferSelect;
export type SpectroReading = typeof spectroReading.$inferSelect;
export type DeviceEvent = typeof deviceEvent.$inferSelect;

// Firmware enum types
export type FirmwareCartridgeStatus = 'unused' | 'validated' | 'used' | 'expired' | 'invalid' | 'cancelled';
export type TestResultStatus = 'uploaded' | 'processed' | 'flagged' | 'archived';
export type DeviceEventType = 'validate' | 'load_assay' | 'upload' | 'reset' | 'error';
export type SpectroChannel = 'A' | 'B' | 'C';

// Assay version history types (ASSAY-009)
export type AssayVersion = typeof assayVersion.$inferSelect;

// Manufacturing Work Instruction Framework (PRD-MFG-WI-001)
export type ProcessConfiguration = typeof processConfiguration.$inferSelect;
export type LotRecord = typeof lotRecord.$inferSelect;

// Process steps (configurable reference steps for WI pages)
export type ProcessStep = typeof processStep.$inferSelect;
export type LotStepEntry = typeof lotStepEntry.$inferSelect;

// Wax Filling (PRD-MFG-002)
export type DeckRecord = typeof deckRecord.$inferSelect;
export type CoolingTrayRecord = typeof coolingTrayRecord.$inferSelect;
export type RejectionReasonCode = typeof rejectionReasonCode.$inferSelect;
export type WaxFillingSettings = typeof waxFillingSettings.$inferSelect;
export type WaxFillingRun = typeof waxFillingRun.$inferSelect;
export type WaxCartridgeRecord = typeof waxCartridgeRecord.$inferSelect;

// Reagent Filling - Assay Types (PRD-MFG-RGF)
export type AssayType = typeof assayType.$inferSelect;
export type ReagentDefinition = typeof reagentDefinition.$inferSelect;
export type ReagentFillingSettings = typeof reagentFillingSettings.$inferSelect;
export type ReagentFillingRun = typeof reagentFillingRun.$inferSelect;
export type ReagentTubeRecord = typeof reagentTubeRecord.$inferSelect;
export type TopSealBatch = typeof topSealBatch.$inferSelect;
export type ReagentCartridgeRecord = typeof reagentCartridgeRecord.$inferSelect;
export type ReagentSubComponent = typeof reagentSubComponent.$inferSelect;
export type ShippingLot = typeof shippingLot.$inferSelect;
export type QaqcRelease = typeof qaqcRelease.$inferSelect;

// Equipment Location Registry (Opentrons Dashboard)
export type EquipmentLocation = typeof equipmentLocation.$inferSelect;
export type LocationPlacement = typeof locationPlacement.$inferSelect;
export type LocationType = 'fridge' | 'oven';

// Incubator Tube Tracking
export type IncubatorTube = typeof incubatorTube.$inferSelect;
export type IncubatorTubeUsage = typeof incubatorTubeUsage.$inferSelect;

// Top Seal Cutting
export type TopSealRoll = typeof topSealRoll.$inferSelect;
export type TopSealCutRecord = typeof topSealCutRecord.$inferSelect;

// Laser Cut Thermoseal
export type LaserCutBatch = typeof laserCutBatch.$inferSelect;

// Manufacturing Settings
export type ManufacturingSettings = typeof manufacturingSettings.$inferSelect;

// Manufacturing Material Inventory
export type ManufacturingMaterial = typeof manufacturingMaterial.$inferSelect;
export type ManufacturingMaterialTransaction = typeof manufacturingMaterialTransaction.$inferSelect;

// Equipment Management
export type Equipment = typeof equipment.$inferSelect;
export type EquipmentEventLog = typeof equipmentEventLog.$inferSelect;

// Opentrons OT-2 Integration
export type OpentronsRobot = typeof opentronsRobot.$inferSelect;
export type OpentronsProtocolRecord = typeof opentronsProtocolRecord.$inferSelect;
export type OpentronsHealthSnapshot = typeof opentronsHealthSnapshot.$inferSelect;

// Receiving of Goods & Inspection (PRD-03)
export type InspectionProcedureRevision = typeof inspectionProcedureRevision.$inferSelect;
export type ReceivingLot = typeof receivingLot.$inferSelect;
export type InspectionResult = typeof inspectionResult.$inferSelect;
export type ToolConfirmation = typeof toolConfirmation.$inferSelect;
export type ReceivingLotStatus = 'accepted' | 'rejected';
export type InspectionInputType = 'pass_fail' | 'yes_no' | 'dimension' | 'visual_inspection';
export type InspectionResultValue = 'pass' | 'fail' | 'manual_review';
