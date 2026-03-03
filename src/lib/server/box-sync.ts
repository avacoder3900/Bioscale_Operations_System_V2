/**
 * Box Excel Sync for SPU Parts
 *
 * Downloads the "Live Equipment Overview" Excel file from Box,
 * parses it with the xlsx library, and upserts rows into PartDefinition.
 */
import * as XLSX from 'xlsx';
import { connectDB, Integration, PartDefinition } from '$lib/server/db';
import { downloadFile, searchFiles } from '$lib/server/box';

// ---------------------------------------------------------------------------
// Column header candidates (case-insensitive matching)
// ---------------------------------------------------------------------------
const PART_NUMBER_CANDIDATES = ['part number', 'part no', 'part no.', 'pn', 'item number', 'item no', 'part#', 'partno'];
const NAME_CANDIDATES = ['name', 'part name', 'description', 'item description', 'item name', 'component'];
const QTY_CANDIDATES = ['qty', 'quantity', 'stock qty', 'on hand', 'inventory', 'count', 'qty on hand', 'stock'];
const PRICE_CANDIDATES = ['price', 'unit cost', 'cost', 'unit price', 'each', 'unit', 'price each'];
const SUPPLIER_CANDIDATES = ['supplier', 'vendor', 'manufacturer', 'source'];

/** Find the first header key from the row that matches one of the candidates */
function findColumn(headers: string[], candidates: string[]): string | null {
	for (const header of headers) {
		const normalized = header.toLowerCase().trim();
		if (candidates.some(c => normalized === c || normalized.includes(c))) {
			return header;
		}
	}
	return null;
}

/** Parse a number from a cell value (handles $, commas, whitespace) */
function parseNumber(val: unknown): number {
	if (val == null) return 0;
	if (typeof val === 'number') return isNaN(val) ? 0 : val;
	const str = String(val).replace(/[$,\s]/g, '');
	const n = parseFloat(str);
	return isNaN(n) ? 0 : n;
}

/** Parse a string value from a cell */
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

/** Main sync function — finds, downloads, parses, and upserts parts from Box */
export async function syncPartsFromBox(): Promise<SyncResult> {
	await connectDB();

	// ------------------------------------------------------------------
	// 1. Find the Excel file in Box
	// ------------------------------------------------------------------
	const boxInteg = await Integration.findOne({ type: 'box' }).lean() as any;
	if (!boxInteg?.accessToken) {
		throw new Error('Box integration not configured — connect Box first');
	}

	let fileId: string = boxInteg.spreadsheetId ?? '';
	let fileName = '';

	if (!fileId) {
		// Search for the file by name
		console.log('[box-sync] Searching Box for "Live Equipment Overview"...');
		const results = await searchFiles('Live Equipment Overview');
		console.log(`[box-sync] Search returned ${results.length} result(s):`, results.map(r => r.name));

		if (results.length === 0) {
			throw new Error('Could not find "Live Equipment Overview" file in Box. Make sure the file exists and is accessible.');
		}

		// Pick the first Excel file (.xlsx / .xls)
		const excelFile = results.find(r =>
			r.name.toLowerCase().endsWith('.xlsx') ||
			r.name.toLowerCase().endsWith('.xls')
		) ?? results[0];

		fileId = excelFile.id;
		fileName = excelFile.name;
	} else {
		fileName = `(cached file id: ${fileId})`;
	}

	// ------------------------------------------------------------------
	// 2. Download the file
	// ------------------------------------------------------------------
	console.log(`[box-sync] Downloading file id=${fileId} name="${fileName}"...`);
	const response = await downloadFile(fileId);
	const arrayBuffer = await response.arrayBuffer();
	const uint8Array = new Uint8Array(arrayBuffer);

	// ------------------------------------------------------------------
	// 3. Parse with xlsx
	// ------------------------------------------------------------------
	const workbook = XLSX.read(uint8Array, { type: 'buffer', cellDates: true });
	const sheetName = workbook.SheetNames[0];
	const worksheet = workbook.Sheets[sheetName];

	// Convert to array of objects (header row → keys)
	const rows: Record<string, unknown>[] = XLSX.utils.sheet_to_json(worksheet, {
		defval: null,
		raw: false  // format dates/numbers as strings initially
	});

	if (rows.length === 0) {
		throw new Error(`Excel sheet "${sheetName}" is empty or has no data rows`);
	}

	// Collect actual headers from the first row
	const headers = Object.keys(rows[0]);
	console.log(`[box-sync] Sheet: "${sheetName}" | Rows: ${rows.length} | Headers:`, headers);

	// ------------------------------------------------------------------
	// 4. Build column map
	// ------------------------------------------------------------------
	const colPartNumber = findColumn(headers, PART_NUMBER_CANDIDATES);
	const colName = findColumn(headers, NAME_CANDIDATES);
	const colQty = findColumn(headers, QTY_CANDIDATES);
	const colPrice = findColumn(headers, PRICE_CANDIDATES);
	const colSupplier = findColumn(headers, SUPPLIER_CANDIDATES);

	const columnMap: Record<string, string> = {};
	if (colPartNumber) columnMap.partNumber = colPartNumber;
	if (colName) columnMap.name = colName;
	if (colQty) columnMap.inventoryCount = colQty;
	if (colPrice) columnMap.unitCost = colPrice;
	if (colSupplier) columnMap.supplier = colSupplier;

	console.log('[box-sync] Column map:', columnMap);

	if (!colPartNumber && !colName) {
		throw new Error(
			`Could not find a part number or name column. Available headers: ${headers.join(', ')}`
		);
	}

	// ------------------------------------------------------------------
	// 5. Upsert parts
	// ------------------------------------------------------------------
	let upserted = 0;
	let skipped = 0;
	const errors: string[] = [];

	for (const row of rows) {
		try {
			const rawPartNumber = colPartNumber ? parseString(row[colPartNumber]) : '';
			const rawName = colName ? parseString(row[colName]) : '';

			// Use part number as primary key; fall back to name if no part number column
			const partNumber = rawPartNumber || rawName;
			if (!partNumber) {
				skipped++;
				continue;
			}

			const update: Record<string, unknown> = {
				partNumber,
				name: rawName || rawPartNumber
			};

			if (colQty) {
				update.inventoryCount = parseNumber(row[colQty]);
			}
			if (colPrice) {
				const price = parseString(row[colPrice]);
				if (price) update.unitCost = price.replace(/[$]/g, '').trim();
			}
			if (colSupplier) {
				const supplier = parseString(row[colSupplier]);
				if (supplier) update.supplier = supplier;
			}

			await PartDefinition.updateOne(
				{ partNumber },
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

	// ------------------------------------------------------------------
	// 6. Update Integration doc
	// ------------------------------------------------------------------
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
