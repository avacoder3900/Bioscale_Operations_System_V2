/**
 * BIMS API v1 — request and response helpers. Every response is JSON,
 * including errors (`{ "message": "…" }`), whatever the caller's Accept header.
 */
import { READER_SERIAL } from './reader-rules';
import { HOLDER_REF } from './rules';

export class ApiError extends Error {
	constructor(
		public status: number,
		message: string,
		public headers: Record<string, string> = {}
	) {
		super(message);
	}
}

const NO_STORE = { 'cache-control': 'no-store' };

export function respond(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
	return new Response(JSON.stringify(body), {
		status,
		headers: { 'content-type': 'application/json', ...NO_STORE, ...headers }
	});
}

/**
 * Run a handler and turn anything it throws into a JSON response. The log
 * line for an unexpected failure carries the endpoint name and the error's
 * class only: no id, holder or message text, so nothing a request carried can
 * reach the logs.
 */
export async function guarded(endpoint: string, run: () => Promise<Response>): Promise<Response> {
	try {
		return await run();
	} catch (e) {
		if (e instanceof ApiError) return respond({ message: e.message }, e.status, e.headers);
		console.error(`[bims-api] ${endpoint} failed: ${e instanceof Error ? e.name : 'unknown error'}`);
		return respond({ message: 'Internal error' }, 500);
	}
}

/**
 * Cartridge ids: a UUID (the QR payload), a BIMS id like CART-000123, or
 * another 8–40 character token. Same pattern as `consumer/http.ts`
 * (`CARTRIDGE_ID`), repeated so this module stands alone.
 */
export const CARTRIDGE_ID = /^(?:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|[A-Z]{2,8}-\d{3,}|[A-Za-z0-9_-]{8,40})$/;

export function requireCartridgeId(value: string | undefined): string {
	const id = (value ?? '').trim();
	if (!CARTRIDGE_ID.test(id)) throw new ApiError(400, 'Not a cartridge id');
	return id;
}

export function requireHolderRef(value: unknown): string {
	if (typeof value !== 'string' || !HOLDER_REF.test(value)) throw new ApiError(400, 'holderRef is required and must look like h_…');
	return value;
}

/** An absent holderRef is null; a present one must be valid. */
export function optionalHolderRef(value: string | null): string | null {
	return value === null || value === '' ? null : requireHolderRef(value);
}

const MAX_BODY_BYTES = 2048;

/**
 * A JSON object body of at most 2 kB whose fields are all in `allowed`; any
 * other field is refused, so no personal data can ride along. The error
 * messages never repeat what the body carried.
 */
export async function readJsonBody(request: Request, allowed: readonly string[], refusal: string): Promise<Record<string, unknown>> {
	let body: unknown;
	try {
		const text = await request.text();
		if (text.length > MAX_BODY_BYTES) throw new Error('too large');
		body = JSON.parse(text);
	} catch {
		throw new ApiError(400, 'Invalid JSON body');
	}
	if (!body || typeof body !== 'object' || Array.isArray(body)) throw new ApiError(400, 'Invalid JSON body');
	if (Object.keys(body).some((k) => !allowed.includes(k))) throw new ApiError(400, refusal);
	return body as Record<string, unknown>;
}

/** The body's `holderRef` and nothing else: any other field is refused, so no personal data can ride along. */
export async function readHolderRefBody(request: Request): Promise<string> {
	const body = await readJsonBody(request, ['holderRef'], 'Only holderRef is accepted in the body');
	return requireHolderRef(body.holderRef);
}

/** `{serial}`: a reader's UDI, e.g. BT-M01-0000-0230 (any case). */
export function requireReaderSerial(value: string | undefined): string {
	const serial = (value ?? '').trim();
	if (!READER_SERIAL.test(serial)) throw new ApiError(400, 'Not a reader serial');
	return serial;
}
