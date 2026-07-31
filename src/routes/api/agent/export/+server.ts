import { json, error } from '@sveltejs/kit';
import { requireAgentApiKey } from '$lib/server/api-auth';
import { connectDB, AuditLog, generateId } from '$lib/server/db';
import { generateReportPdf, autoLayoutColumns } from '$lib/server/services/pdf-report';
import { uploadViaWorker, uploadToR2 } from '$lib/server/services/r2';
import type { RequestHandler } from './$types';

/**
 * Universal file export for agents.
 *
 * The agent gathers data through its read tools (applying whatever SPU /
 * device / date / time filters the user asked for), then posts the assembled
 * tables here. The server renders the requested format, uploads it to R2, and
 * returns a public URL. Nothing domain-specific lives here — any information
 * an agent can read can become a file.
 *
 * POST {
 *   title, format? ('pdf'|'csv'|'json', default pdf), filename?,
 *   subtitleLines?, stats? [{label,value}],
 *   sections: [{ heading?, columns: [{key,label}], rows: [{...}] }],
 *   footerLines?, orientation? ('landscape'|'portrait')
 * }
 */

const MAX_SECTIONS = 20;
const MAX_COLUMNS = 20;
const MAX_TOTAL_ROWS = 5000;

function cellText(v: unknown): string {
	if (v === null || v === undefined) return '';
	if (typeof v === 'object') {
		const s = JSON.stringify(v);
		return s.length > 200 ? s.slice(0, 197) + '...' : s;
	}
	return String(v);
}

function csvCell(s: string): string {
	return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

function slug(s: string): string {
	return (
		s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60) || 'export'
	);
}

export const POST: RequestHandler = async ({ request }) => {
	requireAgentApiKey(request);
	await connectDB();

	const body = await request.json().catch(() => null);
	if (!body || typeof body !== 'object') throw error(400, 'JSON body required');

	const title: string = typeof body.title === 'string' && body.title.trim() ? body.title.trim() : '';
	if (!title) throw error(400, 'title is required');
	const format: 'pdf' | 'csv' | 'json' = ['csv', 'json'].includes(body.format) ? body.format : 'pdf';
	const landscape = body.orientation !== 'portrait';
	const subtitleLines: string[] = Array.isArray(body.subtitleLines)
		? body.subtitleLines.map(cellText).slice(0, 6)
		: [];
	const stats: { label: string; value: string }[] = Array.isArray(body.stats)
		? body.stats
				.filter((s: any) => s && typeof s === 'object')
				.map((s: any) => ({ label: cellText(s.label), value: cellText(s.value) }))
				.slice(0, 6)
		: [];
	const footerLines: string[] = Array.isArray(body.footerLines)
		? body.footerLines.map(cellText).slice(0, 6)
		: [];

	if (!Array.isArray(body.sections) || body.sections.length === 0)
		throw error(400, 'sections[] is required');
	if (body.sections.length > MAX_SECTIONS) throw error(400, `Max ${MAX_SECTIONS} sections`);

	let totalRows = 0;
	const sections = body.sections.map((sec: any, i: number) => {
		if (!sec || !Array.isArray(sec.columns) || sec.columns.length === 0)
			throw error(400, `sections[${i}].columns[] is required`);
		if (sec.columns.length > MAX_COLUMNS) throw error(400, `Max ${MAX_COLUMNS} columns per section`);
		if (!Array.isArray(sec.rows)) throw error(400, `sections[${i}].rows[] is required`);
		const columns = sec.columns.map((c: any) => ({
			key: cellText(c?.key),
			label: cellText(c?.label) || cellText(c?.key)
		}));
		totalRows += sec.rows.length;
		if (totalRows > MAX_TOTAL_ROWS) throw error(400, `Max ${MAX_TOTAL_ROWS} rows per export`);
		return {
			heading: sec.heading ? cellText(sec.heading) : undefined,
			columns,
			rows: sec.rows.map((row: any) =>
				columns.map((c: { key: string }) => cellText(row?.[c.key]))
			),
			// Reserved "_highlight": true on a row shades it red in the PDF.
			highlights: sec.rows.map((row: any) => row?._highlight === true),
			rawRows: sec.rows
		};
	});

	const generatedAt = new Date();
	let buffer: Buffer;
	let contentType: string;
	let ext: string;

	if (format === 'pdf') {
		buffer = generateReportPdf({
			landscape,
			title,
			subtitleLines: [`Generated ${generatedAt.toISOString()} via BIMS agent API`, ...subtitleLines],
			stats,
			sections: sections.map((sec: any) => ({
				heading: sec.heading,
				columns: autoLayoutColumns(
					sec.columns.map((c: { label: string }) => c.label),
					sec.rows,
					landscape
				),
				rows: sec.rows.map((cells: string[], i: number) => ({ cells, highlight: sec.highlights[i] }))
			})),
			footerLines: footerLines.length
				? footerLines
				: ['Data is live from BIMS at time of generation.'],
			pageFooter: `Brevitest Technologies - BIMS - ${title}`
		});
		contentType = 'application/pdf';
		ext = 'pdf';
	} else if (format === 'csv') {
		const parts: string[] = [];
		for (const sec of sections) {
			if (sec.heading) parts.push(csvCell(sec.heading));
			parts.push(sec.columns.map((c: { label: string }) => csvCell(c.label)).join(','));
			for (const cells of sec.rows) parts.push(cells.map(csvCell).join(','));
			parts.push('');
		}
		// UTF-8 BOM so Excel opens the CSV correctly.
		buffer = Buffer.from('\ufeff' + parts.join('\r\n'), 'utf8');
		contentType = 'text/csv';
		ext = 'csv';
	} else {
		buffer = Buffer.from(
			JSON.stringify(
				{
					title,
					generatedAt: generatedAt.toISOString(),
					subtitleLines,
					stats,
					sections: sections.map((sec: any) => ({
						heading: sec.heading,
						columns: sec.columns,
						rows: sec.rawRows
					}))
				},
				null,
				2
			),
			'utf8'
		);
		contentType = 'application/json';
		ext = 'json';
	}

	const exportId = generateId();
	const base = slug(typeof body.filename === 'string' && body.filename.trim() ? body.filename : title);
	const key = `reports/exports/${base}-${generatedAt.toISOString().slice(0, 10)}-${exportId}.${ext}`;
	let url: string;
	try {
		url = await uploadViaWorker(buffer, key, contentType);
	} catch {
		try {
			url = await uploadToR2(buffer, key, contentType);
		} catch (e) {
			throw error(502, `Export generated but upload to R2 failed: ${(e as Error).message}`);
		}
	}

	await AuditLog.create({
		_id: generateId(),
		tableName: 'agent_exports',
		recordId: exportId,
		action: 'EXPORT',
		newData: { title, format, sectionCount: sections.length, rowCount: totalRows, r2Key: key, url },
		changedAt: generatedAt,
		changedBy: 'agent-api',
		reason: 'Agent data-file export generated'
	});

	return json({
		success: true,
		data: {
			url,
			r2Key: key,
			format,
			title,
			sectionCount: sections.length,
			rowCount: totalRows,
			generatedAt: generatedAt.toISOString()
		}
	});
};
