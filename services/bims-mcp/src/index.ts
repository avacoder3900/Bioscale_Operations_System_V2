import 'dotenv/config';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import express from 'express';
import { createBimsMcpServer } from './server.js';
import { bimsBaseUrl } from './bims-client.js';

const TRANSPORT = (process.env.MCP_TRANSPORT ?? 'stdio').toLowerCase();

async function runStdio() {
	const server = createBimsMcpServer();
	const transport = new StdioServerTransport();
	await server.connect(transport);
	// stdout is the protocol channel — log to stderr only.
	console.error(`[bims-mcp] stdio transport ready (BIMS: ${bimsBaseUrl()})`);
}

async function runHttp() {
	const port = Number(process.env.PORT ?? 8787);
	const bearer = process.env.MCP_BEARER_TOKEN;
	if (!bearer) {
		console.error('[bims-mcp] FATAL: MCP_BEARER_TOKEN must be set in http mode.');
		process.exit(1);
	}

	const app = express();
	app.use(express.json());

	// Bearer auth on the MCP endpoint.
	app.use('/mcp', (req, res, next) => {
		const header = req.headers.authorization ?? '';
		const token = header.startsWith('Bearer ') ? header.slice(7) : '';
		if (token !== bearer) {
			res.status(401).json({
				jsonrpc: '2.0',
				error: { code: -32001, message: 'Unauthorized' },
				id: null
			});
			return;
		}
		next();
	});

	// Stateless: a fresh server + transport per request.
	app.post('/mcp', async (req, res) => {
		const server = createBimsMcpServer();
		const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
		res.on('close', () => {
			transport.close();
			server.close();
		});
		try {
			await server.connect(transport);
			await transport.handleRequest(req, res, req.body);
		} catch (e) {
			console.error('[bims-mcp] request error:', e);
			if (!res.headersSent) {
				res.status(500).json({
					jsonrpc: '2.0',
					error: { code: -32603, message: 'Internal server error' },
					id: null
				});
			}
		}
	});

	// Plain health check (no auth) for load balancers / uptime pings.
	app.get('/healthz', (_req, res) => res.json({ ok: true }));

	app.listen(port, () => {
		console.error(`[bims-mcp] http transport listening on :${port}/mcp (BIMS: ${bimsBaseUrl()})`);
	});
}

const main = TRANSPORT === 'http' ? runHttp : runStdio;
main().catch((e) => {
	console.error('[bims-mcp] fatal:', e);
	process.exit(1);
});
