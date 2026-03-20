import { json } from '@sveltejs/kit';
import { requireAgentApiKey } from '$lib/server/api-auth';
import { connectDB, SchemaMetadata, AgentQuery, AuditLog, generateId } from '$lib/server/db';
import type { RequestHandler } from './$types';

const SCHEMA_ENTRIES = [
	{ collectionName: 'users', businessName: 'Users', businessPurpose: 'User accounts and authentication', businessDomain: 'auth' },
	{ collectionName: 'sessions', businessName: 'Sessions', businessPurpose: 'Active user sessions', businessDomain: 'auth' },
	{ collectionName: 'roles', businessName: 'Roles', businessPurpose: 'Permission roles for access control', businessDomain: 'auth' },
	{ collectionName: 'invite_tokens', businessName: 'Invite Tokens', businessPurpose: 'User invitation tokens', businessDomain: 'auth' },
	{ collectionName: 'kanban_projects', businessName: 'Kanban Projects', businessPurpose: 'Project groupings for kanban board', businessDomain: 'projects' },
	{ collectionName: 'kanban_tasks', businessName: 'Kanban Tasks', businessPurpose: 'Task tracking with status columns', businessDomain: 'projects' },
	{ collectionName: 'customers', businessName: 'Customers', businessPurpose: 'Customer records and contacts', businessDomain: 'customer' },
	{ collectionName: 'equipment', businessName: 'Equipment', businessPurpose: 'Fridges and ovens with temperature monitoring', businessDomain: 'equipment' },
	{ collectionName: 'equipment_locations', businessName: 'Equipment Locations', businessPurpose: 'Storage locations within equipment', businessDomain: 'equipment' },
	{ collectionName: 'consumables', businessName: 'Consumables', businessPurpose: 'Cooling trays and decks', businessDomain: 'equipment' },
	{ collectionName: 'opentrons_robots', businessName: 'Opentrons Robots', businessPurpose: 'Lab automation robots', businessDomain: 'equipment' },
	{ collectionName: 'documents', businessName: 'Controlled Documents', businessPurpose: 'Versioned documents with approval workflow', businessDomain: 'documents' },
	{ collectionName: 'work_instructions', businessName: 'Work Instructions', businessPurpose: 'Step-by-step assembly procedures', businessDomain: 'documents' },
	{ collectionName: 'document_repository', businessName: 'Document Repository', businessPurpose: 'File storage and organization', businessDomain: 'documents' },
	{ collectionName: 'part_definitions', businessName: 'Part Definitions', businessPurpose: 'Part catalog with inventory tracking', businessDomain: 'inventory' },
	{ collectionName: 'bom_items', businessName: 'BOM Items', businessPurpose: 'Bill of materials line items', businessDomain: 'inventory' },
	{ collectionName: 'inventory_transactions', businessName: 'Inventory Transactions', businessPurpose: 'Immutable inventory ledger entries', businessDomain: 'inventory' },
	{ collectionName: 'spus', businessName: 'SPUs', businessPurpose: 'Signal Processing Units — sacred device records', businessDomain: 'manufacturing' },
	{ collectionName: 'assembly_sessions', businessName: 'Assembly Sessions', businessPurpose: 'SPU assembly workflow sessions', businessDomain: 'manufacturing' },
	{ collectionName: 'batches', businessName: 'Batches', businessPurpose: 'Production batch groupings', businessDomain: 'manufacturing' },
	{ collectionName: 'production_runs', businessName: 'Production Runs', businessPurpose: 'Multi-unit production run tracking', businessDomain: 'manufacturing' },
	{ collectionName: 'validation_sessions', businessName: 'Validation Sessions', businessPurpose: 'SPU validation and testing sessions', businessDomain: 'manufacturing' },
	{ collectionName: 'lot_records', businessName: 'Lot Records', businessPurpose: 'Manufacturing lot tracking', businessDomain: 'manufacturing' },
	{ collectionName: 'cartridge_records', businessName: 'Cartridge Records', businessPurpose: 'Sacred cartridge lifecycle records', businessDomain: 'manufacturing' },
	{ collectionName: 'wax_filling_runs', businessName: 'Wax Filling Runs', businessPurpose: 'Wax filling robot run records', businessDomain: 'manufacturing' },
	{ collectionName: 'reagent_batch_records', businessName: 'Reagent Batch Records', businessPurpose: 'Sacred reagent filling batch records', businessDomain: 'manufacturing' },
	{ collectionName: 'process_configurations', businessName: 'Process Configurations', businessPurpose: 'Manufacturing process parameters', businessDomain: 'manufacturing' },
	{ collectionName: 'manufacturing_materials', businessName: 'Manufacturing Materials', businessPurpose: 'Raw materials inventory', businessDomain: 'manufacturing' },
	{ collectionName: 'manufacturing_material_transactions', businessName: 'Material Transactions', businessPurpose: 'Immutable material usage ledger', businessDomain: 'manufacturing' },
	{ collectionName: 'laser_cut_batches', businessName: 'Laser Cut Batches', businessPurpose: 'Laser cutting batch records', businessDomain: 'manufacturing' },
	{ collectionName: 'assay_definitions', businessName: 'Assay Definitions', businessPurpose: 'Sacred assay type definitions', businessDomain: 'manufacturing' },
	{ collectionName: 'shipping_lots', businessName: 'Shipping Lots', businessPurpose: 'Shipping lot groupings with QA release', businessDomain: 'shipping' },
	{ collectionName: 'shipping_packages', businessName: 'Shipping Packages', businessPurpose: 'Individual shipping packages with tracking', businessDomain: 'shipping' },
	{ collectionName: 'lab_cartridges', businessName: 'Lab Cartridges', businessPurpose: 'Cartridge lab testing records', businessDomain: 'cartridge_lab' },
	{ collectionName: 'cartridge_groups', businessName: 'Cartridge Groups', businessPurpose: 'Lab cartridge groupings', businessDomain: 'cartridge_lab' },
	{ collectionName: 'firmware_devices', businessName: 'Firmware Devices', businessPurpose: 'Device firmware records', businessDomain: 'cartridge_lab' },
	{ collectionName: 'firmware_cartridges', businessName: 'Firmware Cartridges', businessPurpose: 'Cartridge firmware records', businessDomain: 'cartridge_lab' },
	{ collectionName: 'test_results', businessName: 'Test Results', businessPurpose: 'Spectroscopy test result data', businessDomain: 'cartridge_lab' },
	{ collectionName: 'agent_queries', businessName: 'Agent Queries', businessPurpose: 'Saved query templates for agent', businessDomain: 'agent' },
	{ collectionName: 'schema_metadata', businessName: 'Schema Metadata', businessPurpose: 'Collection metadata for agent introspection', businessDomain: 'agent' },
	{ collectionName: 'agent_messages', businessName: 'Agent Messages', businessPurpose: 'Agent-to-user messaging', businessDomain: 'agent' },
	{ collectionName: 'routing_patterns', businessName: 'Routing Patterns', businessPurpose: 'Message routing rules', businessDomain: 'agent' },
	{ collectionName: 'approval_requests', businessName: 'Approval Requests', businessPurpose: 'Change approval workflow', businessDomain: 'agent' },
	{ collectionName: 'system_dependencies', businessName: 'System Dependencies', businessPurpose: 'System dependency mapping', businessDomain: 'agent' },
	{ collectionName: 'audit_log', businessName: 'Audit Log', businessPurpose: 'Immutable audit trail', businessDomain: 'audit' },
	{ collectionName: 'electronic_signatures', businessName: 'Electronic Signatures', businessPurpose: 'Immutable e-signature records', businessDomain: 'audit' },
	{ collectionName: 'device_events', businessName: 'Device Events', businessPurpose: 'Immutable device event log', businessDomain: 'audit' },
	{ collectionName: 'generated_barcodes', businessName: 'Generated Barcodes', businessPurpose: 'Atomic barcode generation counter', businessDomain: 'manufacturing' },
	{ collectionName: 'files', businessName: 'Files', businessPurpose: 'Uploaded file metadata', businessDomain: 'documents' },
	{ collectionName: 'particle_devices', businessName: 'Particle Devices', businessPurpose: 'IoT particle device records', businessDomain: 'equipment' },
	{ collectionName: 'integrations', businessName: 'Integrations', businessPurpose: 'External service integration config', businessDomain: 'system' },
	{ collectionName: 'manufacturing_settings', businessName: 'Manufacturing Settings', businessPurpose: 'Manufacturing configuration settings', businessDomain: 'manufacturing' },
	{ collectionName: 'bom_column_mappings', businessName: 'BOM Column Mappings', businessPurpose: 'Excel-to-BOM field mappings', businessDomain: 'inventory' },
];

const QUERY_ENTRIES = [
	{
		name: 'Low Stock Parts',
		description: 'Find parts with zero or negative inventory',
		category: 'inventory' as const,
		collectionName: 'part_definitions',
		mongoQuery: { isActive: true, inventoryCount: { $lte: 0 } },
		maxRows: 100
	},
	{
		name: 'Active Production Runs',
		description: 'List all in-progress production runs',
		category: 'manufacturing' as const,
		collectionName: 'production_runs',
		mongoQuery: { status: 'in_progress' },
		maxRows: 50
	},
	{
		name: 'Pending Approvals',
		description: 'List all pending approval requests',
		category: 'audit' as const,
		collectionName: 'approval_requests',
		mongoQuery: { status: 'pending' },
		maxRows: 50
	},
	{
		name: 'Recent Audit Entries',
		description: 'Recent audit log entries',
		category: 'audit' as const,
		collectionName: 'audit_log',
		mongoQuery: {},
		maxRows: 100
	},
	{
		name: 'Active Kanban Tasks',
		description: 'All non-archived kanban tasks',
		category: 'projects' as const,
		collectionName: 'kanban_tasks',
		mongoQuery: { archived: { $ne: true } },
		maxRows: 200
	},
	{
		name: 'Customer List',
		description: 'All active customers',
		category: 'customer' as const,
		collectionName: 'customers',
		mongoQuery: { status: 'active' },
		maxRows: 100
	},
	{
		name: 'Failed Test Results',
		description: 'Test results with failed status',
		category: 'quality' as const,
		collectionName: 'test_results',
		mongoQuery: { status: 'failed' },
		maxRows: 100
	},
	{
		name: 'Equipment Status',
		description: 'All equipment with current status',
		category: 'inventory' as const,
		collectionName: 'equipment',
		mongoQuery: {},
		maxRows: 50
	}
];

export const POST: RequestHandler = async ({ request }) => {
	requireAgentApiKey(request);
	await connectDB();

	let schemaCount = 0;
	let queryCount = 0;

	// Upsert schema metadata
	for (const entry of SCHEMA_ENTRIES) {
		await SchemaMetadata.findOneAndUpdate(
			{ collectionName: entry.collectionName },
			{ $set: { ...entry, tableName: entry.collectionName } },
			{ upsert: true }
		);
		schemaCount++;
	}

	// Upsert agent queries
	for (const entry of QUERY_ENTRIES) {
		await AgentQuery.findOneAndUpdate(
			{ name: entry.name },
			{ $set: { ...entry, isActive: true } },
			{ upsert: true }
		);
		queryCount++;
	}

	await AuditLog.create({
		_id: generateId(),
		tableName: 'schema_metadata',
		recordId: 'seed',
		action: 'INSERT',
		newData: { schemaMetadata: schemaCount, agentQueries: queryCount },
		changedAt: new Date(),
		changedBy: 'agent-api',
		reason: 'Schema and query seed'
	});

	return json({
		success: true,
		data: { schemaMetadata: schemaCount, agentQueries: queryCount }
	});
};

export const GET: RequestHandler = async ({ request }) => {
	requireAgentApiKey(request);
	return json({ success: true, data: { seeded: true } });
};
