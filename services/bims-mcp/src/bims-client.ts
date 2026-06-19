/**
 * Thin authenticated client for the BIMS agent API.
 * Every call sends the AGENT_API_KEY as x-api-key (the header BIMS validates).
 */

const BASE_URL = (process.env.BIMS_BASE_URL ?? 'http://localhost:5173').replace(/\/$/, '');
const AGENT_API_KEY = process.env.AGENT_API_KEY ?? '';

export class BimsError extends Error {
	status: number;
	constructor(status: number, message: string) {
		super(message);
		this.status = status;
		this.name = 'BimsError';
	}
}

async function bimsGet(path: string, params: Record<string, string | undefined>): Promise<any> {
	if (!AGENT_API_KEY) {
		throw new BimsError(0, 'AGENT_API_KEY is not set — the MCP server cannot authenticate to BIMS.');
	}

	const url = new URL(BASE_URL + path);
	for (const [k, v] of Object.entries(params)) {
		if (v !== undefined && v !== null && v !== '') url.searchParams.set(k, v);
	}

	let res: Response;
	try {
		res = await fetch(url, {
			method: 'GET',
			headers: { 'x-api-key': AGENT_API_KEY, accept: 'application/json' }
		});
	} catch (e: any) {
		throw new BimsError(0, `Could not reach BIMS at ${BASE_URL}: ${e?.message ?? e}`);
	}

	const text = await res.text();
	let body: any;
	try {
		body = text ? JSON.parse(text) : {};
	} catch {
		body = { raw: text };
	}

	if (!res.ok) {
		const msg = body?.error || body?.message || res.statusText;
		throw new BimsError(res.status, `BIMS ${res.status}: ${msg}`);
	}
	return body;
}

const SPUS_PATH = '/api/agent/operations/spus';

export function getSpuStatus(args: { spuId?: string; udi?: string; barcode?: string }) {
	return bimsGet(SPUS_PATH, {
		spuId: args.spuId,
		udi: args.udi,
		barcode: args.barcode
	});
}

export function listSpus(args: { status?: string; batch?: string; customer?: string; limit?: number }) {
	return bimsGet(SPUS_PATH, {
		status: args.status,
		batch: args.batch,
		customer: args.customer,
		limit: args.limit !== undefined ? String(args.limit) : undefined
	});
}

export function bimsBaseUrl(): string {
	return BASE_URL;
}
