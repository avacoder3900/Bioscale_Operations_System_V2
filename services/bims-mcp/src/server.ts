import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { getSpuStatus, listSpus, BimsError } from './bims-client.js';

/** Wrap a tool body so BIMS errors become readable tool errors instead of crashes. */
async function runTool(fn: () => Promise<any>) {
	try {
		const data = await fn();
		return {
			content: [{ type: 'text' as const, text: JSON.stringify(data, null, 2) }]
		};
	} catch (e) {
		const msg = e instanceof BimsError ? e.message : `Unexpected error: ${(e as Error)?.message ?? e}`;
		return {
			isError: true,
			content: [{ type: 'text' as const, text: msg }]
		};
	}
}

/**
 * Build a fresh MCP server with the BIMS SPU tools registered.
 * A new instance is created per HTTP request in stateless mode.
 */
export function createBimsMcpServer(): McpServer {
	const server = new McpServer({
		name: 'bims-spu',
		version: '0.1.0'
	});

	server.registerTool(
		'get_spu_status',
		{
			title: 'Get SPU status',
			description:
				'Look up a single SPU and return its current status: lifecycle status, assembly/QC status, ' +
				'batch, assigned customer, linked Particle device, and per-modality validation results ' +
				'(magnetometer, thermocouple, lux, spectrophotometer). Provide exactly one identifier.',
			inputSchema: {
				spuId: z.string().optional().describe('The SPU _id (nanoid).'),
				udi: z.string().optional().describe('The SPU UDI.'),
				barcode: z.string().optional().describe('The SPU barcode.')
			}
		},
		async ({ spuId, udi, barcode }) => {
			if (!spuId && !udi && !barcode) {
				return {
					isError: true,
					content: [{ type: 'text' as const, text: 'Provide one of: spuId, udi, or barcode.' }]
				};
			}
			return runTool(() => getSpuStatus({ spuId, udi, barcode }));
		}
	);

	server.registerTool(
		'list_spus',
		{
			title: 'List SPUs',
			description:
				'List SPUs with optional filters and a status breakdown. Filter by lifecycle status ' +
				'(draft, assembling, validating, released, servicing, retired), ' +
				'by batch (id or batchNumber), or by customer name. ' +
				'Returns up to `limit` SPUs (default 25, max 100), newest first.',
			inputSchema: {
				status: z.string().optional().describe('Lifecycle status to filter by.'),
				batch: z.string().optional().describe('Batch _id or human batchNumber.'),
				customer: z.string().optional().describe('Assigned customer name.'),
				limit: z.number().int().min(1).max(100).optional().describe('Max rows (default 25).')
			}
		},
		async ({ status, batch, customer, limit }) =>
			runTool(() => listSpus({ status, batch, customer, limit }))
	);

	return server;
}
