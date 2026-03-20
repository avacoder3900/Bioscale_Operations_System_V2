/**
 * One-time migration script: Import parts from Excel BOM into MongoDB.
 *
 * - Reads SPU parts from "Inventory Tracking System" sheet (skips PT-CT-* rows)
 * - Reads Cartridge parts from "Cartridge BOM Breakdown" sheet (8 items)
 * - Adds bomType field to all existing 50 parts
 * - Cleans 4 junk rows
 * - Fixes typo: "Cartriedge Sleeve" → "Cartridge Sleeve"
 * - Does NOT overwrite existing parts, only adds missing ones
 *
 * Usage: npx tsx scripts/migrate-bom-parts.ts
 */
import mongoose from 'mongoose';
import { nanoid } from 'nanoid';
import * as dotenv from 'dotenv';
import { fileURLToPath } from 'url';
import { dirname, resolve } from 'path';
import XLSX from 'xlsx';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
dotenv.config({ path: resolve(__dirname, '..', '.env') });

const MONGODB_URI = process.env.MONGODB_URI;
if (!MONGODB_URI) {
	console.error('MONGODB_URI not found in .env');
	process.exit(1);
}

const id = () => nanoid();

// ─── Column indices (same layout for both sheets) ───────────────────
const COL = {
	ITEM: 0,
	NAME: 1,         // DESCRIPTION
	PART_NUM: 2,     // BREVITEST P/N
	CATEGORY: 3,     // CLASSIFICATION OF MATERIAL
	SUPPLIER_PN: 4,  // SUPPLIER P/N
	SUPPLIER: 5,     // SUPPLIER
	QTY_PER_UNIT: 7, // QTY PER UNIT
	UOM: 8,          // UoM
	UNIT_COST: 9,    // Cost Per Unit
	LEAD_TIME: 15,   // Lead Time (Days)
	INV_COUNT: 23    // Amount Current in Inventory for Production
};

/** Valid SPU part number prefixes */
const SPU_PREFIXES = ['PT-SPU-', 'SBA-SPU-', 'IFU-SPU-'];
/** Valid cartridge part number prefix */
const CT_PREFIX = 'PT-CT-';

function isValidSpuPN(pn: string): boolean {
	return SPU_PREFIXES.some(p => pn.startsWith(p));
}

function isJunkPN(pn: string): boolean {
	if (!pn) return true;
	if (pn.includes('TBD')) return true;
	if (pn === 'PT-SPU-XXX') return true;
	if (pn.includes('R&D VARIATIONS')) return true;
	return false;
}

function inferBomType(partNumber: string): 'spu' | 'cartridge' {
	if (partNumber.startsWith(CT_PREFIX)) return 'cartridge';
	return 'spu';
}

function parseNumber(val: unknown): number | undefined {
	if (val === undefined || val === null || val === '') return undefined;
	const n = Number(val);
	return isNaN(n) ? undefined : n;
}

function parseLeadTime(val: unknown): number | undefined {
	if (val === undefined || val === null || val === '') return undefined;
	if (typeof val === 'number') return val;
	// Handle ranges like "17 - 21" → take the first number
	const str = String(val).trim();
	if (str === 'N/A' || str === 'n/a') return undefined;
	const match = str.match(/^(\d+)/);
	return match ? Number(match[1]) : undefined;
}

function cleanString(val: unknown): string | undefined {
	if (val === undefined || val === null) return undefined;
	const s = String(val).trim();
	if (!s || s === 'N/A' || s === 'n/a' || s === 'NA') return undefined;
	return s;
}

interface PartRow {
	partNumber: string;
	name: string;
	category: string | undefined;
	supplier: string | undefined;
	supplierPartNumber: string | undefined;
	quantityPerUnit: number | undefined;
	unitOfMeasure: string | undefined;
	unitCost: string | undefined;
	leadTimeDays: number | undefined;
	inventoryCount: number;
	bomType: 'spu' | 'cartridge';
}

function extractPartFromRow(row: unknown[], bomType: 'spu' | 'cartridge'): PartRow | null {
	const pn = cleanString(row[COL.PART_NUM]);
	const name = cleanString(row[COL.NAME]);
	if (!pn || !name) return null;

	return {
		partNumber: pn,
		name,
		category: cleanString(row[COL.CATEGORY]),
		supplier: cleanString(row[COL.SUPPLIER]),
		supplierPartNumber: cleanString(row[COL.SUPPLIER_PN]),
		quantityPerUnit: parseNumber(row[COL.QTY_PER_UNIT]),
		unitOfMeasure: cleanString(row[COL.UOM]),
		unitCost: parseNumber(row[COL.UNIT_COST]) !== undefined
			? String(parseNumber(row[COL.UNIT_COST]))
			: undefined,
		leadTimeDays: parseLeadTime(row[COL.LEAD_TIME]),
		inventoryCount: parseNumber(row[COL.INV_COUNT]) ?? 0,
		bomType
	};
}

async function migrate() {
	console.log('═══════════════════════════════════════════════════');
	console.log('  BOM Parts Migration Script');
	console.log('═══════════════════════════════════════════════════\n');

	// ─── Read Excel ────────────────────────────────────────────────
	const xlsxPath = resolve(__dirname, 'data', 'bom-spreadsheet.xlsx');
	console.log(`Reading Excel file: ${xlsxPath}`);
	const wb = XLSX.readFile(xlsxPath);
	console.log(`Sheets found: ${wb.SheetNames.join(', ')}\n`);

	// ─── Extract SPU parts ─────────────────────────────────────────
	const invSheet = wb.Sheets['Inventory Tracking System'];
	if (!invSheet) {
		console.error('Sheet "Inventory Tracking System" not found!');
		process.exit(1);
	}
	const invRows = XLSX.utils.sheet_to_json(invSheet, { header: 1 }) as unknown[][];

	const spuParts = new Map<string, PartRow>();
	let skippedJunk = 0;
	let skippedCartridgeOnSpuSheet = 0;
	let skippedDuplicate = 0;

	// Skip row 0 (super-header) and row 1 (column headers), start at row 2
	for (let i = 2; i < invRows.length; i++) {
		const row = invRows[i];
		if (!row || row.length === 0) continue;

		const pn = cleanString(row[COL.PART_NUM]);
		if (!pn) continue;

		// Skip junk rows
		if (isJunkPN(pn)) {
			console.log(`  [JUNK] Row ${i}: Skipped "${pn}" (${cleanString(row[COL.NAME]) ?? 'no name'})`);
			skippedJunk++;
			continue;
		}

		// Skip PT-CT-* rows on this sheet (cartridge parts come from their own sheet)
		if (pn.startsWith(CT_PREFIX)) {
			skippedCartridgeOnSpuSheet++;
			continue;
		}

		// Only accept valid SPU part numbers
		if (!isValidSpuPN(pn)) continue;

		// Deduplicate: keep first occurrence
		if (spuParts.has(pn)) {
			skippedDuplicate++;
			continue;
		}

		const part = extractPartFromRow(row, 'spu');
		if (part) spuParts.set(pn, part);
	}

	console.log(`\nSPU parts extracted: ${spuParts.size}`);
	console.log(`  Junk rows skipped: ${skippedJunk}`);
	console.log(`  PT-CT-* rows skipped on SPU sheet: ${skippedCartridgeOnSpuSheet}`);
	console.log(`  Duplicate rows skipped: ${skippedDuplicate}`);

	// ─── Extract Cartridge parts ───────────────────────────────────
	const ctSheet = wb.Sheets['Cartridge BOM Breakdown'];
	if (!ctSheet) {
		console.error('Sheet "Cartridge BOM Breakdown" not found!');
		process.exit(1);
	}
	const ctRows = XLSX.utils.sheet_to_json(ctSheet, { header: 1 }) as unknown[][];

	const cartridgeParts = new Map<string, PartRow>();

	// Row 0 = title ("Cartridge Filling BOM"), Row 1 = headers, Row 2+ = data
	for (let i = 2; i < ctRows.length; i++) {
		const row = ctRows[i];
		if (!row || row.length === 0) continue;

		const pn = cleanString(row[COL.PART_NUM]);
		if (!pn || !pn.startsWith(CT_PREFIX)) continue;

		const part = extractPartFromRow(row, 'cartridge');
		if (part) cartridgeParts.set(pn, part);
	}

	console.log(`Cartridge parts extracted: ${cartridgeParts.size}\n`);

	// ─── Connect to MongoDB ────────────────────────────────────────
	console.log('Connecting to MongoDB...');
	await mongoose.connect(MONGODB_URI!);
	console.log('Connected!\n');
	const db = mongoose.connection.db!;
	const col = db.collection('part_definitions');

	// ─── Step 1: Clean junk rows from MongoDB ──────────────────────
	console.log('─── Cleaning junk rows ─────────────────────────────');
	const junkFilters = [
		{ partNumber: { $regex: /TBD/i } },
		{ partNumber: 'R&D VARIATIONS INVENTORY COUNT' },
		{ partNumber: 'Silver Sheet Metal Enclosure' },
		{ partNumber: 'Enclosure Front' },
		{ partNumber: 'PT-SPU-XXX' }
	];
	for (const filter of junkFilters) {
		const result = await col.deleteMany(filter);
		if (result.deletedCount > 0) {
			console.log(`  [CLEANED] Deleted ${result.deletedCount} doc(s) matching ${JSON.stringify(filter)}`);
		}
	}

	// ─── Step 2: Fix typo ──────────────────────────────────────────
	console.log('\n─── Fixing typos ───────────────────────────────────');
	const typoResult = await col.updateMany(
		{ name: 'Cartriedge Sleeve' },
		{ $set: { name: 'Cartridge Sleeve' } }
	);
	if (typoResult.modifiedCount > 0) {
		console.log(`  [FIXED] "Cartriedge Sleeve" → "Cartridge Sleeve" (${typoResult.modifiedCount} doc(s))`);
	} else {
		console.log('  No typo found in existing docs (will fix on import if needed)');
	}

	// ─── Step 3: Add bomType to all existing parts ─────────────────
	console.log('\n─── Adding bomType to existing parts ───────────────');
	const existingParts = await col.find({}).toArray();
	let bomTypeUpdated = 0;
	for (const doc of existingParts) {
		const pn = doc.partNumber as string;
		if (!pn) continue;

		const bomType = inferBomType(pn);
		if (doc.bomType !== bomType) {
			await col.updateOne({ _id: doc._id }, { $set: { bomType } });
			bomTypeUpdated++;
		}
	}
	console.log(`  Updated bomType on ${bomTypeUpdated} existing part(s)`);

	// ─── Step 4: Upsert SPU parts ──────────────────────────────────
	console.log('\n─── Importing SPU parts ─────────────────────────────');
	let addedSpu = 0;
	let skippedSpu = 0;
	for (const [pn, part] of spuParts) {
		const existing = await col.findOne({ partNumber: pn });

		// Fix typo in name before import
		let name = part.name;
		if (name === 'Cartriedge Sleeve') name = 'Cartridge Sleeve';

		if (existing) {
			// Update bomType and supplierPartNumber if missing
			const updates: Record<string, unknown> = {};
			if (!existing.bomType) updates.bomType = part.bomType;
			if (!existing.supplierPartNumber && part.supplierPartNumber) {
				updates.supplierPartNumber = part.supplierPartNumber;
			}
			if (existing.quantityPerUnit === undefined && part.quantityPerUnit !== undefined) {
				updates.quantityPerUnit = part.quantityPerUnit;
			}
			if (Object.keys(updates).length > 0) {
				await col.updateOne({ _id: existing._id }, { $set: updates });
				console.log(`  [UPDATED] ${pn}: added ${Object.keys(updates).join(', ')}`);
			} else {
				skippedSpu++;
			}
		} else {
			await col.insertOne({
				_id: id() as any,
				partNumber: pn,
				name,
				category: part.category,
				supplier: part.supplier,
				supplierPartNumber: part.supplierPartNumber,
				quantityPerUnit: part.quantityPerUnit,
				unitOfMeasure: part.unitOfMeasure,
				unitCost: part.unitCost,
				leadTimeDays: part.leadTimeDays,
				inventoryCount: part.inventoryCount,
				bomType: 'spu',
				isActive: true,
				sortOrder: 0,
				createdAt: new Date(),
				updatedAt: new Date()
			});
			console.log(`  [ADDED] ${pn}: "${name}"`);
			addedSpu++;
		}
	}
	console.log(`  SPU: ${addedSpu} added, ${skippedSpu} already existed`);

	// ─── Step 5: Upsert Cartridge parts ────────────────────────────
	console.log('\n─── Importing Cartridge parts ───────────────────────');
	let addedCt = 0;
	let skippedCt = 0;
	for (const [pn, part] of cartridgeParts) {
		const existing = await col.findOne({ partNumber: pn });

		let name = part.name;
		if (name === 'Cartriedge Sleeve') name = 'Cartridge Sleeve';

		if (existing) {
			const updates: Record<string, unknown> = {};
			if (!existing.bomType) updates.bomType = 'cartridge';
			if (!existing.supplierPartNumber && part.supplierPartNumber) {
				updates.supplierPartNumber = part.supplierPartNumber;
			}
			if (existing.quantityPerUnit === undefined && part.quantityPerUnit !== undefined) {
				updates.quantityPerUnit = part.quantityPerUnit;
			}
			if (Object.keys(updates).length > 0) {
				await col.updateOne({ _id: existing._id }, { $set: updates });
				console.log(`  [UPDATED] ${pn}: added ${Object.keys(updates).join(', ')}`);
			} else {
				skippedCt++;
			}
		} else {
			await col.insertOne({
				_id: id() as any,
				partNumber: pn,
				name,
				category: part.category,
				supplier: part.supplier,
				supplierPartNumber: part.supplierPartNumber,
				quantityPerUnit: part.quantityPerUnit,
				unitOfMeasure: part.unitOfMeasure,
				unitCost: part.unitCost,
				leadTimeDays: part.leadTimeDays,
				inventoryCount: part.inventoryCount,
				bomType: 'cartridge',
				isActive: true,
				sortOrder: 0,
				createdAt: new Date(),
				updatedAt: new Date()
			});
			console.log(`  [ADDED] ${pn}: "${name}"`);
			addedCt++;
		}
	}
	console.log(`  Cartridge: ${addedCt} added, ${skippedCt} already existed`);

	// ─── Summary ───────────────────────────────────────────────────
	const finalCount = await col.countDocuments({});
	const spuCount = await col.countDocuments({ bomType: 'spu' });
	const ctCount = await col.countDocuments({ bomType: 'cartridge' });
	const noBomType = await col.countDocuments({ bomType: { $exists: false } });

	console.log('\n═══════════════════════════════════════════════════');
	console.log('  Migration Complete');
	console.log('═══════════════════════════════════════════════════');
	console.log(`  Total parts in DB: ${finalCount}`);
	console.log(`  SPU parts: ${spuCount}`);
	console.log(`  Cartridge parts: ${ctCount}`);
	if (noBomType > 0) {
		console.log(`  ⚠ Parts without bomType: ${noBomType}`);
	}
	console.log('');

	await mongoose.disconnect();
	console.log('Disconnected from MongoDB.');
}

migrate().catch((err) => {
	console.error('Migration failed:', err);
	process.exit(1);
});
