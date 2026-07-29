import { McpServer } from '@modelcontextprotocol/server';
import * as z from 'zod';
import { env } from '$env/dynamic/private';

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
				'The full kanban board: all projects and their tasks grouped by column (blocked, backlog, ready, wip, waiting, done) ' +
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
		'kanban_create_task',
		{
			description:
				'Create a kanban task in a project. Requires a projectId from kanban_board_snapshot or kanban_projects_overview. ' +
				'The mutation is audit-logged server-side as agent activity.',
			inputSchema: z.object({
				title: z.string().describe('Task title (required).'),
				projectId: z.string().describe('The kanban project _id.'),
				description: z.string().optional(),
				status: z
					.enum(['blocked', 'backlog', 'ready', 'wip', 'waiting', 'done'])
					.optional()
					.describe('Initial column (default backlog).'),
				prioritized: z.boolean().optional(),
				taskLength: z.enum(['short', 'medium', 'long']).optional().describe('Effort estimate (default medium).'),
				assignedTo: z.string().optional().describe('User _id to assign.'),
				dueDate: z.string().optional().describe('ISO date string.'),
				tags: z.array(z.string()).optional(),
				parentTaskId: z.string().optional().describe('Create as a subtask of this task.'),
				sourceRef: z.string().optional().describe('External reference (e.g. a conversation or ticket id).')
			})
		},
		async (args) =>
			callAgentApi(fetcher, '/api/agent/operations/kanban/tasks', { method: 'POST', body: { ...args, source: 'mcp' } })
	);

	server.registerTool(
		'kanban_update_task',
		{
			description:
				'Update a kanban task: move it between columns (status), retitle, describe, prioritize, reassign, re-project, ' +
				'set due date/tags, or append context notes. Status changes record a transition history entry. Audit-logged.',
			inputSchema: z.object({
				taskId: z.string().describe('The task _id to update.'),
				title: z.string().optional(),
				description: z.string().optional().describe('Replaces the description.'),
				appendContext: z.string().optional().describe('Appends a context note instead of replacing the description.'),
				status: z.enum(['blocked', 'backlog', 'ready', 'wip', 'waiting', 'done']).optional().describe('Move to this column.'),
				prioritized: z.boolean().optional(),
				taskLength: z.enum(['short', 'medium', 'long']).optional(),
				assignedTo: z.string().optional().describe('User _id to reassign to.'),
				projectId: z.string().optional().describe('Move the task to this project.'),
				dueDate: z.string().optional().describe('ISO date string.'),
				tags: z.array(z.string()).optional()
			})
		},
		async ({ taskId, ...rest }) =>
			callAgentApi(fetcher, `/api/agent/operations/kanban/tasks/${encodeURIComponent(taskId)}`, {
				method: 'PATCH',
				body: rest
			})
	);

	server.registerTool(
		'kanban_create_subtasks',
		{
			description: 'Bulk-create subtasks under a parent kanban task. Each subtask is audit-logged.',
			inputSchema: z.object({
				parentTaskId: z.string().describe('The parent task _id.'),
				subtasks: z
					.array(
						z.object({
							title: z.string(),
							description: z.string().optional(),
							status: z.enum(['blocked', 'backlog', 'ready', 'wip', 'waiting', 'done']).optional(),
							assignedTo: z.string().optional(),
							dueDate: z.string().optional(),
							tags: z.array(z.string()).optional()
						})
					)
					.min(1)
					.describe('Subtasks to create.')
			})
		},
		async ({ parentTaskId, subtasks }) =>
			callAgentApi(fetcher, `/api/agent/operations/kanban/tasks/${encodeURIComponent(parentTaskId)}/subtasks`, {
				method: 'POST',
				body: { subtasks }
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
