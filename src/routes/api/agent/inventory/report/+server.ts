import { json, error } from '@sveltejs/kit';
import { requireAgentApiKey } from '$lib/server/api-auth';
import { connectDB, PartDefinition, AuditLog, generateId } from '$lib/server/db';
import { generateReportPdf, type PdfColumn } from '$lib/server/services/pdf-report';
import { buildXlsx, XLSX_CONTENT_TYPE, type XlsxCell } from '$lib/server/services/xlsx';
import { uploadViaWorker, uploadToR2 } from '$lib/server/services/r2';
import type { RequestHandler } from './$types';

const SCOPES = ['spu-bom', 'general', 'cartridge', 'all'] as const;
type Scope = (typeof SCOPES)[number];

const SCOPE_TITLES: Record<Scope, string> = {
	'spu-bom': 'SPU Parts Bill of Materials',
	general: 'General Inventory (Non-BOM)',
	cartridge: 'Cartridge Parts',
	all: 'All Parts'
};

function escapeRegex(s: string): string {
	return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

const money = (v: number | null): string =>
	v === null ? '-' : `$${v.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

/**
 * Inventory count report for agents. Mirrors the BIMS parts page: summary
 * tiles (Total Parts / Classifications / Total Inventory Value / Low Stock),
 * a Needs Attention low-stock section, and the full table with the same
 * columns as the UI (Name, Part #, Classification, Manufacturer, Qty/Unit,
 * Inventory, Unit Cost, Total Value, Lead Time).
 *
 * POST { scope?, category?, lowStockOnly?, format? }
 * - scope: 'spu-bom' (default — the SPU Parts Bill of Materials), 'general'
 *   (General Inventory / non-BOM), 'cartridge', or 'all'.
 * - category: exact classification filter, e.g. 'Critical'.
 * - lowStockOnly: restrict to parts with inventoryCount <= 0.
 * - format: 'pdf' (default), 'csv', 'json', or 'xlsx' — all render the same
 *   BIMS-page content to a file, upload it to R2, and return the public URL.
 *   xlsx uses native numeric cells so Excel can sort/sum costs.
 *   'data' returns the rows inline in the response instead of building a file.
 */
export const POST: RequestHandler = async ({ request }) => {
	requireAgentApiKey(request);
	await connectDB();

	const body = await request.json().catch(() => ({}));
	const scope: Scope = SCOPES.includes(body.scope) ? body.scope : 'spu-bom';
	const category: string | undefined = typeof body.category === 'string' && body.category.trim()
		? body.category.trim()
		: undefined;
	const lowStockOnly = body.lowStockOnly === true;
	const format: 'pdf' | 'csv' | 'json' | 'xlsx' | 'data' = ['csv', 'json', 'xlsx', 'data'].includes(
		body.format
	)
		? body.format
		: 'pdf';

	const filter: Record<string, unknown> = { isActive: { $ne: false } };
	if (scope === 'spu-bom' || scope === 'general') {
		filter.$or = [{ bomType: 'spu' }, { bomType: { $exists: false } }];
	} else if (scope === 'cartridge') {
		filter.bomType = 'cartridge';
	}
	if (category) filter.category = new RegExp(`^${escapeRegex(category)}$`, 'i');
	if (lowStockOnly) filter.inventoryCount = { $lte: 0 };

	let parts = (await PartDefinition.find(filter)
		.sort({ sortOrder: 1, partNumber: 1 })
		.lean()) as any[];
	// isBom is a data-only flag (not in the schema): the parts page treats
	// isBom === false as General Inventory and everything else as BOM.
	if (scope === 'spu-bom') parts = parts.filter((p) => p.isBom !== false);
	if (scope === 'general') parts = parts.filter((p) => p.isBom === false);

	const allRows = parts.map((p) => {
		const count = p.inventoryCount ?? 0;
		// unitCost is stored as a string; tolerate "$"/"," formatting.
		const parsed = parseFloat(String(p.unitCost ?? '').replace(/[^0-9.\-]/g, ''));
		const cost = Number.isFinite(parsed) ? parsed : null;
		return {
			partNumber: p.partNumber ?? '',
			name: p.name ?? '',
			category: p.category ?? '',
			manufacturer: p.manufacturer ?? '',
			supplier: p.supplier ?? '',
			quantityPerUnit: p.quantityPerUnit ?? null,
			unitOfMeasure: p.unitOfMeasure ?? '',
			leadTimeDays: p.leadTimeDays ?? null,
			minimumStockLevel: p.minimumOrderQty ?? 0,
			inventoryCount: count,
			unitCost: cost,
			totalValue: cost === null ? null : Math.round(cost * count * 100) / 100
		};
	});

	// Match the BIMS parts page: the SPU BOM view lists only parts with cost
	// data (unitCost > 0) — no-cost parts are excluded from the table and the
	// stat tiles, but still surface in the Low Inventory panel.
	const rows =
		scope === 'spu-bom' ? allRows.filter((r) => r.unitCost !== null && r.unitCost > 0) : allRows;
	const excludedNoCost = allRows.filter((r) => !rows.includes(r));

	const totalUnits = rows.reduce((s, r) => s + r.inventoryCount, 0);
	const totalValue = rows.reduce((s, r) => s + (r.totalValue ?? 0), 0);
	// The page's Low Stock tile counts parts below their minimum stock level.
	const belowMin = rows.filter(
		(r) => r.minimumStockLevel > 0 && r.inventoryCount < r.minimumStockLevel
	);
	// The page's Low Inventory panel: zero/negative (from ALL parts) + the 10
	// lowest positive counts.
	const zeroOrNegative = allRows
		.filter((r) => r.inventoryCount <= 0)
		.sort((a, b) => a.inventoryCount - b.inventoryCount);
	const lowPositive = rows
		.filter((r) => r.inventoryCount > 0)
		.sort((a, b) => a.inventoryCount - b.inventoryCount)
		.slice(0, 10);
	const classifications = new Set(allRows.map((r) => r.category).filter(Boolean));

	const filtersApplied = [
		category ? `classification: ${category}` : null,
		lowStockOnly ? 'low stock only (count on hand <= 0)' : null
	].filter(Boolean) as string[];

	const summary = {
		scope,
		scopeTitle: SCOPE_TITLES[scope],
		filtersApplied,
		partCount: rows.length,
		classificationCount: classifications.size,
		totalUnits,
		totalInventoryValue: Math.round(totalValue * 100) / 100,
		lowStockCount: belowMin.length,
		zeroOrBelowCount: zeroOrNegative.length,
		partsWithoutCostData: excludedNoCost.length
	};

	if (format === 'data') {
		return json({
			success: true,
			data: {
				...summary,
				rows,
				excludedNoCostParts: excludedNoCost.map((r) => ({
					partNumber: r.partNumber,
					name: r.name,
					inventoryCount: r.inventoryCount
				}))
			}
		});
	}

	// Same column set and order as the BIMS parts page table.
	const mainColumns: PdfColumn[] = [
		{ header: 'Name', x: 40, maxChars: 51 },
		{ header: 'Part #', x: 292, maxChars: 14 },
		{ header: 'Classification', x: 366, maxChars: 13 },
		{ header: 'Manufacturer', x: 434, maxChars: 19 },
		{ header: 'Qty/Unit', x: 530, maxChars: 8 },
		{ header: 'Inventory', x: 572, maxChars: 9 },
		{ header: 'Unit Cost', x: 620, maxChars: 9 },
		{ header: 'Total Value', x: 668, maxChars: 10 },
		{ header: 'Lead Time', x: 720, maxChars: 6 }
	];
	const mainRow = (r: (typeof rows)[number]) => ({
		highlight: r.inventoryCount <= 0,
		cells: [
			r.name,
			r.partNumber,
			r.category || '-',
			r.manufacturer || r.supplier || '-',
			r.quantityPerUnit === null ? '-' : String(r.quantityPerUnit),
			String(r.inventoryCount),
			money(r.unitCost),
			money(r.totalValue),
			r.leadTimeDays === null ? '-' : `${r.leadTimeDays}d`
		]
	});

	const sections = [];
	const lowInventory = [...zeroOrNegative, ...lowPositive];
	if (lowInventory.length && !lowStockOnly) {
		sections.push({
			heading: 'Low Inventory',
			columns: [
				{ header: 'Part #', x: 40, maxChars: 16 },
				{ header: 'Name', x: 130, maxChars: 52 },
				{ header: 'Classification', x: 396, maxChars: 15 },
				{ header: 'On Hand', x: 480, maxChars: 8 },
				{ header: 'Lead Time', x: 540, maxChars: 9 }
			],
			highlightCellIndex: 3,
			rows: lowInventory.map((r) => ({
				highlight: r.inventoryCount <= 0,
				cells: [
					r.partNumber,
					r.name,
					r.category || '-',
					String(r.inventoryCount),
					r.leadTimeDays === null ? '-' : `${r.leadTimeDays}d`
				]
			}))
		});
	}
	sections.push({
		heading: 'Full Parts List',
		columns: mainColumns,
		highlightCellIndex: 5,
		rows: rows.map(mainRow)
	});

	const generatedAt = new Date();
	const stats = [
		{ label: 'Total Parts', value: String(rows.length) },
		{ label: 'Classifications', value: String(classifications.size) },
		{ label: 'Total Inventory Value', value: money(summary.totalInventoryValue) },
		{ label: 'Low Stock', value: String(belowMin.length) }
	];
	const footerLines = [
		`Totals: ${rows.length} parts, ${totalUnits} units on hand, total inventory value ` +
			`${money(summary.totalInventoryValue)}` +
			(excludedNoCost.length
				? ` (${excludedNoCost.length} parts with no cost data are excluded from the table and totals, as on the BIMS parts page)`
				: ''),
		'Counts are live values from BIMS at time of generation.'
	];

	const csvCell = (s: string): string =>
		/[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;

	let buffer: Buffer;
	let contentType: string;
	let ext: string;
	if (format === 'csv') {
		const lines: string[] = [
			csvCell(SCOPE_TITLES[scope]),
			csvCell('Brevitest Technologies - BIMS parts inventory'),
			csvCell(`Generated ${generatedAt.toISOString()}`),
			...(filtersApplied.length ? [csvCell(`Filters: ${filtersApplied.join('; ')}`)] : []),
			...stats.map((s) => `${csvCell(s.label)},${csvCell(s.value)}`),
			''
		];
		for (const sec of sections) {
			lines.push(csvCell(sec.heading));
			lines.push(sec.columns.map((c) => csvCell(c.header)).join(','));
			for (const row of sec.rows) lines.push(row.cells.map(csvCell).join(','));
			lines.push('');
		}
		for (const f of footerLines) lines.push(csvCell(f));
		// UTF-8 BOM so Excel opens the CSV correctly.
		buffer = Buffer.from('\ufeff' + lines.join('\r\n'), 'utf8');
		contentType = 'text/csv';
		ext = 'csv';
	} else if (format === 'xlsx') {
		// Native workbook: one sheet per BIMS-page block, numbers as numeric
		// cells so Excel can sort and sum costs.
		const summarySheet: XlsxCell[][] = [
			[SCOPE_TITLES[scope]],
			['Brevitest Technologies - BIMS parts inventory'],
			[`Generated ${generatedAt.toISOString()}`],
			...(filtersApplied.length ? [[`Filters: ${filtersApplied.join('; ')}`]] : []),
			[],
			['Total Parts', rows.length],
			['Classifications', classifications.size],
			['Total Inventory Value (USD)', summary.totalInventoryValue],
			['Low Stock', belowMin.length],
			[],
			...footerLines.map((f) => [f])
		];
		const lowSheet: XlsxCell[][] = [
			['Part #', 'Name', 'Classification', 'On Hand', 'Lead Time (days)'],
			...lowInventory.map((r) => [
				r.partNumber,
				r.name,
				r.category || '-',
				r.inventoryCount,
				r.leadTimeDays
			])
		];
		const partsSheet: XlsxCell[][] = [
			[
				'Name', 'Part #', 'Classification', 'Manufacturer', 'Qty/Unit', 'Inventory',
				'Unit Cost (USD)', 'Total Value (USD)', 'Lead Time (days)'
			],
			...rows.map((r) => [
				r.name,
				r.partNumber,
				r.category || '-',
				r.manufacturer || r.supplier || '-',
				r.quantityPerUnit,
				r.inventoryCount,
				r.unitCost === null ? null : Math.round(r.unitCost * 100) / 100,
				r.totalValue,
				r.leadTimeDays
			]),
			[],
			['Totals', '', '', '', '', totalUnits, '', summary.totalInventoryValue, '']
		];
		buffer = buildXlsx(
			[
				{ name: 'Summary', rows: summarySheet },
				...(lowInventory.length && !lowStockOnly ? [{ name: 'Low Inventory', rows: lowSheet }] : []),
				{ name: 'Full Parts List', rows: partsSheet }
			],
			generatedAt
		);
		contentType = XLSX_CONTENT_TYPE;
		ext = 'xlsx';
	} else if (format === 'json') {
		buffer = Buffer.from(
			JSON.stringify(
				{
					title: SCOPE_TITLES[scope],
					generatedAt: generatedAt.toISOString(),
					...summary,
					stats,
					lowInventory: lowInventory.map((r) => ({
						partNumber: r.partNumber,
						name: r.name,
						category: r.category,
						inventoryCount: r.inventoryCount,
						leadTimeDays: r.leadTimeDays
					})),
					parts: rows,
					excludedNoCostParts: excludedNoCost.map((r) => ({
						partNumber: r.partNumber,
						name: r.name,
						inventoryCount: r.inventoryCount
					})),
					notes: footerLines
				},
				null,
				2
			),
			'utf8'
		);
		contentType = 'application/json';
		ext = 'json';
	} else {
		buffer = generateReportPdf({
			landscape: true,
			title: SCOPE_TITLES[scope],
			subtitleLines: [
				'Brevitest Technologies - BIMS parts inventory',
				`Generated ${generatedAt.toISOString()}`,
				...(filtersApplied.length ? [`Filters: ${filtersApplied.join('; ')}`] : [])
			],
			stats,
			sections,
			footerLines: [
				footerLines[0],
				'Counts are live values from BIMS at time of generation. Shaded rows are at or below zero on hand.'
			],
			pageFooter: `Brevitest Technologies - BIMS Inventory - ${SCOPE_TITLES[scope]}`
		});
		contentType = 'application/pdf';
		ext = 'pdf';
	}

	const reportId = generateId();
	const key = `reports/inventory/inventory-${scope}-${generatedAt.toISOString().slice(0, 10)}-${reportId}.${ext}`;
	let url: string;
	try {
		url = await uploadViaWorker(buffer, key, contentType);
	} catch {
		try {
			url = await uploadToR2(buffer, key, contentType);
		} catch (e) {
			throw error(502, `Report generated but upload to R2 failed: ${(e as Error).message}`);
		}
	}

	await AuditLog.create({
		_id: generateId(),
		tableName: 'part_definitions',
		recordId: reportId,
		action: 'EXPORT',
		newData: { ...summary, format, r2Key: key, url },
		changedAt: generatedAt,
		changedBy: 'agent-api',
		reason: 'Inventory report generated'
	});

	return json({
		success: true,
		data: { ...summary, format, url, r2Key: key, generatedAt: generatedAt.toISOString() }
	});
};
