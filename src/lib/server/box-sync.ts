/**
 * Box Excel Sync for SPU Parts
 *
 * Downloads "Live Equipment Overview.xlsx" from Box (file ID 1990254823135),
 * parses "Inventory Tracking System" sheet, and upserts into PartDefinition.
 *
 * Sheet layout:
 *   Row 0 = Title ("PRODUCTION BOM AND INVENTORY COUNT")
 *   Row 1 = Column headers
 *   Row 2–80 = Data
 *
 * Column mapping (by index):
 *   A (0)  = Item number
 *   B (1)  = DESCRIPTION (name)
 *   C (2)  = BREVITEST P/N (partNumber)
 *   D (3)  = CLASSIFICATION OF MATERIAL (category)
 *   E (4)  = SUPPLIER P/N (vendorPartNumber)
 *   F (5)  = SUPPLIER
 *   G (6)  = CURRENT DRW VERSION
 *   H (7)  = QTY PER UNIT
 *   I (8)  = UoM (unitOfMeasure)
 *   J (9)  = Cost Per Unit
 *   K (10) = Shipping Cost (per unit)
 *   L (11) = Cost Per Unit + Shipping
 *   M (12) = Sales Tax (8.25%)
 *   N (13) = Total Cost Per Unit (unitCost)
 *   O (14) = Extended Cost
 *   P (15) = Lead Time (Days)
 *   Q (16) = Part Dependent on Another?
 *   R (17) = If so, which one?
 *   S (18) = Total Lead Time (incl manufacturing)
 *   T (19) = Notes
 *   U (20) = Limiting Inventory (# of SPUs)
 *   V (21) = # of Items in Order Unit
 *   W (22) = Mold/Custom Part Confirmed
 *   X (23) = Amount Current in Inventory for Production
 *   Y-AJ   = Ordering/purchasing columns
 */
import * as XLSX from 'xlsx';
import { connectDB, Integration, PartDefinition } from '$lib/server/db';
import { downloadFile } from '$lib/server/box';

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

export async function syncPartsFromBox(): Promise<SyncResult> {
	await connectDB();

	const boxInteg = await Integration.findOne({ type: 'box' }).lean() as any;
	if (!boxInteg?.accessToken) {
		throw new Error('Box integration not configured — connect Box first');
	}

	const fileId = boxInteg.spreadsheetId || '1990254823135';
	const fileName = 'Live Equipment Overview.xlsx';

	console.log(`[box-sync] Downloading file id=${fileId}...`);
	const response = await downloadFile(fileId);
	const arrayBuffer = await response.arrayBuffer();
	const workbook = XLSX.read(new Uint8Array(arrayBuffer), { type: 'buffer', cellDates: true });

	console.log(`[box-sync] Sheets found:`, workbook.SheetNames);

	const ws = workbook.Sheets['Inventory Tracking System'];
	if (!ws) throw new Error('Sheet "Inventory Tracking System" not found');

	// Use header:1 mode → array of arrays, raw values
	const allRows: (unknown[])[] = XLSX.utils.sheet_to_json(ws, { header: 1, raw: true, defval: null });

	// Row 0 = title, Row 1 = headers, Row 2+ = data, stop at row 80
	const dataRows = allRows.slice(2, 81); // rows 2-80 inclusive
	console.log(`[box-sync] Data rows to process: ${dataRows.length}`);

	// Debug: log first 3 rows
	for (let i = 0; i < Math.min(3, dataRows.length); i++) {
		const r = dataRows[i];
		console.log(`[box-sync] Row ${i}: B="${r[1]}" C="${r[2]}" X="${r[23]}"`);
	}

	// Clean sync: delete all existing part definitions
	const deleteResult = await PartDefinition.deleteMany({});
	console.log(`[box-sync] Cleared ${deleteResult.deletedCount} existing part definitions`);

	const columnMap: Record<string, string> = {
		name: 'B (col 1) — DESCRIPTION',
		partNumber: 'C (col 2) — BREVITEST P/N',
		category: 'D (col 3) — CLASSIFICATION',
		vendorPartNumber: 'E (col 4) — SUPPLIER P/N',
		supplier: 'F (col 5) — SUPPLIER',
		qtyPerUnit: 'H (col 7) — QTY PER UNIT',
		unitOfMeasure: 'I (col 8) — UoM',
		unitCost: 'N (col 13) — Total Cost Per Unit',
		leadTimeDays: 'P (col 15) — Lead Time (Days)',
		limitingInventory: 'U (col 20) — Limiting Inventory (# SPUs)',
		orderUnitSize: 'V (col 21) — # Items in Order Unit',
		moldConfirmed: 'W (col 22) — Mold/Custom Confirmed',
		inventoryCount: 'X (col 23) — Amount Current in Inventory'
	};

	let upserted = 0;
	let skipped = 0;
	const errors: string[] = [];

	for (const row of dataRows) {
		try {
			const name = parseString(row[1]);         // B — DESCRIPTION
			const partNumber = parseString(row[2]);    // C — BREVITEST P/N

			// Skip empty rows or sub-headers
			if (!name && !partNumber) { skipped++; continue; }
			if (name === 'DESCRIPTION' || partNumber === 'BREVITEST P/N') { skipped++; continue; }

			const update: Record<string, unknown> = {
				name,
				partNumber: partNumber || null,
				category: parseString(row[3]) || null,
				vendorPartNumber: parseString(row[4]) || null,
				supplier: parseString(row[5]) || null,
				qtyPerUnit: parseNumber(row[7]) || null,
				unitOfMeasure: parseString(row[8]) || null,
				unitCost: parseNumber(row[13]) || null,
				leadTimeDays: row[15] != null && row[15] !== 'N/A' ? parseNumber(row[15]) || null : null,
				inventoryCount: parseNumber(row[23]),
			};

			// Upsert by partNumber if available, otherwise by name
			const filter = partNumber
				? { partNumber }
				: { name, $or: [{ partNumber: null }, { partNumber: '' }, { partNumber: { $exists: false } }] };

			await PartDefinition.updateOne(filter, { $set: update }, { upsert: true });
			upserted++;
		} catch (err: any) {
			errors.push(err?.message ?? String(err));
			if (errors.length <= 5) console.error('[box-sync] Row error:', err?.message);
		}
	}

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
