import { fail } from '@sveltejs/kit';
import { requirePermission } from '$lib/server/permissions';
import { connectDB, Integration, BomItem } from '$lib/server/db';
import type { PageServerLoad, Actions } from './$types';

const BOM_FIELDS: { key: string; label: string; required?: boolean }[] = [
	{ key: 'partNumber', label: 'Part Number', required: true },
	{ key: 'name', label: 'Name / Description', required: true },
	{ key: 'unitCost', label: 'Unit Cost' },
	{ key: 'quantityPerUnit', label: 'Qty Per Unit' },
	{ key: 'inventoryCount', label: 'Inventory Count' },
	{ key: 'supplier', label: 'Supplier' },
	{ key: 'category', label: 'Category' },
	{ key: 'expirationDate', label: 'Expiration Date' }
];

export const load: PageServerLoad = async ({ locals }) => {
	requirePermission(locals.user, 'inventory:read');
	await connectDB();

	const boxInteg = await Integration.findOne({ type: 'box' }).lean() as any;
	const isConnected = Boolean(boxInteg?.accessToken);

	let hasFile = false;
	let previewError: string | null = null;
	let preview: {
		headers: string[];
		rows: string[][];
		sheetNames: string[];
	} | null = null;
	let mapping: {
		headerRow: number;
		sheetName: string | null;
		columnMappings: Record<string, string>;
	} | null = null;

	if (isConnected && boxInteg?.spreadsheetId) {
		hasFile = true;
		// Load existing mapping configuration if available
		const mappingConfig = boxInteg.columnMapping ?? null;
		if (mappingConfig) {
			mapping = {
				headerRow: mappingConfig.headerRow ?? 1,
				sheetName: mappingConfig.sheetName ?? null,
				columnMappings: mappingConfig.columnMappings ?? {}
			};
		} else {
			mapping = {
				headerRow: 1,
				sheetName: null,
				columnMappings: {}
			};
		}

		// Try to get preview from cached data or return empty structure
		if (boxInteg.previewData) {
			try {
				preview = JSON.parse(boxInteg.previewData);
			} catch {
				previewError = 'Failed to parse preview data';
			}
		} else {
			preview = { headers: [], rows: [], sheetNames: [] };
		}
	}

	return {
		isConnected,
		hasFile,
		previewError,
		preview,
		mapping,
		bomFields: BOM_FIELDS
	};
};

export const actions: Actions = {
	saveMapping: async ({ request, locals }) => {
		requirePermission(locals.user, 'inventory:write');
		await connectDB();

		const form = await request.formData();
		const headerRow = parseInt(form.get('headerRow')?.toString() ?? '1') || 1;
		const sheetName = form.get('sheetName')?.toString() || null;

		const columnMappings: Record<string, string> = {};
		for (const field of BOM_FIELDS) {
			const col = form.get(`mapping_${field.key}`)?.toString();
			if (col) columnMappings[field.key] = col;
		}

		const boxInteg = await Integration.findOne({ type: 'box' }).lean() as any;
		if (!boxInteg) return fail(400, { error: 'Box not configured' });

		await Integration.updateOne(
			{ type: 'box' },
			{ $set: { columnMapping: { headerRow, sheetName, columnMappings } } }
		);

		return { message: 'Mapping saved successfully' };
	}
};

export const config = { maxDuration: 60 };
