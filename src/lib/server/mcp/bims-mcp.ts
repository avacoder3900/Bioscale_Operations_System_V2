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
	const server = new McpServer({ name: 'bims-operations', version: '1.0.0' });

	// ---------------------------------------------------------------- meta

	server.registerTool(
		'list_collections',
		{
			description:
				'List every queryable BIMS collection with its business metadata (what each collection holds, key fields). ' +
				'Call this first when you are unsure where a piece of data lives.'
		},
		async () => callAgentApi(fetcher, '/api/agent/schema')
	);

	server.registerTool(
		'system_dependencies',
		{
			description: 'List the BIMS system dependency map (which subsystems depend on which services/integrations).'
		},
		async () => callAgentApi(fetcher, '/api/agent/dependencies')
	);

	// ------------------------------------------------------------- queries

	server.registerTool(
		'list_saved_queries',
		{
			description:
				'List the saved, parameterized read queries available to agents (id, name, parameters schema, target collection). ' +
				'Call this before run_saved_query to discover valid queryId values.'
		},
		async () => callAgentApi(fetcher, '/api/agent/query')
	);

	server.registerTool(
		'run_saved_query',
		{
			description:
				'Execute a saved read-only query against an allowlisted BIMS collection. ' +
				'Use list_saved_queries first to find the queryId and its parameter schema. Returns up to the query\'s maxRows (default 100).',
			inputSchema: z.object({
				queryId: z.string().describe('The saved query _id from list_saved_queries.'),
				parameters: z
					.record(z.string(), z.union([z.string(), z.number(), z.boolean()]))
					.optional()
					.describe('Optional filter parameters merged into the query (scalar values only).')
			})
		},
		async ({ queryId, parameters }) =>
			callAgentApi(fetcher, '/api/agent/query', { method: 'POST', body: { queryId, parameters } })
	);

	// ---------------------------------------------------------- operations

	server.registerTool(
		'operations_summary',
		{
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
		{
			description:
				'Full operations rollup: task counts, equipment status, inventory, production, recent audit activity, and pending approvals. ' +
				'Call this when asked for an overall status of the plant/system.'
		},
		async () => callAgentApi(fetcher, '/api/agent/operations/dashboard')
	);

	server.registerTool(
		'operations_alerts',
		{
			description:
				'Current synthesized alerts sorted by severity: low-stock parts, problem equipment, overdue tasks, stale approvals, failed messages. ' +
				'Call this when asked "what needs attention" or "any problems right now".'
		},
		async () => callAgentApi(fetcher, '/api/agent/operations/alerts')
	);

	server.registerTool(
		'operations_context',
		{
			description:
				'Active work context: active projects, in-progress tasks, equipment alerts, pending approvals and messages. ' +
				'Useful as a first call to orient on what is currently happening.'
		},
		async () => callAgentApi(fetcher, '/api/agent/operations/context')
	);

	server.registerTool(
		'inventory_overview',
		{ description: 'Inventory state: active parts, low-stock list, categories, and BOM count.' },
		async () => callAgentApi(fetcher, '/api/agent/operations/inventory')
	);

	server.registerTool(
		'parts_lookup',
		{
			description:
				'Resolve a part reference to BIMS part definitions with live inventory counts. Accepts a scanned part barcode, ' +
				'an exact part number (e.g. PT-SPU-008), or free-text like "screw for upper metal bracket" (every word must match ' +
				'the part name/description/number/category). Use this to turn vague part descriptions from operators into concrete ' +
				'part numbers before recording inventory usage. If it returns multiple candidates, ask the user which one they mean; ' +
				'if it returns none, ask the user to scan the part barcode and retry with barcode.',
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
		{
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
		{
			description:
				'Deduct parts from inventory after SPU assembly/reassembly work, grouped per SPU. Each deduction is recorded as an ' +
				'immutable inventory transaction linked to the SPU, and audit-logged.\n\n' +
				'WORKFLOW (follow exactly):\n' +
				'1. From the operator\'s message, identify each SPU (barcode, UDI, or short number like "SPU 203") and the parts used. ' +
				'Resolve vague part descriptions with parts_lookup; ask clarifying questions if a description is too vague or matches ' +
				'multiple parts. If the operator says what area they worked on but not which parts (e.g. "changed magnets in heating ' +
				'block" with no specifics), ask them to scan the SPU barcode and then each part barcode.\n' +
				'2. Before calling this tool, show the operator a confirmation list: one group per SPU, headed by the SPU barcode and ' +
				'its last 5 characters, with one row per part ("<partNumber> <name> — qty: __"). Leave quantity blank wherever the ' +
				'operator has not stated it and ask them to fill each blank in. The same part used on different SPUs gets its own row ' +
				'(and its own quantity) under each SPU.\n' +
				'3. Only after the operator confirms the complete list (all quantities filled) call this tool with confirmed: true. ' +
				'Never call it with unconfirmed or guessed quantities.\n\n' +
				'The request is atomic: if any SPU or part fails to resolve, nothing is deducted and per-entry errors come back — ' +
				'fix them with the user and retry. On success, report each SPU\'s deductions with previous → new counts.',
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
		'equipment_overview',
		{ description: 'Equipment list with locations and a status summary (operational / maintenance / problem).' },
		async () => callAgentApi(fetcher, '/api/agent/operations/equipment')
	);

	server.registerTool(
		'documents_overview',
		{ description: 'Controlled documents and work instructions with status breakdown (draft / review / approved).' },
		async () => callAgentApi(fetcher, '/api/agent/operations/documents')
	);

	server.registerTool(
		'quality_trends',
		{ description: 'Quality metrics: test pass rate, cartridge pipeline by phase, recent wax-run completion.' },
		async () => callAgentApi(fetcher, '/api/agent/operations/quality/trends')
	);

	// ---------------------------------------------------------------- SPUs

	server.registerTool(
		'get_spu_status',
		{
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
		{
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
		{
			description:
				`The full kanban board: all projects and their tasks grouped by column (${OPS_STATUSES.join(', ')}) ` +
				'plus recent activity. Call this before creating or updating tasks so you have current task/project ids.'
		},
		async () => callAgentApi(fetcher, '/api/agent/operations/kanban/board-snapshot')
	);

	server.registerTool(
		'kanban_projects_overview',
		{ description: 'Kanban projects with per-project task-status counts.' },
		async () => callAgentApi(fetcher, '/api/agent/operations/projects')
	);

	server.registerTool(
		'kanban_capture',
		{
			description:
				'Capture a kanban option (one line is enough). Everything starts as a captured Tier-1 option — no status choice; ' +
				'sizing/classing happen at processing (kanban_process) and commitment happens at replenishment (kanban_replenish). ' +
				'DISCOVERED-WORK TEST — when the idea came up while working another task, ask: "If work stopped right now, is that ' +
				"task's stated outcome achieved?\" YES → capture here with origin:'discovered' and spawnedFrom set. NO → it was always " +
				'inside that task — append it there with kanban_update_task appendContext instead of capturing a new item. ' +
				'For a spike (timeboxed investigation), set itemType:spike with question + timebox — a spike cannot be created without them.',
			inputSchema: z.object({
				title: z.string().describe('One line is enough.'),
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
		{
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
						outcome: z.string().optional().describe('Outcome statement, not steps.'),
						acceptanceCriteria: z.string().optional(),
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
		{
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
		{
			description:
				'THE commitment point: promote Tier-1 options into the global ready queue, in the given order. ' +
				'Only a human commits work — `actor` must be the username of the human you are working with, and they must hold ' +
				'the kanban:replenish permission. NEVER guess or invent the actor; if you do not know who you are working with, ask. ' +
				'Items must satisfy the Definition of Ready (outcome statement; software items also need a handoff brief) and the ' +
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
		{
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
		{
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
		{
			description:
				'Process (triage) a captured option: set its size class and class of service — the once-per-item shaping decision, ' +
				'made by the person processing (never the author or eventual assignee; this removes the inflation incentive). ' +
				'Also the moment to write the Definition-of-Ready fields: dor.outcome must describe the OUTCOME (what is different ' +
				'in the world when this is done), not the steps — step lists go stale; outcomes survive a change of approach. ' +
				'fixed_date requires a real external dueDate. `actor` = the human doing the processing (never guess).',
			inputSchema: z.object({
				taskId: z.string(),
				actor: z.string().describe('Username of the human processing (required — never guess).'),
				sizeClass: z.enum(['short', 'medium', 'long']).describe('Per the written definitions in policy (kanban_get_policy shows them).'),
				classOfService: z.enum(['standard', 'fixed_date', 'chore', 'expedite']),
				dueDate: z.string().optional().describe('ISO date — required for fixed_date.'),
				dor: z
					.object({
						outcome: z.string().optional().describe('Outcome statement, not steps.'),
						acceptanceCriteria: z.string().optional(),
						handoffBrief: z.string().optional().describe('Software board: the coding-agent handoff brief.')
					})
					.optional()
			})
		},
		async (args) => callAgentApi(fetcher, '/api/agent/operations/kanban/process', { method: 'POST', body: args })
	);

	server.registerTool(
		'kanban_disposition',
		{
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
		{
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
		{
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
		{
			description:
				'Read the kanban policy: ready caps, min order points, WIP limits, pull window, expedite limits, class allocations, ' +
				'size-class definitions, SLE seeds, and the recalibration due date.'
		},
		async () => callAgentApi(fetcher, '/api/agent/operations/kanban/policy')
	);

	server.registerTool(
		'kanban_set_policy',
		{
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

	// ------------------------------------------- kanban: standing work (supply)

	server.registerTool(
		'kanban_standing_status',
		{
			description:
				'Standing-work supply targets (e.g. "keep 40 filled cartridges on hand"): live actual-vs-target computed from BIMS ' +
				'data, reorder-point signals, and any open build option per target. Pass spawn:true to also file one captured build ' +
				'option for each target below its reorder point (idempotent — never duplicates).',
			inputSchema: z.object({
				spawn: z.boolean().optional().describe('Also create build options for targets below reorder point.'),
				actor: z.string().optional().describe('Username, recorded on spawned options.')
			})
		},
		async ({ spawn, actor }) =>
			callAgentApi(fetcher, '/api/agent/operations/kanban/standing', {
				query: { spawn: spawn ? '1' : undefined, actor }
			})
	);

	server.registerTool(
		'kanban_set_standing_target',
		{
			description:
				'Create or update a standing supply target. metric.kind: cartridge_phase_count (params.statuses[], optional ' +
				'params.skus[]), part_stock (params.partId), or manual (params.value). Standing targets are supply signals, ' +
				'not flow items — they never enter the queue themselves.',
			inputSchema: z.object({
				actor: z.string().describe('Username (required — never guess).'),
				targetId: z.string().optional().describe('Omit to create; provide to update.'),
				name: z.string().optional(),
				metric: z
					.object({
						kind: z.enum(['cartridge_phase_count', 'part_stock', 'manual']),
						params: z.record(z.string(), z.unknown()).optional()
					})
					.optional(),
				target: z.number().optional(),
				reorderPoint: z.number().optional(),
				batchSize: z.number().optional(),
				spawnItemType: z.enum(['chore', 'deliverable']).optional(),
				active: z.boolean().optional(),
				notes: z.string().optional()
			})
		},
		async (args) => callAgentApi(fetcher, '/api/agent/operations/kanban/standing', { method: 'POST', body: args })
	);

	server.registerTool(
		'kanban_create_subtasks',
		{
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
		{
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
		{
			description: 'The status-transition history of a kanban task (when it moved between columns and why).',
			inputSchema: z.object({ taskId: z.string().describe('The task _id.') })
		},
		async ({ taskId }) =>
			callAgentApi(fetcher, `/api/agent/operations/kanban/tasks/${encodeURIComponent(taskId)}/transitions`)
	);

	server.registerTool(
		'kanban_propose_changes',
		{
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
		{
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
		{
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
		{
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
		{
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
		{
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
		{
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
		{
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
		{
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
		{
			description:
				'All photos for a cartridge by barcode, grouped by manufacturing phase, with tags and notes. Returns public image URLs.',
			inputSchema: z.object({ barcode: z.string().describe('The cartridge barcode.') })
		},
		async ({ barcode }) => callAgentApi(fetcher, `/api/agent/cartridge/${encodeURIComponent(barcode)}/photos`)
	);

	return server;
}
