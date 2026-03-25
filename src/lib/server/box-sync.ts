/**
 * Box Excel Sync for SPU Parts
 *
 * Downloads "Live Equipment Overview.xlsx" from Box (file ID 1990254823135),
 * parses "Inventory Tracking System" sheet, and upserts into PartDefinition.
 *
 * Sheet layout (verified from actual file dump):
 *   Row 0 = Title ("PRODUCTION BOM AND INVENTORY COUNT")
 *   Row 1 = Column headers
 *   Row 2-80 = Data
 *
 * Column mapping (by index):
 *   B (1)  = DESCRIPTION (name)
 *   C (2)  = BREVITEST P/N (partNumber)
 *   D (3)  = CLASSIFICATION OF MATERIAL (category)
 *   E (4)  = SUPPLIER P/N (vendorPartNumber)
 *   F (5)  = SUPPLIER
 *   H (7)  = QTY PER UNIT
 *   I (8)  = UoM (unitOfMeasure)
 *   N (13) = Total Cost Per Unit (unitCost)
 *   P (15) = Lead Time (Days)
 *   X (23) = Amount Current in Inventory for Production
 */
import * as XLSX from 'xlsx';
import { connectDB, Integration, PartDefinition, AuditLog, generateId } from '$lib/server/db';
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
	created: number;
	updated: number;
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
		throw new Error('Box integration not configured - connect Box first');
	}

	const fileId = boxInteg.spreadsheetId || '1990254823135';
	const fileName = 'Live Equipment Overview.xlsx';

	console.log(`[box-sync] Downloading file id=${fileId}...`);
	const response = await downloadFile(fileId);
	const arrayBuffer = await response.arrayBuffer();
	const workbook = XLSX.read(new Uint8Array(arrayBuffer), { type: 'buffer', cellDates: true });

	const ws = workbook.Sheets['Inventory Tracking System'];
	if (!ws) throw new Error('Sheet "Inventory Tracking System" not found');

	const allRows: (unknown[])[] = XLSX.utils.sheet_to_json(ws, { header: 1, raw: true, defval: null });

	// Row 0 = title, Row 1 = headers, Row 2+ = data, stop at row 80
	const dataRows = allRows.slice(2, 81);
	console.log(`[box-sync] Data rows to process: ${dataRows.length}`);

	for (let i = 0; i < Math.min(3, dataRows.length); i++) {
		const r = dataRows[i];
		console.log(`[box-sync] Row ${i}: name="${r[1]}" partNum="${r[2]}" inventory=${r[23]}`);
	}

	const columnMap: Record<string, string> = {
		name: 'B (1) - DESCRIPTION',
		partNumber: 'C (2) - BREVITEST P/N',
		category: 'D (3) - CLASSIFICATION',
		vendorPartNumber: 'E (4) - SUPPLIER P/N',
		supplier: 'F (5) - SUPPLIER',
		qtyPerUnit: 'H (7) - QTY PER UNIT',
		unitOfMeasure: 'I (8) - UoM',
		unitCost: 'N (13) - Total Cost Per Unit',
		leadTimeDays: 'P (15) - Lead Time',
		inventoryCount: 'X (23) - Amount Current in Inventory'
	};

	let created = 0;
	let updated = 0;
	let skipped = 0;
	const errors: string[] = [];

	for (const row of dataRows) {
		try {
			const name = parseString(row[1]);
			const partNumber = parseString(row[2]);

			if (!name && !partNumber) { skipped++; continue; }
			if (name === 'DESCRIPTION' || partNumber === 'BREVITEST P/N') { skipped++; continue; }

			// Skip rows that only have a name but no other data
			const hasPartNumber = !!partNumber;
			const hasCategory = !!parseString(row[3]);
			const hasSupplier = !!parseString(row[5]);
			const hasCost = parseNumber(row[13]) > 0;
			const hasInventory = parseNumber(row[23]) > 0;
			const hasQty = parseNumber(row[7]) > 0;
			if (!hasPartNumber && !hasCategory && !hasSupplier && !hasCost && !hasInventory && !hasQty) {
				skipped++;
				continue;
			}

			// Fields that Box always overwrites
			const boxFields: Record<string, unknown> = {
				name,
				category: parseString(row[3]) || null,
				supplier: parseString(row[5]) || null,
				vendorPartNumber: parseString(row[4]) || null,
				unitCost: parseNumber(row[13]) || null,
				leadTimeDays: row[15] != null && row[15] !== 'N/A' ? parseNumber(row[15]) || null : null,
				unitOfMeasure: parseString(row[8]) || null,
				quantityPerUnit: parseNumber(row[7]) || null,
				lastBoxSyncAt: new Date()
			};

			// Fields only set on insert (not overwritten if part already exists)
			const onInsertFields: Record<string, unknown> = {
				partNumber: partNumber || null,
				inventoryCount: parseNumber(row[23]),
				isActive: true
			};
			// Never overwritten by sync: barcode, bomType, isActive, sampleSize, percentAccepted, scanRequired, inspectionPathway

			const filter = partNumber
				? { partNumber }
				: { name, $or: [{ partNumber: null }, { partNumber: '' }, { partNumber: { $exists: false } }] };

			const result = await PartDefinition.updateOne(
				filter,
				{ $set: boxFields, $setOnInsert: onInsertFields },
				{ upsert: true }
			);

			if (result.upsertedCount > 0) {
				created++;
			} else {
				updated++;
			}
		} catch (err: any) {
			errors.push(err?.message ?? String(err));
			if (errors.length <= 5) console.error('[box-sync] Row error:', err?.message);
		}
	}

	// Log sync activity to AuditLog
	await AuditLog.create({
		_id: generateId(),
		tableName: 'part_definitions',
		recordId: 'box-sync',
		action: 'SYNC',
		oldData: null,
		newData: { created, updated, skipped, errors: errors.length },
		changedAt: new Date(),
		changedBy: 'system:box-sync',
		reason: `Box sync: ${created} created, ${updated} updated, ${skipped} skipped, ${errors.length} errors`
	});

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

	console.log(`[box-sync] Done. Created: ${created}, Updated: ${updated}, Skipped: ${skipped}, Errors: ${errors.length}`);
	return { created, updated, skipped, errors, columnMap, fileId, fileName };
}
