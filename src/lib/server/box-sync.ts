/**
 * Box Excel Sync for SPU Parts
 *
 * Downloads "Live Equipment Overview.xlsx" from Box (file ID 1990254823135),
 * parses multiple sheets, and upserts rows into PartDefinition.
 *
 * Primary data source: "Add Inventory Here!" sheet
 *   - Part name, Brevitest Part Number, Total Amount Added (qty)
 *
 * Enrichment source: "Inventory Tracking System" sheet (Row 1 = headers in data)
 *   - Cost Per Unit, Supplier, QTY PER UNIT, Classification, Lead Time, etc.
 *
 * Net inventory: "Manually Subtract Here!" sheet
 *   - "Total Amount Remaining in Inventory" = final count after subtractions
 */
import * as XLSX from 'xlsx';
import { connectDB, Integration, PartDefinition } from '$lib/server/db';
import { downloadFile } from '$lib/server/box';

/** Parse a number from a cell value (handles $, commas, whitespace) */
function parseNumber(val: unknown): number {
	if (val == null) return 0;
	if (typeof val === 'number') return isNaN(val) ? 0 : val;
	const str = String(val).replace(/[$,\s]/g, '');
	const n = parseFloat(str);
	return isNaN(n) ? 0 : n;
}

function parseString(val: unknown): string {
	if (val == null) return '';
	return String(val).trim();
}

export interface SyncResult {
	upserted: number;
	skipped: number;
	errors: string[];
	columnMap: Record<string, string>;
	fileId: string;
	fileName: string;
}

/**
 * Parse the "Inventory Tracking System" sheet which has a non-standard layout:
 * Row 0 in JSON = the header row (values are in __EMPTY, __EMPTY_1, etc.)
 * Row 1+ = actual data rows with same __EMPTY keys
 *
 * Header mapping from Row 0:
 *   __EMPTY = "Item" (row number)
 *   PRODUCTION BOM AND INVENTORY COUNT = "DESCRIPTION"
 *   __EMPTY_1 = "BREVITEST P/N"
 *   __EMPTY_2 = "CLASSIFICATION OF MATERIAL"
 *   __EMPTY_3 = "SUPPLIER P/N"
 *   __EMPTY_4 = "SUPPLIER"
 *   __EMPTY_6 = "QTY PER UNIT"
 *   __EMPTY_7 = "UoM"
 *   __EMPTY_8 = "Cost Per Unit"
 *   __EMPTY_14 = "Lead Time (Days)"
 *   __EMPTY_22 = "Amount Current in Inventory for Production"
 */
function parseInventoryTrackingSheet(workbook: XLSX.WorkBook): Map<string, Record<string, unknown>> {
	const map = new Map<string, Record<string, unknown>>();
	const ws = workbook.Sheets['Inventory Tracking System'];
	if (!ws) return map;

	const rows: Record<string, unknown>[] = XLSX.utils.sheet_to_json(ws, { defval: null, raw: false });
	if (rows.length < 2) return map;

	// Skip row 0 (it's the header row embedded in data)
	for (let i = 1; i < rows.length; i++) {
		const row = rows[i];
		const partNumber = parseString(row['__EMPTY_1']); // BREVITEST P/N
		if (!partNumber || partNumber === 'BREVITEST P/N') continue;

		map.set(partNumber, {
			name: parseString(row['PRODUCTION BOM AND INVENTORY COUNT']),
			category: parseString(row['__EMPTY_2']),
			supplierPartNumber: parseString(row['__EMPTY_3']),
			supplier: parseString(row['__EMPTY_4']),
			qtyPerUnit: parseNumber(row['__EMPTY_6']),
			unitOfMeasure: parseString(row['__EMPTY_7']),
			unitCost: parseString(row['__EMPTY_8']),
			leadTimeDays: parseString(row['__EMPTY_14']),
			inventoryCount: parseNumber(row['__EMPTY_22']),
		});
	}

	return map;
}

/**
 * Parse "Manually Subtract Here!" sheet for net inventory remaining.
 * Returns map of partNumber → remaining inventory count.
 */
function parseSubtractSheet(workbook: XLSX.WorkBook): Map<string, number> {
	const map = new Map<string, number>();
	const ws = workbook.Sheets['Manually Subtract Here!'];
	if (!ws) return map;

	const rows: Record<string, unknown>[] = XLSX.utils.sheet_to_json(ws, { defval: null, raw: false });

	for (const row of rows) {
		const partNumber = parseString(row['Brevitest Part Number']);
		const remaining = parseNumber(row['Total Amount Remaining in Inventory']);
		if (partNumber) {
			map.set(partNumber, remaining);
		}
	}

	return map;
}

/** Main sync function */
export async function syncPartsFromBox(): Promise<SyncResult> {
	await connectDB();

	const boxInteg = await Integration.findOne({ type: 'box' }).lean() as any;
	if (!boxInteg?.accessToken) {
		throw new Error('Box integration not configured — connect Box first');
	}

	const fileId = boxInteg.spreadsheetId || '1990254823135';
	const fileName = 'Live Equipment Overview.xlsx';

	// Download
	console.log(`[box-sync] Downloading file id=${fileId}...`);
	const response = await downloadFile(fileId);
	const arrayBuffer = await response.arrayBuffer();
	const workbook = XLSX.read(new Uint8Array(arrayBuffer), { type: 'buffer', cellDates: true });

	console.log(`[box-sync] Sheets found:`, workbook.SheetNames);

	// Primary source: "Inventory Tracking System" sheet
	// Row 0 in JSON = embedded headers, Row 1+ = data
	// Column keys are __EMPTY_N mapped to real field names
	const primarySheet = workbook.Sheets['Inventory Tracking System'];
	if (!primarySheet) {
		throw new Error('Sheet "Inventory Tracking System" not found in workbook');
	}

	const allRows: Record<string, unknown>[] = XLSX.utils.sheet_to_json(primarySheet, { defval: null, raw: false });
	// Skip row 0 (header row embedded in data)
	const rows = allRows.slice(1);
	console.log(`[box-sync] Inventory Tracking System: ${rows.length} data rows (skipped header row)`);

	// Parse net inventory from "Manually Subtract Here!" for actual remaining count
	const netInventory = parseSubtractSheet(workbook);
	console.log(`[box-sync] Net inventory: ${netInventory.size} parts from Manually Subtract Here!`);

	const columnMap: Record<string, string> = {
		name: 'PRODUCTION BOM AND INVENTORY COUNT (DESCRIPTION)',
		partNumber: '__EMPTY_1 (BREVITEST P/N)',
		category: '__EMPTY_2 (CLASSIFICATION OF MATERIAL)',
		vendorPartNumber: '__EMPTY_3 (SUPPLIER P/N)',
		supplier: '__EMPTY_4 (SUPPLIER)',
		qtyPerUnit: '__EMPTY_6 (QTY PER UNIT)',
		unitOfMeasure: '__EMPTY_7 (UoM)',
		unitCost: '__EMPTY_8 (Cost Per Unit)',
		leadTimeDays: '__EMPTY_14 (Lead Time Days)',
		inventoryCount: '__EMPTY_22 (Amount Current in Inventory) + net from subtract sheet'
	};

	let upserted = 0;
	let skipped = 0;
	const errors: string[] = [];

	for (const row of rows) {
		try {
			const partNumber = parseString(row['__EMPTY_1']); // BREVITEST P/N
			const partName = parseString(row['PRODUCTION BOM AND INVENTORY COUNT']); // DESCRIPTION

			if (!partNumber && !partName) {
				skipped++;
				continue;
			}
			// Skip if it looks like a sub-header or section label
			if (partNumber === 'BREVITEST P/N') {
				skipped++;
				continue;
			}

			const key = partNumber || partName;
			const netQty = netInventory.get(partNumber);

			const update: Record<string, unknown> = {
				partNumber: key,
				name: partName || key,
			};

			// Inventory: prefer net remaining (subtract sheet), else current inventory column
			if (netQty != null) {
				update.inventoryCount = netQty;
			} else {
				update.inventoryCount = parseNumber(row['__EMPTY_22']);
			}

			// Cost Per Unit
			const cost = parseString(row['__EMPTY_8']);
			if (cost && cost !== 'Cost Per Unit') {
				update.unitCost = cost.replace(/[$]/g, '').trim();
			}

			// Supplier
			const supplier = parseString(row['__EMPTY_4']);
			if (supplier && supplier !== 'SUPPLIER') {
				update.supplier = supplier;
			}

			// Classification / Category
			const category = parseString(row['__EMPTY_2']);
			if (category && category !== 'CLASSIFICATION OF MATERIAL') {
				update.category = category;
			}

			// Qty per unit
			const qpu = parseNumber(row['__EMPTY_6']);
			if (qpu > 0) {
				update.quantityPerUnit = qpu;
			}

			// Unit of measure
			const uom = parseString(row['__EMPTY_7']);
			if (uom && uom !== 'UoM') {
				update.unitOfMeasure = uom;
			}

			// Lead time (days) — skip "N/A"
			const lt = parseString(row['__EMPTY_14']);
			if (lt && lt !== 'N/A' && lt !== 'Lead Time (Days)') {
				const ltNum = parseNumber(lt);
				if (ltNum > 0) update.leadTimeDays = ltNum;
			}

			// Supplier Part Number
			const spn = parseString(row['__EMPTY_3']);
			if (spn && spn !== 'N/A' && spn !== 'SUPPLIER P/N') {
				update.vendorPartNumber = spn;
			}

			await PartDefinition.updateOne(
				{ partNumber: key },
				{ $set: update },
				{ upsert: true }
			);
			upserted++;
		} catch (err: any) {
			const msg = err?.message ?? String(err);
			errors.push(msg);
			if (errors.length <= 5) {
				console.error('[box-sync] Row error:', msg);
			}
		}
	}

	// Update Integration doc
	await Integration.updateOne(
		{ type: 'box' },
		{
			$set: {
				spreadsheetId: fileId,
				lastSyncAt: new Date(),
				lastSyncStatus: errors.length === 0 ? 'success' : 'partial',
				lastSyncError: errors.length > 0 ? errors.slice(0, 3).join('; ') : null
			}
		}
	);

	console.log(`[box-sync] Done. Upserted: ${upserted}, Skipped: ${skipped}, Errors: ${errors.length}`);
	return { upserted, skipped, errors, columnMap, fileId, fileName };
}
