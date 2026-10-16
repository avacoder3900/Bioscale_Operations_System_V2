import { error } from '@sveltejs/kit';

/** Small body-reading helpers shared by the consumer API routes. */

export async function readJson(request: Request): Promise<Record<string, unknown>> {
	try {
		const body = await request.json();
		if (!body || typeof body !== 'object' || Array.isArray(body)) throw new Error('not an object');
		return body as Record<string, unknown>;
	} catch {
		throw error(400, 'Invalid JSON body');
	}
}

export function requireString(body: Record<string, unknown>, key: string, max = 256): string {
	const v = body[key];
	if (typeof v !== 'string' || !v.trim()) throw error(400, `${key} is required`);
	if (v.length > max) throw error(400, `${key} is too long`);
	return v.trim();
}

export function optionalString(body: Record<string, unknown>, key: string, max = 256): string | null {
	const v = body[key];
	if (v === undefined || v === null || v === '') return null;
	if (typeof v !== 'string') throw error(400, `${key} must be a string`);
	if (v.length > max) throw error(400, `${key} is too long`);
	return v.trim();
}

export function stringArray(body: Record<string, unknown>, key: string, max = 50): string[] {
	const v = body[key];
	if (v === undefined || v === null) return [];
	if (!Array.isArray(v) || v.some((x) => typeof x !== 'string')) throw error(400, `${key} must be an array of strings`);
	if (v.length > max) throw error(400, `${key} has too many entries`);
	return (v as string[]).map((s) => s.trim()).filter(Boolean);
}

/** `a,b,c` query parameter → string[] (empty when absent). */
export function csv(value: string | null, max = 50): string[] {
	if (!value) return [];
	const parts = value.split(',').map((s) => s.trim()).filter(Boolean);
	if (parts.length > max) throw error(400, 'Too many entries');
	return parts;
}

/** Cartridge ids are either UUIDs (the QR payload) or BIMS CART-000123 ids. */
export const CARTRIDGE_ID = /^(?:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|[A-Z]{2,8}-\d{3,}|[A-Za-z0-9_-]{8,40})$/;

export function requireCartridgeId(value: string): string {
	const id = value.trim();
	if (!CARTRIDGE_ID.test(id)) throw error(400, 'Not a cartridge id');
	return id;
}
