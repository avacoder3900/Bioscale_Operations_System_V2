import { McpServer } from '@modelcontextprotocol/server';
import * as z from 'zod';
import { env } from '$env/dynamic/private';
import { TIER2_STATUSES, SIZE_CLASSES, legalStatusesFor } from '$lib/shared/kanban-status';

// Status vocabulary for MCP tool schemas, from the shared module.
// 'review' is software-board-only and not exposed through these tools yet.
const OPS_STATUSES = legalStatusesFor('ops') as unknown as [string, ...string[]];
// Tier 2 moves only — tier crossings (e.g. captured → ready) are rejected
// server-side pending the replenish tool (KB2-02).
const TIER2_MOVE_STATUSES = TIER2_STATUSES.filter((s) => s !== 'review') as unknown as [
	string,
	...string[]
];
const SIZE_CLASS_VALUES = SIZE_CLASSES as unknown as [string, ...string[]];

/**
 * BIMS MCP server — a thin MCP layer over the existing /api/agent/** REST API.
 *
 * Design (carried over from services/bims-mcp, Alejandro's v0.1):
 * - Every tool makes an internal authenticated call to the agent API using
 *   AGENT_API_KEY, so server-side audit logging, collection allowlists, and
 *   validation stay enforced in exactly one place (the REST handlers).
 * - Stateless: a fresh McpServer is built per HTTP request by the /api/mcp route.
 * - The `fetcher` is SvelteKit's event.fetch, so internal calls are routed
 *   directly to the handlers without a network round-trip.
 */

type Fetcher = typeof fetch;
type ToolResult = { content: { type: 'text'; text: string }[]; isError?: boolean };

/** MCP tool annotations: readOnlyHint lets clients run reads without write-gating;
 *  write tools are explicitly non-destructive (append-only records, reversible). */
const READ_ONLY = { readOnlyHint: true } as const;
const WRITE_TOOL = { readOnlyHint: false, destructiveHint: false, idempotentHint: false } as const;

function toolError(text: string): ToolResult {
	return { isError: true, content: [{ type: 'text', text }] };
}

async function callAgentApi(
	fetcher: Fetcher,
	path: string,
	opts?: {
		method?: 'GET' | 'POST' | 'PATCH';
		query?: Record<string, string | number | boolean | undefined>;
		body?: unknown;
	}
): Promise<ToolResult> {
	if (!env.AGENT_API_KEY) {
		return toolError('AGENT_API_KEY is not configured on the server — MCP tools cannot authenticate to the agent API.');
	}

	let url = path;
	if (opts?.query) {
		const params = new URLSearchParams();
		for (const [k, v] of Object.entries(opts.query)) {
			if (v !== undefined && v !== null && v !== '') params.set(k, String(v));
		}
		const qs = params.toString();
		if (qs) url += `?${qs}`;
	}

	let res: Response;
	try {
		res = await fetcher(url, {
			method: opts?.method ?? 'GET',
			headers: {
				'x-api-key': env.AGENT_API_KEY,
				accept: 'application/json',
				...(opts?.body !== undefined ? { 'content-type': 'application/json' } : {})
			},
			body: opts?.body !== undefined ? JSON.stringify(opts.body) : undefined
		});
	} catch (e) {
		return toolError(`Could not reach BIMS agent API at ${path}: ${(e as Error)?.message ?? e}`);
	}

	const text = await res.text();
	if (!res.ok) {
		let msg = text;
		try {
			const parsed = JSON.parse(text);
			msg = parsed?.error?.message || parsed?.error || parsed?.message || text;
		} catch {
			/* keep raw text */
		}
		return toolError(`BIMS ${res.status}: ${msg}`);
	}

	// Pretty-print JSON when possible so results are readable in the client.
	try {
		return { content: [{ type: 'text', text: JSON.stringify(JSON.parse(text), null, 2) }] };
	} catch {
		return { content: [{ type: 'text', text }] };
	}
}

export function buildBimsMcpServer(fetcher: Fetcher): McpServer {
	// Version bump signals clients (claude.ai caches connector tool lists) that
	// the toolset changed — bump on every tool add/remove/rename.
	const server = new McpServer({ name: 'bims-operations', version: '2.13.0' });

	// ---------------------------------------------------------------- meta

	server.registerTool(
		'list_collections',
		{ annotations: READ_ONLY,
			description:
				'List every queryable BIMS collection with its business metadata (what each collection holds, key fields). ' +
				'Call this first when you are unsure where a piece of data lives.'
		},
		async () => callAgentApi(fetcher, '/api/agent/schema')
	);

	server.registerTool(
		'system_dependencies',
		{ annotations: READ_ONLY,
			description: 'List the BIMS system dependency map (which subsystems depend on which services/integrations).'
		},
		async () => callAgentApi(fetcher, '/api/agent/dependencies')
	);

	// ------------------------------------------------------------- queries

	server.registerTool(
		'list_saved_queries',
		{ annotations: READ_ONLY,
			description:
				'List the saved, parameterized read queries available to agents (id, name, parameters schema, target collection). ' +
				'Call this before run_saved_query to discover valid queryId values.'
		},
		async () => callAgentApi(fetcher, '/api/agent/query')
	);

	server.registerTool(
		'run_saved_query',
		{ annotations: READ_ONLY,
			description:
				'Execute a saved read-only query against an allowlisted BIMS collection. ' +
				'Use list_saved_queries first to find the queryId and its parameter schema. Returns up to the query\'s maxRows (default 100). ' +
				'Supports range filters via key suffixes __gte/__lte/__gt/__lt — e.g. {"createdAt__gte": "2026-07-01", ' +
				'"createdAt__lte": "2026-07-31T17:00:00Z"} for date/time windows. ' +
				'If the user wants the results as a file (PDF/CSV/JSON), pass the rows to export_data_file ' +
				'(inventory files: use generate_inventory_report instead).',
			inputSchema: z.object({
				queryId: z.string().describe('The saved query _id from list_saved_queries.'),
				parameters: z
					.record(z.string(), z.union([z.string(), z.number(), z.boolean()]))
					.optional()
					.describe(
						'Optional filters merged into the query. Plain keys match equality; keys with __gte/__lte/__gt/__lt ' +
						'suffixes build ranges (ISO date strings are coerced to dates), e.g. {"testRanAt__gte": "2026-07-01"}.'
					)
			})
		},
		async ({ queryId, parameters }) =>
			callAgentApi(fetcher, '/api/agent/query', { method: 'POST', body: { queryId, parameters } })
	);

	// ---------------------------------------------------------- operations

	server.registerTool(
		'operations_summary',
		{ annotations: READ_ONLY,
			description:
				'High-level operational counts. Call this for questions like "how is manufacturing doing" or "what is our shipping volume".',
			inputSchema: z.object({
				metric: z
					.enum(['summary', 'manufacturing', 'inventory', 'quality', 'shipping'])
					.describe('Which slice of operations to summarize.')
			})
		},
		async ({ metric }) => callAgentApi(fetcher, '/api/agent/operations', { query: { metric } })
	);

	server.registerTool(
		'operations_dashboard',
		{ annotations: READ_ONLY,
			description:
				'Full operations rollup: task counts, equipment status, inventory, production, recent audit activity, and pending approvals. ' +
				'Call this when asked for an overall status of the plant/system.'
		},
		async () => callAgentApi(fetcher, '/api/agent/operations/dashboard')
	);

	server.registerTool(
		'operations_alerts',
		{ annotations: READ_ONLY,
			description:
				'Current synthesized alerts sorted by severity: low-stock parts, problem equipment, overdue tasks, stale approvals, failed messages. ' +
				'Call this when asked "what needs attention" or "any problems right now".'
		},
		async () => callAgentApi(fetcher, '/api/agent/operations/alerts')
	);

	server.registerTool(
		'operations_context',
		{ annotations: READ_ONLY,
			description:
				'Active work context: active projects, in-progress tasks, equipment alerts, pending approvals and messages. ' +
				'Useful as a first call to orient on what is currently happening.'
		},
		async () => callAgentApi(fetcher, '/api/agent/operations/context')
	);

	server.registerTool(
		'inventory_overview',
		{ annotations: READ_ONLY,
			description:
				'Inventory state: active parts, low-stock list, categories, and BOM count. The summary always includes ' +
				'lowStockParts (count on hand of zero or below) AND criticalLowStockParts — parts classified "Critical" ' +
				'(their category field) that are running low — so use this to answer "are any Critical parts low on stock?". ' +
				'You are authorized to state exact inventory counts back to the user. ' +
				'If the user wants an inventory file (PDF/CSV/JSON), do NOT build one from this data — call generate_inventory_report.',
			inputSchema: z.object({
				category: z.string().optional().describe('Restrict the parts list to one classification, e.g. "Critical".'),
				lowStockOnly: z.boolean().optional().describe('Restrict the parts list to parts with count on hand <= 0.')
			})
		},
		async ({ category, lowStockOnly }) =>
			callAgentApi(fetcher, '/api/agent/operations/inventory', {
				query: { category, lowStockOnly: lowStockOnly ? '1' : undefined }
			})
	);

	server.registerTool(
		'parts_lookup',
		{ annotations: READ_ONLY,
			description:
				'Resolve a part reference to BIMS part definitions with live inventory counts. Accepts a scanned part barcode, ' +
				'an exact part number (e.g. PT-SPU-008), or free-text like "screw for upper metal bracket" (every word must match ' +
				'the part name/description/number/category). Use this to turn vague part descriptions from operators into concrete ' +
				'part numbers before recording inventory usage. If it returns multiple candidates, ask the user which one they mean; ' +
				'if it returns none, ask the user to scan the part barcode and retry with barcode. ' +
				'You are authorized to answer counting questions ("how many stage boards do we have?") with the exact ' +
				'inventoryCount from this tool — state the number plainly. Each part\'s category field carries its ' +
				'Critical / Non-Critical classification. If the user wants an inventory file (PDF/CSV/JSON), call generate_inventory_report ' +
				'instead of composing a document from this data.',
			inputSchema: z.object({
				q: z.string().optional().describe('Free-text description of the part (e.g. "magnet heating block spherical").'),
				barcode: z.string().optional().describe('A scanned part barcode.'),
				partNumber: z.string().optional().describe('Exact part number, e.g. PT-SPU-017.'),
				bomType: z.enum(['spu', 'cartridge']).optional().describe('Restrict to one BOM (use "spu" for SPU assembly parts).'),
				limit: z.number().int().min(1).max(50).optional()
			})
		},
		async (args) => callAgentApi(fetcher, '/api/agent/inventory/parts', { query: args })
	);

	server.registerTool(
		'spu_assembly_parts_map',
		{ annotations: READ_ONLY,
			description:
				'The SPU assembly parts knowledge base from work instruction WIMF-SPU-01: a component -> parts map (heater/heating ' +
				'block, upper magnet bracket, enclosure, drive, linear rail, stage board, antennas, labels, ...) with per-SPU part ' +
				'quantities, operator-language aliases, and live inventory status per part. Use this FIRST to resolve ' +
				'assembly-context language that parts_lookup cannot — e.g. "all magnets in the heating block" (3x spherical + 6x ' +
				'cylindrical), "one well of magnets" (ask how many of each), or "one screw for the upper metal bracket" ' +
				'(M3 x 10 mm SHCS, PT-SPU-029). Parts flagged inInventory:false exist in the build but are not in the inventory ' +
				'system yet — report their usage to the user but they cannot be deducted. Also includes the active BIMS work ' +
				'instruction step map when one exists.'
		},
		async () => callAgentApi(fetcher, '/api/agent/inventory/spu-assembly-map')
	);

	server.registerTool(
		'record_reassembly_parts_usage',
		{ annotations: WRITE_TOOL,
			description:
				'Deduct parts from inventory after SPU assembly/reassembly work, grouped per SPU. Each deduction is recorded as an ' +
				'immutable inventory transaction linked to the SPU, and audit-logged. You HAVE live write access to inventory ' +
				'through this tool — never tell the operator you are read-only or cannot change counts.\n\n' +
				'WORKFLOW (follow exactly):\n' +
				'1. From the operator\'s message, identify each SPU (barcode, UDI, or short number like "SPU 203") and the parts used. ' +
				'Resolve component/area language ("magnets in the heater block") with spu_assembly_parts_map and vague part ' +
				'descriptions with parts_lookup; ask a clarifying question only if a part is genuinely ambiguous. If the operator ' +
				'says what area they worked on but not which parts at all, ask them to scan the SPU barcode and each part barcode.\n' +
				'2. Before calling this tool, send the confirmation message. It must contain ONLY the per-SPU list and a one-line ' +
				'reply instruction — nothing else. Format: one group per SPU, headed by the SPU barcode and its last 5 characters, ' +
				'one row per part, every row numbered sequentially ACROSS the whole message (1., 2., 3., ...). If the operator NAMED ' +
				'parts in words (e.g. "replaced the magnets in the heater block"), each row is "<n>. <partNumber> <name> — qty: ' +
				'<stated qty or __>". If the operator provided the parts as SCANNED BARCODES, do NOT restate or describe the parts — ' +
				'each row is just "<n>. <partNumber> — qty: __". The same part used on different SPUs gets its own numbered row ' +
				'under each SPU. Then the final line: if any quantities are blank, exactly: \'Reply with the quantities in order ' +
				'(e.g. "2, 6, 1") or confirm.\' — the operator answers with bare numbers, comma or space separated, mapped to the ' +
				'blank rows in order (they may also write "3=2" to target row 3). If all quantities are already stated, the final ' +
				'line is exactly: "Confirm?". Accept "yes"/"confirm"/a bare number list as approval; never require them to retype ' +
				'part numbers.\n' +
				'3. NEVER add commentary to the confirmation or result messages: no notes about critical parts, retesting, ' +
				'revalidation, QC, or process implications of the replacement — only mention such things if the operator explicitly ' +
				'asks.\n' +
				'4. Only after the operator confirms the complete list (all quantities filled) call this tool with confirmed: true. ' +
				'Never call it with unconfirmed or guessed quantities.\n\n' +
				'The request is atomic: if any SPU or part fails to resolve, nothing is deducted and per-entry errors come back — ' +
				'fix them with the user and retry. On success, report ONLY each SPU\'s deducted parts with previous → new counts.',
			inputSchema: z.object({
				confirmed: z
					.boolean()
					.describe('Must be true, and only after the user explicitly approved the full per-SPU part+quantity list.'),
				performedBy: z.string().optional().describe('Name/username of the operator who did the reassembly, if known.'),
				spus: z
					.array(
						z.object({
							spu: z.string().describe('SPU barcode, UDI, _id, or unique suffix (e.g. "203" or "71dbc").'),
							parts: z
								.array(
									z.object({
										part: z.string().describe('Part barcode, part number (PT-SPU-xxx), or exact part name.'),
										quantity: z.number().int().min(1).describe('Units used on this SPU, as confirmed by the user.'),
										note: z.string().optional().describe('Optional context, e.g. "all magnets in heating block".')
									})
								)
								.min(1)
						})
					)
					.min(1)
					.describe('One entry per SPU worked on; the same part on two SPUs appears under both.')
			})
		},
		async (args) => callAgentApi(fetcher, '/api/agent/inventory/reassembly', { method: 'POST', body: args })
	);

	server.registerTool(
		'generate_inventory_report',
		{ annotations: WRITE_TOOL,
			description:
				'Render an inventory report as a file (PDF, Excel .xlsx, CSV, or JSON — whichever the user asks for, default PDF), upload it, ' +
				'and return a public download URL. Every format carries identical content mirroring the BIMS parts page: summary ' +
				'stats (Total Parts, Classifications, Total Inventory Value, Low Stock), the Low Inventory section, and the full ' +
				'parts table with the same columns as the UI (Name, Part #, Classification, Manufacturer, Qty/Unit, Inventory, ' +
				'Unit Cost, Total Value, Lead Time). ALWAYS use this tool for inventory files — never compose your own document ' +
				'from raw query data, so reports always match what the BIMS software shows. ' +
				'ONLY call this when the user explicitly asks for a file (e.g. "give me a pdf/csv of the total inventory count") — ' +
				'for ordinary counting questions answer inline from parts_lookup / inventory_overview instead. ' +
				'Default scope is "spu-bom" (the SPU Parts Bill of Materials); the user may condition the request on another ' +
				'scope ("general" = General Inventory / non-BOM, "cartridge", or "all") and/or a classification filter such as ' +
				'category "Critical", or lowStockOnly. Report the returned url to the user as a link.',
			inputSchema: z.object({
				format: z
					.enum(['pdf', 'xlsx', 'csv', 'json'])
					.optional()
					.describe('File type the user asked for (default pdf; use xlsx when they say Excel/spreadsheet). Same BIMS-page content in every format; xlsx has native numeric cells for costs.'),
				scope: z
					.enum(['spu-bom', 'general', 'cartridge', 'all'])
					.optional()
					.describe('Which inventory to report (default spu-bom = SPU Parts Bill of Materials).'),
				category: z.string().optional().describe('Restrict to one classification, e.g. "Critical".'),
				lowStockOnly: z.boolean().optional().describe('Only parts with count on hand <= 0.')
			})
		},
		async ({ format, ...rest }) =>
			callAgentApi(fetcher, '/api/agent/inventory/report', {
				method: 'POST',
				body: { ...rest, format: format ?? 'pdf' }
			})
	);

	server.registerTool(
		'export_data_file',
		{ annotations: WRITE_TOOL,
			description:
				'Universal file export: turn ANY information the user asks for into a downloadable file (PDF, Excel .xlsx, CSV, or JSON), ' +
				'uploaded and returned as a public URL. Use whenever the user asks for data "as a file/PDF/CSV/report/download" — ' +
				'e.g. "give me the magnetometer history for SPU 203 as a PDF". WORKFLOW: (1) gather the data with the read tools ' +
				'(run_saved_query, get_spu_status, list_spus, quality_trends, kanban tools, ...), applying every filter the user ' +
				'stated (specific SPUs/devices, date/time windows — saved queries accept __gte/__lte range parameters); ' +
				'(2) assemble the rows and call this tool; (3) give the user the returned url. Pick the format the user asked for ' +
				'(default pdf). NEVER compose a document yourself from query data — always produce files through this tool so they ' +
				'are stored, audited, and consistently formatted. Exception: inventory/parts reports have a dedicated tool ' +
				'(generate_inventory_report) that matches the BIMS parts page — use that instead for inventory. ' +
				'Include every relevant column the data has unless the user narrows it; put filters you applied in subtitleLines ' +
				'so the file is self-describing.',
			inputSchema: z.object({
				title: z.string().describe('Document title, e.g. "Magnetometer History - SPU 203".'),
				format: z.enum(['pdf', 'xlsx', 'csv', 'json']).optional().describe('File type the user asked for (default pdf; use xlsx when they say Excel/spreadsheet).'),
				filename: z.string().optional().describe('Optional filename hint (no extension).'),
				subtitleLines: z
					.array(z.string())
					.optional()
					.describe('Context lines under the title — state the filters applied (SPU, device, date range).'),
				stats: z
					.array(z.object({ label: z.string(), value: z.string() }))
					.optional()
					.describe('Up to 6 summary tiles, e.g. {label: "Total Runs", value: "14"}.'),
				sections: z
					.array(
						z.object({
							heading: z.string().optional().describe('Section heading, e.g. "Failed Runs".'),
							columns: z
								.array(z.object({ key: z.string(), label: z.string() }))
								.min(1)
								.describe('Column order + labels; key selects the field from each row object.'),
							rows: z
								.array(z.record(z.string(), z.unknown()))
								.describe('Row objects keyed by column key. Set "_highlight": true on a row to shade it red in the PDF (e.g. failed runs).')
						})
					)
					.min(1)
					.describe('One or more tables. 5000 rows max across all sections.'),
				footerLines: z.array(z.string()).optional().describe('Closing notes (totals, caveats).'),
				orientation: z.enum(['landscape', 'portrait']).optional().describe('PDF page orientation (default landscape).')
			})
		},
		async (args) => callAgentApi(fetcher, '/api/agent/export', { method: 'POST', body: args })
	);

	server.registerTool(
		'record_physical_count',
		{ annotations: WRITE_TOOL,
			description:
				'Reconcile BIMS inventory to a PHYSICAL count — sets ABSOLUTE counts ("it is supposed to be 129 not 100"), ' +
				'never deltas. You HAVE live write access through this tool. Use it when an operator reports a discrepancy ' +
				'between an actual count and BIMS, e.g. "a physical count was done on <part> and it is supposed to be 129 ' +
				'not 100", or with per-bin barcodes: "<part number> is 100 on BIMS but barcode X has 100 and barcode Y has ' +
				'100". Per-barcode quantities are UPSERTED (a partial recount amends only the bins stated; other recorded ' +
				'bins are kept) and the part total becomes the stated newCount, or the sum of all recorded barcode counts ' +
				'when no total is stated. Unknown barcodes are auto-registered to the part so future scans resolve.\n\n' +
				'WORKFLOW (follow exactly):\n' +
				'1. Resolve each part with parts_lookup (part number, name, or barcode); ask only if genuinely ambiguous.\n' +
				'2. Before calling this tool, send a confirmation message: one numbered row per part — ' +
				'"<n>. <partNumber> <name> — BIMS: <current> → new total: <newCount>" and, when bins were stated, indented ' +
				'"<barcode> = <qty>" lines. Final line exactly: "Confirm?". No commentary.\n' +
				'3. Only after the user confirms, call with confirmed: true. Never call with unconfirmed numbers.\n' +
				'The request is atomic: any unresolvable entry rejects the whole request with per-entry errors. ' +
				'On success report each part\'s previous → new count (and per-barcode breakdown).',
			inputSchema: z.object({
				confirmed: z
					.boolean()
					.describe('Must be true, and only after the user explicitly approved the count list.'),
				performedBy: z.string().optional().describe('Name/username of the person who did the physical count.'),
				counts: z
					.array(
						z.object({
							part: z.string().describe('Part number (PT-SPU-xxx), part name, or any of its barcodes.'),
							newCount: z
								.number()
								.int()
								.min(0)
								.optional()
								.describe('Absolute counted total. Omit to use the sum of the barcode quantities.'),
							barcodes: z
								.array(
									z.object({
										barcode: z.string().describe('The physical bin/label barcode.'),
										quantity: z.number().int().min(0).describe('Counted quantity in that bin.')
									})
								)
								.optional()
								.describe('Per-bin counted quantities, when the operator stated them per barcode.'),
							note: z.string().optional().describe('Optional context, e.g. "monthly cycle count".')
						})
					)
					.min(1)
			})
		},
		async (args) =>
			callAgentApi(fetcher, '/api/agent/inventory/physical-count', { method: 'POST', body: args })
	);

	server.registerTool(
		'equipment_overview',
		{ annotations: READ_ONLY, description: 'Equipment list with locations and a status summary (operational / maintenance / problem).' },
		async () => callAgentApi(fetcher, '/api/agent/operations/equipment')
	);

	server.registerTool(
		'documents_overview',
		{ annotations: READ_ONLY, description: 'Controlled documents and work instructions with status breakdown (draft / review / approved).' },
		async () => callAgentApi(fetcher, '/api/agent/operations/documents')
	);

	server.registerTool(
		'find_test_results',
		{ annotations: READ_ONLY,
			description:
				'THE tool for test/validation outcomes — ANY outcome, passing or failing, not just failures. Use it for every ' +
				'question about test results, and match the user\'s wording to a modality: "optics"/"optical" → optical, ' +
				'"mag"/"magnetometer" → magnetometer, "thermo"/"thermocouple" → thermocouple, "spectro" → spectrophotometer. ' +
				'IMPORTANT: test results in BIMS are NOT all on the Test Results page (that legacy collection is EMPTY) — ' +
				'they live in the tab matching the feature: magnetometer/thermocouple/spectrophotometer runs are validation ' +
				'sessions; optics results are the Optical Test Cartridge Log (per-cartridge F7/F3 ratios per channel A/B/C, ' +
				'computed on read). This tool fans out to the right stores for you. Filters combine freely: an SPU ' +
				'(UDI/barcode/suffix like "203"), a cartridge barcode, a cartridge GROUP NAME (optics cohorts), passed ' +
				'true/false, a device (Particle id or SPU UDI/device name), and a from/to date window. Optical runs are linked ' +
				'to the SPU that ran them (device.name = SPU UDI), so optics-for-an-SPU works directly. Examples: ' +
				'"magnetometer results for SPU 203 no matter passing or failing" → {modality:"magnetometer", spu:"203"}; ' +
				'"optics results for all cartridges in group a3" → {modality:"optical", group:"a3"}; "optics results for ' +
				'SPU 212 on July 30" → {modality:"optical", spu:"212", from:"2026-07-30", to:"2026-07-31"}; "optics run on ' +
				'a particular device" → {modality:"optical", device:"<particle id or UDI>"}. If the user wants the results as a file, pass the rows to ' +
				'export_data_file. PRESENTATION — magnetometer: show each session exactly as the BIMS page does: a line ' +
				'"Criteria: Z range <minZ> - <maxZ>" followed by a table "Well | Ch A (Z) | Ch B (Z) | Ch C (Z)" built from ' +
				'the returned wells[] array, marking each Z value with a check/cross from its chX_pass flag. NEVER present ' +
				'raw axis columns (AT/AX/AY/BT/...) unless the user explicitly asks for raw device output.',
			inputSchema: z.object({
				modality: z
					.enum(['magnetometer', 'thermocouple', 'spectrophotometer', 'optical', 'all'])
					.optional()
					.describe('Which test kind (default all). Map user wording: optics→optical, mag→magnetometer, thermo→thermocouple.'),
				spu: z.string().optional().describe('SPU UDI, barcode, _id, or unique suffix (e.g. "203").'),
				cartridge: z.string().optional().describe('Cartridge barcode or serial number (optical).'),
				group: z.string().optional().describe('Cartridge group name, e.g. "a3" (optical cohorts).'),
				device: z
					.string()
					.optional()
					.describe('Particle device id or device name / SPU UDI — filters to results run on that device.'),
				passed: z.boolean().optional().describe('Filter by outcome; OMIT to get results regardless of outcome.'),
				from: z.string().optional().describe('ISO date — only results recorded on/after this.'),
				to: z.string().optional().describe('ISO date — only results recorded on/before this.'),
				limit: z.number().int().min(1).max(200).optional().describe('Max rows per store (default 50).')
			})
		},
		async ({ passed, ...rest }) =>
			callAgentApi(fetcher, '/api/agent/test-results', {
				query: { ...rest, passed: passed === undefined ? undefined : String(passed) }
			})
	);

	server.registerTool(
		'validation_tab',
		{ annotations: READ_ONLY,
			description:
				'The BIMS Validation section, tab by tab — use this when asked for a REPORT of validation data so the answer ' +
				'mirrors exactly what the corresponding BIMS tab shows. Tabs: "runs" (the per-SPU step board: magnetometer / ' +
				'thermocouple / optical_confirmation status, uploaded results, evaluations); "magnetometer" (sessions with the ' +
				'per-well Z table and criteria — present as "Well | Ch A (Z) | Ch B (Z) | Ch C (Z)" with check/cross per cell); ' +
				'"thermocouple" (sessions with temperature stats: min/max/average/stdDev/range/readingCount); ' +
				'"optical-confirmation" (the Optical Test Cartridge Log: per-cartridge F7/F3 ratios, warnings, group ' +
				'memberships, plus the group list). A report of OPTICAL data → tab "optical-confirmation"; add group=<name> ' +
				'to get the group workspace report (robust group stats, per-cartridge rows, outlier flags — what the ' +
				'group-vs-group page computes). All tabs filter by spu (UDI/barcode/suffix) and from/to dates; runs also by ' +
				'runId. For pass/fail-focused queries across modalities find_test_results also works; for files pass rows to ' +
				'export_data_file.',
			inputSchema: z.object({
				tab: z
					.enum(['runs', 'magnetometer', 'thermocouple', 'optical-confirmation'])
					.describe('Which Validation sub-tab to read.'),
				spu: z.string().optional().describe('SPU UDI, barcode, _id, or unique suffix (e.g. "212").'),
				group: z
					.string()
					.optional()
					.describe('optical-confirmation only: cartridge group name → full group workspace report.'),
				runId: z.string().optional().describe('runs only: a validation run _id or runNumber (e.g. VALRUN-000002).'),
				from: z.string().optional().describe('ISO date — only records on/after this.'),
				to: z.string().optional().describe('ISO date — only records on/before this.'),
				limit: z.number().int().min(1).max(200).optional().describe('Max rows (default 50).')
			})
		},
		async (args) => callAgentApi(fetcher, '/api/agent/validation/tab', { query: args })
	);

	server.registerTool(
		'sync_optics_to_spu',
		{ annotations: WRITE_TOOL,
			description:
				'Mirror the latest optics (optical-confirmation) run outcome into the SPU record\'s ' +
				'validation.spectrophotometer block. Optics runs land in cartridge_records without touching the SPU, so an ' +
				'SPU can show spectrophotometer "pending" despite completed optics runs — call this when you see that ' +
				'mismatch (find_test_results shows optics runs but get_spu_status shows pending), or after new optics runs. ' +
				'Latest analyzable run wins: no warnings → passed, warnings → failed (reasons recorded). Idempotent; ' +
				'finalized SPUs are skipped; every change is audit-logged. Also runs automatically once a day.',
			inputSchema: z.object({
				spu: z
					.string()
					.optional()
					.describe('SPU UDI/barcode/_id/suffix to sync; omit to sync every SPU with optics runs.')
			})
		},
		async (args) => callAgentApi(fetcher, '/api/agent/validation/sync-optics', { method: 'POST', body: args })
	);

	server.registerTool(
		'quality_trends',
		{ annotations: READ_ONLY, description: 'Quality metrics: test pass rate, cartridge pipeline by phase, recent wax-run completion.' },
		async () => callAgentApi(fetcher, '/api/agent/operations/quality/trends')
	);

	// ---------------------------------------------------------------- SPUs

	server.registerTool(
		'get_spu_status',
		{ annotations: READ_ONLY,
			description:
				'Look up a single SPU by exactly one identifier and return its current status: lifecycle status, assembly/QC status, ' +
				'batch, assigned customer, linked Particle device, and per-modality validation results ' +
				'(magnetometer, thermocouple, lux, spectrophotometer).',
			inputSchema: z.object({
				spuId: z.string().optional().describe('The SPU _id (nanoid).'),
				udi: z.string().optional().describe('The SPU UDI.'),
				barcode: z.string().optional().describe('The SPU barcode.')
			})
		},
		async ({ spuId, udi, barcode }) => {
			if (!spuId && !udi && !barcode) return toolError('Provide one of: spuId, udi, or barcode.');
			return callAgentApi(fetcher, '/api/agent/operations/spus', { query: { spuId, udi, barcode } });
		}
	);

	server.registerTool(
		'list_spus',
		{ annotations: READ_ONLY,
			description:
				'List SPUs with optional filters and a status breakdown. Filter by lifecycle status (draft, assembling, assembled, ' +
				'validating, validated, released-manufacturing, deployed, servicing, retired, voided), batch (id or batchNumber), ' +
				'or customer name. Newest first.',
			inputSchema: z.object({
				status: z.string().optional().describe('Lifecycle status to filter by.'),
				batch: z.string().optional().describe('Batch _id or human batchNumber.'),
				customer: z.string().optional().describe('Assigned customer name.'),
				limit: z.number().int().min(1).max(100).optional().describe('Max rows (default 25).')
			})
		},
		async ({ status, batch, customer, limit }) =>
			callAgentApi(fetcher, '/api/agent/operations/spus', { query: { status, batch, customer, limit } })
	);

	// -------------------------------------------------------------- kanban

	server.registerTool(
		'kanban_board_snapshot',
		{ annotations: READ_ONLY,
			description:
				`The full kanban board: all projects and their tasks grouped by column (${OPS_STATUSES.join(', ')}) ` +
				'plus recent activity. Call this before creating or updating tasks so you have current task/project ids.'
		},
		async () => callAgentApi(fetcher, '/api/agent/operations/kanban/board-snapshot')
	);

	server.registerTool(
		'kanban_projects_overview',
		{ annotations: READ_ONLY, description: 'Kanban projects with per-project task-status counts.' },
		async () => callAgentApi(fetcher, '/api/agent/operations/projects')
	);

	server.registerTool(
		'kanban_capture',
		{ annotations: WRITE_TOOL,
			description:
				'Capture a kanban option (one line is enough). Everything starts as a captured Tier-1 option — no status choice; ' +
				'sizing/classing happen at processing (kanban_process) and commitment happens at replenishment (kanban_replenish). ' +
				'DISCOVERED-WORK TEST — when the idea came up while working another task, ask: "If work stopped right now, is that ' +
				"task's stated outcome achieved?\" YES → capture here with origin:'discovered' and spawnedFrom set. NO → it was always " +
				'inside that task — append it there with kanban_update_task appendContext instead of capturing a new item. ' +
				'For a spike (timeboxed investigation), set itemType:spike with question + timebox — a spike cannot be created without them. ' +
				'SIZING TEST (apply when shaping work): can you confidently pick a size? Yes → deliverable. No but the next milestone is ' +
				'nameable → capture the milestone, not the project. No milestone nameable → spike. Otherwise it is a project — only its milestones flow. ' +
				'For ultra-defined recurring work (SPU builds, cartridge fills), pass templateId (see kanban_list_templates) — the item lands already processed and DoR-complete.',
			inputSchema: z.object({
				title: z.string().optional().describe('One line is enough. Optional when templateId is given (template supplies it).'),
				templateId: z.string().optional().describe('Capture from a workflow template — lands processed + replenishable.'),
				projectId: z.string().describe('The kanban project _id.'),
				board: z.enum(['ops', 'software']).optional().describe('Which board (default ops).'),
				description: z.string().optional(),
				origin: z.enum(['planned', 'discovered']).optional().describe("'discovered' when it emerged while working another item."),
				spawnedFrom: z.string().optional().describe('Task id that was being worked when this was discovered.'),
				itemType: z.enum(['deliverable', 'spike', 'chore']).optional(),
				spike: z
					.object({
						question: z.string().describe('The question the spike answers. If it cannot be written, the uncertainty is not shaped enough to fund.'),
						timebox: z.object({ amount: z.number(), unit: z.enum(['hours', 'days']) })
					})
					.optional()
					.describe('Required when itemType is spike.'),
				assignedTo: z.string().optional().describe('User _id to assign.'),
				dueDate: z.string().optional().describe('ISO date string.'),
				tags: z.array(z.string()).optional(),
				parentTaskId: z.string().optional().describe('Create as a subtask of this task.'),
				sourceRef: z.string().optional().describe('External reference (e.g. pr:123, branch:name, or a ticket id).'),
				actor: z.string().optional().describe('Username of the human driving this change (defaults to "agent").')
			})
		},
		async (args) =>
			callAgentApi(fetcher, '/api/agent/operations/kanban/tasks', { method: 'POST', body: { ...args, source: 'mcp' } })
	);

	server.registerTool(
		'kanban_update_task',
		{ annotations: WRITE_TOOL,
			description:
				'Update a kanban task: move it within Tier 2 (status), retitle, describe, resize, reassign, re-project, ' +
				'set due date/tags, or append context notes. Status changes go through the transition service and record a transition history entry. ' +
				'Tier crossings (e.g. captured → ready) are rejected server-side — commitment-point crossings go through kanban_replenish / kanban_demote. ' +
				'Pulling ready → wip is only allowed from the top of the queue (pull window, default top 3). Audit-logged.',
			inputSchema: z.object({
				taskId: z.string().describe('The task _id to update.'),
				title: z.string().optional(),
				description: z.string().optional().describe('Replaces the description.'),
				appendContext: z.string().optional().describe('Appends a context note instead of replacing the description.'),
				status: z.enum(TIER2_MOVE_STATUSES).optional().describe('Move to this Tier-2 column. Tier crossings are rejected server-side.'),
				sizeClass: z.enum(SIZE_CLASS_VALUES).optional().describe('Size class (short/medium/long).'),
				reason: z.string().optional().describe('Required when moving to blocked (what is blocking us?).'),
				waitingOn: z.string().optional().describe('Required when moving to waiting: the named external dependency.'),
				waitingUntil: z.string().optional().describe('Required when moving to waiting: ISO follow-up date.'),
				assignedTo: z.string().optional().describe('User _id to reassign to.'),
				projectId: z.string().optional().describe('Move the task to this project.'),
				dueDate: z.string().optional().describe('ISO date string.'),
				tags: z.array(z.string()).optional(),
				sourceRef: z.string().optional().describe('External link — software items: pr:<number>, branch:<name>, commit:<sha>.'),
				dor: z
					.object({
						deliverable: z.string().optional().describe("State what will exist or be true when this is done — and how you'd verify it. Outcome, not steps."),
						handoffBrief: z.string().optional().describe('Software board: the coding-agent handoff brief.')
					})
					.optional()
					.describe('Edit Definition-of-Ready fields.'),
				actor: z.string().optional().describe('Username of the human driving this change (defaults to "agent").')
			})
		},
		async ({ taskId, ...rest }) =>
			callAgentApi(fetcher, `/api/agent/operations/kanban/tasks/${encodeURIComponent(taskId)}`, {
				method: 'PATCH',
				body: rest
			})
	);

	// ------------------------------------------- kanban: the commitment point

	server.registerTool(
		'kanban_replenishment_status',
		{ annotations: READ_ONLY,
			description:
				'The "should we replenish?" view: Tier-1 candidates with Definition-of-Ready readiness (exact missing fields), ' +
				'current ready queue vs its cap, minimum-order-point signal, and WIP share by class of service. ' +
				'Call this before kanban_replenish, and whenever asked how the queue is doing.',
			inputSchema: z.object({
				board: z.enum(['ops', 'software']).optional().describe('Which board (default ops).')
			})
		},
		async ({ board }) =>
			callAgentApi(fetcher, '/api/agent/operations/kanban/replenishment-status', { query: { board } })
	);

	server.registerTool(
		'kanban_replenish',
		{ annotations: WRITE_TOOL,
			description:
				'THE commitment point: promote Tier-1 options into the global ready queue, in the given order. ' +
				'Only a human commits work — `actor` must be the username of the human you are working with, and they must hold ' +
				'the kanban:replenish permission. NEVER guess or invent the actor; if you do not know who you are working with, ask. ' +
				'Items must satisfy the Definition of Ready (deliverable statement; software items also need a handoff brief) and the ' +
				'ready cap must have room — rejected items come back with exact reasons. One replenishment event id covers the batch (the decision record).',
			inputSchema: z.object({
				taskIds: z.array(z.string()).min(1).describe('Task ids to promote, in desired queue order.'),
				actor: z.string().describe('Username of the human making this commitment (required — never guess).'),
				board: z.enum(['ops', 'software']).optional().describe('Which board (default ops).'),
				note: z.string().optional().describe('Optional note recorded on the replenishment event.')
			})
		},
		async (args) => callAgentApi(fetcher, '/api/agent/operations/kanban/replenish', { method: 'POST', body: args })
	);

	server.registerTool(
		'kanban_demote',
		{ annotations: WRITE_TOOL,
			description:
				'Unwind a commitment honestly: move a ready/waiting/blocked item back to Tier 1 (processed). ' +
				'Requires the human actor (kanban:replenish) and a reason. A wip item must leave wip first — deliberate friction.',
			inputSchema: z.object({
				taskId: z.string(),
				actor: z.string().describe('Username of the human making this decision (required — never guess).'),
				reason: z.string().describe('Why the commitment is being unwound.')
			})
		},
		async (args) => callAgentApi(fetcher, '/api/agent/operations/kanban/demote', { method: 'POST', body: args })
	);

	server.registerTool(
		'kanban_reorder_queue',
		{ annotations: WRITE_TOOL,
			description:
				'Explicit, audited re-rank. scope "ready" reorders the global commitment queue (actor needs kanban:replenish); ' +
				'scope {projectId} reorders Tier-1 options within a project. Ranks are strict ordinals — no ties; ' +
				'items in scope but omitted from the order keep their relative order after the listed ones.',
			inputSchema: z.object({
				scope: z
					.union([z.literal('ready'), z.object({ projectId: z.string() })])
					.describe('"ready" for the global queue, or {projectId} for Tier-1 project ranking.'),
				orderedTaskIds: z.array(z.string()).min(1).describe('Task ids in the desired new order (rank 1 first).'),
				actor: z.string().describe('Username of the human driving this change (required — never guess).'),
				board: z.enum(['ops', 'software']).optional().describe('Which board (default ops).')
			})
		},
		async (args) => callAgentApi(fetcher, '/api/agent/operations/kanban/reorder', { method: 'POST', body: args })
	);

	// -------------------------------------------- kanban: processing (triage)

	server.registerTool(
		'kanban_process',
		{ annotations: WRITE_TOOL,
			description:
				'Process (triage) a captured option: set its size class and class of service — the once-per-item shaping decision, ' +
				'made by the person processing (never the author or eventual assignee; this removes the inflation incentive). ' +
				'Also the moment to write the Definition-of-Ready: dor.deliverable states what will exist or be true when this is ' +
				"done — and how you'd verify it. Outcome, not steps — step lists go stale; outcomes survive a change of approach. " +
				'fixed_date requires a real external dueDate. `actor` = the human doing the processing (never guess). ' +
				'SIZING TEST — size class is a measurement bucket, never a time promise (SLEs are computed from history): ' +
				'can you confidently pick a size? Yes → size it. No but the next milestone is nameable → split; size the milestone. ' +
				'No milestone nameable → convert to a spike and timebox the question. Otherwise it is a project — keep it upstream. ' +
				"Can't write the deliverable? If you don't know enough to say what 'done' looks like, this isn't a deliverable yet — " +
				"make it a spike: a timeboxed investigation with a question ('Can X work?') and a timebox (e.g. 2 days). A spike is " +
				"done when the timebox ends — 'we still don't know' is a valid recorded answer.",
			inputSchema: z.object({
				taskId: z.string(),
				actor: z.string().describe('Username of the human processing (required — never guess).'),
				sizeClass: z.enum(['short', 'medium', 'long']).describe('Per the written definitions in policy (kanban_get_policy shows them).'),
				classOfService: z.enum(['standard', 'fixed_date', 'chore', 'expedite']),
				dueDate: z.string().optional().describe('ISO date — required for fixed_date.'),
				dor: z
					.object({
						deliverable: z.string().optional().describe("State what will exist or be true when this is done — and how you'd verify it. Outcome, not steps."),
						handoffBrief: z.string().optional().describe('Software board: the coding-agent handoff brief.')
					})
					.optional()
			})
		},
		async (args) => callAgentApi(fetcher, '/api/agent/operations/kanban/process', { method: 'POST', body: args })
	);

	server.registerTool(
		'kanban_disposition',
		{ annotations: WRITE_TOOL,
			description:
				'Tier-1 dispositions: icebox (park indefinitely — visible, skipped at processing), decline (explicitly not doing; ' +
				'reason required and kept for the record), thaw (un-park an iceboxed option back to captured).',
			inputSchema: z.object({
				taskId: z.string(),
				action: z.enum(['icebox', 'decline', 'thaw']),
				actor: z.string().describe('Username of the human deciding (required — never guess).'),
				reason: z.string().optional().describe('Required for decline.')
			})
		},
		async (args) => callAgentApi(fetcher, '/api/agent/operations/kanban/disposition', { method: 'POST', body: args })
	);

	server.registerTool(
		'kanban_close_spike',
		{ annotations: WRITE_TOOL,
			description:
				'Close a spike: record the outcome and file what was learned as new captured options (origin discovered). ' +
				'"We spent the timebox and still don\'t know" is a VALID outcome — never treat an unanswered spike as failure. ' +
				'A spike\'s output is options, not tasks.',
			inputSchema: z.object({
				taskId: z.string(),
				actor: z.string().describe('Username (required — never guess).'),
				outcome: z.string().describe('What was learned, including "still unknown".'),
				spawnOptions: z
					.array(z.object({ title: z.string(), description: z.string().optional() }))
					.optional()
					.describe('New options this spike surfaced — filed as captured/discovered.')
			})
		},
		async (args) => callAgentApi(fetcher, '/api/agent/operations/kanban/spikes/close', { method: 'POST', body: args })
	);

	// ------------------------------------------- kanban: metrics + policy

	server.registerTool(
		'kanban_flow_metrics',
		{ annotations: READ_ONLY,
			description:
				'Flow metrics for a board: Work Item Age for every unfinished item (vs SLE bands, with flow-debt flags — items that ' +
				'aged while newer ones finished, the signature of cherry-picking), weekly throughput, discovered-work ratio with a ' +
				'queue-fill suggestion, expedite rate, and flow efficiency. Deliberately contains NO per-person statistics — the ' +
				'pathology is diagnosed in the work, not in people. Call when asked "what is stuck", "how is flow", or before replenishment.',
			inputSchema: z.object({
				board: z.enum(['ops', 'software']).optional().describe('Which board (default ops).')
			})
		},
		async ({ board }) => callAgentApi(fetcher, '/api/agent/operations/kanban/flow-metrics', { query: { board } })
	);

	server.registerTool(
		'kanban_get_policy',
		{ annotations: READ_ONLY,
			description:
				'Read the kanban policy: ready caps, min order points, WIP limits, pull window, expedite limits, class allocations, ' +
				'size-class definitions, SLE seeds, and the recalibration due date.'
		},
		async () => callAgentApi(fetcher, '/api/agent/operations/kanban/policy')
	);

	server.registerTool(
		'kanban_set_policy',
		{ annotations: WRITE_TOOL,
			description:
				'Tune kanban policy knobs at runtime (no deploy). `actor` must hold kanban:admin. ' +
				'updates is a map of dot-path → value, e.g. {"boards.ops.readyCap": 10, "pullWindow": 3}. ' +
				'Valid paths: boards.{ops|software}.{readyCap|minOrderPoint}, wipPerPerson, wipChoreMax, pullWindow, ' +
				'expedite.{systemMax|alertPctRolling30d}, allocation.{standard|fixed_date|chore}, ' +
				'sizeClassDefinitions.{short|medium|long}, sle.percentile, sle.perSizeClassDays.{short|medium|long}, recalibrateAfter.',
			inputSchema: z.object({
				actor: z.string().describe('Username with kanban:admin (required — never guess).'),
				updates: z.record(z.string(), z.union([z.string(), z.number()])).describe('Dot-path → new value.')
			})
		},
		async (args) => callAgentApi(fetcher, '/api/agent/operations/kanban/policy', { method: 'PATCH', body: args })
	);

	// ------------------------------------------- kanban: workflow templates

	server.registerTool(
		'kanban_list_templates',
		{ annotations: READ_ONLY,
			description:
				'List workflow templates for ultra-defined recurring work (SPU builds, cartridge fills). ' +
				'Capture from one via kanban_capture templateId — the item lands already processed and DoR-complete.'
		},
		async () => callAgentApi(fetcher, '/api/agent/operations/kanban/templates')
	);

	server.registerTool(
		'kanban_set_template',
		{ annotations: WRITE_TOOL,
			description:
				'Create or update a workflow template (actor needs kanban:admin). Templates encode the SOP shape once: ' +
				'title, size class, class of service, and a pre-written DoR deliverable. Spikes cannot be templated.',
			inputSchema: z.object({
				actor: z.string().describe('Username with kanban:admin (required — never guess).'),
				templateId: z.string().optional().describe('Omit to create; provide to update.'),
				name: z.string().optional(),
				board: z.enum(['ops', 'software']).optional(),
				itemType: z.enum(['deliverable', 'chore']).optional(),
				sizeClass: z.enum(['short', 'medium', 'long']).optional(),
				classOfService: z.enum(['standard', 'fixed_date', 'chore', 'expedite']).optional(),
				titleTemplate: z.string().optional(),
				dor: z.object({ deliverable: z.string().describe("What will exist or be true when this is done — and how you'd verify it. Outcome, not steps."), handoffBrief: z.string().optional() }).optional(),
				tags: z.array(z.string()).optional(),
				defaultProjectId: z.string().optional(),
				active: z.boolean().optional(),
				notes: z.string().optional()
			})
		},
		async (args) => callAgentApi(fetcher, '/api/agent/operations/kanban/templates', { method: 'POST', body: args })
	);

	// ------------------------------------------- kanban: standing work (supply)

	server.registerTool(
		'kanban_standing_status',
		{ annotations: READ_ONLY,
			description:
				'Supply loops (KB2-13): live actual-vs-target for standing targets (e.g. "keep 40 filled cartridges on hand") PLUS ' +
				'parts at/below their minimum order qty (partsReorder rows — no per-part targets needed). Pass spawn:true to also ' +
				'spawn the supply cards for anything below its trigger (idempotent — never duplicates). Spawned cards are ' +
				'auto-shaped and auto-committed straight to the bottom of the ready queue (exempt from ready cap, chore allocation, ' +
				'and pull window) unless the target has autoCommit:false.',
			inputSchema: z.object({
				spawn: z.boolean().optional().describe('Also spawn supply cards for targets/parts below their trigger.'),
				actor: z.string().optional().describe('Username recorded on spawned cards (defaults to system:supply).')
			})
		},
		async ({ spawn, actor }) =>
			callAgentApi(fetcher, '/api/agent/operations/kanban/standing', {
				query: { spawn: spawn ? '1' : undefined, actor }
			})
	);

	server.registerTool(
		'kanban_set_standing_target',
		{ annotations: WRITE_TOOL,
			description:
				'Create or update a standing supply target. metric.kind: cartridge_phase_count (params.statuses[], optional ' +
				'params.skus[]), part_stock (params.partId), reagent_stock (params.catalogId/variantKey/type, optional ' +
				'params.statuses[] default ["active"], params.measure "count"|"volume"), or manual (params.value). Below the ' +
				'reorder point the system spawns ONE supply card, auto-committed straight to ready (KB2-13) — set ' +
				'autoCommit:false to instead file a captured option through the normal commitment point. templateId links a ' +
				'KanbanTemplate whose shape (size/class/DoR) the spawned card uses.',
			inputSchema: z.object({
				actor: z.string().describe('Username (required — never guess).'),
				targetId: z.string().optional().describe('Omit to create; provide to update.'),
				name: z.string().optional(),
				metric: z
					.object({
						kind: z.enum(['cartridge_phase_count', 'part_stock', 'reagent_stock', 'manual']),
						params: z.record(z.string(), z.unknown()).optional()
					})
					.optional(),
				target: z.number().optional(),
				reorderPoint: z.number().optional(),
				batchSize: z.number().optional(),
				spawnItemType: z.enum(['chore', 'deliverable']).optional(),
				spawnSizeClass: z.enum(['short', 'medium', 'long']).optional().describe('Size class stamped on spawned cards (default short).'),
				autoCommit: z.boolean().optional().describe('Default true: spawned cards land directly in ready. false = KB2-10 captured option.'),
				templateId: z.string().optional().describe('Optional KanbanTemplate whose shape the spawned card uses.'),
				active: z.boolean().optional(),
				notes: z.string().optional()
			})
		},
		async (args) => callAgentApi(fetcher, '/api/agent/operations/kanban/standing', { method: 'POST', body: args })
	);

	server.registerTool(
		'kanban_create_subtasks',
		{ annotations: WRITE_TOOL,
			description:
				'Bulk-create subtasks under a parent kanban task. Every subtask starts as a captured Tier-1 option. Each subtask is audit-logged.',
			inputSchema: z.object({
				parentTaskId: z.string().describe('The parent task _id.'),
				subtasks: z
					.array(
						z.object({
							title: z.string(),
							description: z.string().optional(),
							assignedTo: z.string().optional(),
							dueDate: z.string().optional(),
							tags: z.array(z.string()).optional()
						})
					)
					.min(1)
					.describe('Subtasks to create.'),
				actor: z.string().optional().describe('Username of the human driving this change (defaults to "agent").')
			})
		},
		async ({ parentTaskId, subtasks, actor }) =>
			callAgentApi(fetcher, `/api/agent/operations/kanban/tasks/${encodeURIComponent(parentTaskId)}/subtasks`, {
				method: 'POST',
				body: { subtasks, actor }
			})
	);

	server.registerTool(
		'kanban_merge_tasks',
		{ annotations: WRITE_TOOL,
			description:
				'Merge one kanban task into another: the source task\'s description and tags fold into the target, and the source is archived. ' +
				'Use for duplicates. Audit-logged on both tasks.',
			inputSchema: z.object({
				targetTaskId: z.string().describe('The task that survives.'),
				sourceTaskId: z.string().describe('The duplicate task to fold in and archive.'),
				reason: z.string().optional().describe('Why the merge was made.')
			})
		},
		async (args) => callAgentApi(fetcher, '/api/agent/operations/kanban/tasks/merge', { method: 'POST', body: args })
	);

	server.registerTool(
		'kanban_task_transitions',
		{ annotations: READ_ONLY,
			description: 'The status-transition history of a kanban task (when it moved between columns and why).',
			inputSchema: z.object({ taskId: z.string().describe('The task _id.') })
		},
		async ({ taskId }) =>
			callAgentApi(fetcher, `/api/agent/operations/kanban/tasks/${encodeURIComponent(taskId)}/transitions`)
	);

	server.registerTool(
		'kanban_propose_changes',
		{ annotations: WRITE_TOOL,
			description:
				'Attach improvement proposals (split / merge / enrich) to kanban tasks for a human to approve, edit, or veto. ' +
				'Use this instead of direct mutation when a change is judgment-heavy and should be reviewed.',
			inputSchema: z.object({
				proposals: z
					.array(
						z.object({
							type: z.enum(['split', 'merge', 'enrich']),
							targetTaskId: z.string(),
							details: z.string().optional().describe('Human-readable rationale.'),
							suggestedActions: z.array(z.string()).optional()
						})
					)
					.min(1)
			})
		},
		async ({ proposals }) =>
			callAgentApi(fetcher, '/api/agent/operations/kanban/proposals', { method: 'POST', body: { proposals } })
	);

	server.registerTool(
		'kanban_decide_proposal',
		{ annotations: WRITE_TOOL,
			description: 'Resolve a pending kanban proposal: approve, edit, or veto it.',
			inputSchema: z.object({
				proposalId: z.string().describe('The proposal id.'),
				decision: z.enum(['approved', 'edited', 'vetoed']),
				reason: z.string().optional(),
				editNotes: z.string().optional(),
				decidedBy: z.string().optional().describe('Who made the decision.')
			})
		},
		async ({ proposalId, ...rest }) =>
			callAgentApi(fetcher, `/api/agent/operations/kanban/proposals/${encodeURIComponent(proposalId)}`, {
				method: 'PATCH',
				body: rest
			})
	);

	server.registerTool(
		'kanban_list_violations',
		{ annotations: READ_ONLY,
			description:
				'List kanban workflow violations (e.g. WIP-limit breaches, stale tasks). Filter by resolution state, type, or task.',
			inputSchema: z.object({
				resolved: z.boolean().optional(),
				type: z.string().optional(),
				taskId: z.string().optional(),
				page: z.number().int().min(1).optional(),
				limit: z.number().int().min(1).max(100).optional()
			})
		},
		async (args) => callAgentApi(fetcher, '/api/agent/operations/kanban/violations', { query: args })
	);

	server.registerTool(
		'kanban_report_violation',
		{ annotations: WRITE_TOOL,
			description: 'Record a kanban workflow violation against a task. Audit-logged.',
			inputSchema: z.object({
				type: z.string().describe('Violation type slug.'),
				taskId: z.string(),
				description: z.string(),
				assignee: z.string().optional(),
				severity: z.string().optional()
			})
		},
		async (args) => callAgentApi(fetcher, '/api/agent/operations/kanban/violations', { method: 'POST', body: args })
	);

	// ----------------------------------------------------------- approvals

	server.registerTool(
		'list_approvals',
		{ annotations: READ_ONLY,
			description: 'List change-approval requests, optionally filtered by status (pending, approved, rejected, …).',
			inputSchema: z.object({
				status: z.string().optional(),
				page: z.number().int().min(1).optional()
			})
		},
		async (args) => callAgentApi(fetcher, '/api/agent/approvals', { query: args })
	);

	server.registerTool(
		'create_approval_request',
		{ annotations: WRITE_TOOL,
			description:
				'Open a change-approval request for a human stakeholder to review. Use before making changes that need sign-off. Audit-logged.',
			inputSchema: z.object({
				changeTitle: z.string(),
				changeType: z.string().describe('Category of change (e.g. process, document, equipment).'),
				changeDescription: z.string().optional(),
				priority: z.string().optional(),
				requesterId: z.string().optional(),
				affectedSystems: z.array(z.string()).optional(),
				impactAnalysis: z.string().optional(),
				dueDate: z.string().optional().describe('ISO date string.')
			})
		},
		async (args) => callAgentApi(fetcher, '/api/agent/approvals', { method: 'POST', body: args })
	);

	server.registerTool(
		'decide_approval_request',
		{ annotations: WRITE_TOOL,
			description: 'Progress an approval request: reviewed, approved, rejected, escalated, cancelled, or add a comment. Audit-logged.',
			inputSchema: z.object({
				approvalId: z.string(),
				action: z.enum(['requested', 'reviewed', 'approved', 'rejected', 'escalated', 'cancelled', 'commented']),
				stakeholderId: z.string().optional(),
				comments: z.string().optional(),
				decisionRationale: z.string().optional()
			})
		},
		async (args) => callAgentApi(fetcher, '/api/agent/approvals', { method: 'PATCH', body: args })
	);

	// ------------------------------------------------------------ messages

	server.registerTool(
		'list_messages',
		{ annotations: READ_ONLY,
			description: 'List agent messages to/from a BIMS user (notifications, questions, escalations).',
			inputSchema: z.object({
				userId: z.string().describe('The BIMS user _id whose messages to list.'),
				status: z.string().optional(),
				page: z.number().int().min(1).optional(),
				limit: z.number().int().min(1).max(100).optional()
			})
		},
		async (args) => callAgentApi(fetcher, '/api/agent/messages', { query: args })
	);

	server.registerTool(
		'send_message',
		{ annotations: WRITE_TOOL,
			description: 'Send a message to a BIMS user (appears in their in-app agent inbox). Audit-logged.',
			inputSchema: z.object({
				toUserId: z.string(),
				content: z.string(),
				subject: z.string().optional(),
				messageType: z.string().optional(),
				priority: z.string().optional(),
				relatedEntityType: z.string().optional(),
				relatedEntityId: z.string().optional()
			})
		},
		async (args) => callAgentApi(fetcher, '/api/agent/messages', { method: 'POST', body: args })
	);

	// ---------------------------------------------------------- cartridges

	server.registerTool(
		'get_cartridge_photos',
		{ annotations: READ_ONLY,
			description:
				'All photos for a cartridge by barcode, grouped by manufacturing phase, with tags and notes. Returns public image URLs.',
			inputSchema: z.object({ barcode: z.string().describe('The cartridge barcode.') })
		},
		async ({ barcode }) => callAgentApi(fetcher, `/api/agent/cartridge/${encodeURIComponent(barcode)}/photos`)
	);

	return server;
}
