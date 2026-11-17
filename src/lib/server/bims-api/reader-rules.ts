/**
 * BIMS API v1 — pure rules for pairing a reader (an SPU) with an app holder.
 * Contract: docs/BIMS-API-V1.md, "Readers". No database, SvelteKit or Particle
 * import, so every rule is unit-testable.
 *
 * What a reader's code can be (everything `pair` accepts):
 * - its UDI, `BT-M01-0000-0230` (the serial the API returns), any case;
 * - its QR label: a pre-printed label carrying a random UUID, bound to the unit
 *   on /spu/mfg/barcodes and stored as `spus.barcode`, any case;
 * - the Particle module's serial number (`particleLink.particleSerial`);
 * - a URL or other text that contains one of those (a UDI or UUID anywhere in
 *   it, or a URL whose query value or last path segment is one).
 * Never the SPU's database id or the Particle device id: neither is printed on
 * the unit, so neither is accepted from an app.
 */
import { normalizeSpuStatus } from '$lib/server/spu-status';

export const MAX_CODE_LENGTH = 200;

/** Path parameter `{serial}`: the UDI. Same characters as BT-M01-0000-0230. */
export const READER_SERIAL = /^[A-Za-z0-9-]{3,40}$/;

const UDI_IN_TEXT = /BT-M01-\d{4}-\d{4}/gi;
const UUID_IN_TEXT = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;
/** A token worth matching on its own: no spaces, a sensible length. */
const TOKEN = /^[A-Za-z0-9_.:-]{3,80}$/;
const MAX_VALUES = 24;

export type ReaderHolder = { kind?: string | null; ref?: string | null; via?: string | null; since?: Date | string | null };

/** The fields of an `spus` document these rules read. */
export type ReaderDoc = {
	_id: string;
	udi: string;
	barcode?: string | null;
	status?: string | null;
	holder?: ReaderHolder | null;
	particleLink?: { particleDeviceId?: string | null; particleSerial?: string | null } | null;
};

/**
 * Every value a scanned or typed code could match, in the three cases the
 * stored fields use (as given, upper, lower). Null when the code is empty or
 * longer than MAX_CODE_LENGTH.
 */
export function codeValues(raw: unknown): string[] | null {
	if (typeof raw !== 'string') return null;
	const code = raw.trim();
	if (!code || code.length > MAX_CODE_LENGTH) return null;

	const tokens = new Set<string>();
	if (TOKEN.test(code)) tokens.add(code);
	for (const m of code.matchAll(UDI_IN_TEXT)) tokens.add(m[0]);
	for (const m of code.matchAll(UUID_IN_TEXT)) tokens.add(m[0]);
	if (/^[a-z][a-z0-9+.-]*:\/\//i.test(code)) {
		try {
			const url = new URL(code);
			for (const v of url.searchParams.values()) if (TOKEN.test(v.trim())) tokens.add(v.trim());
			const last = url.pathname.split('/').filter(Boolean).pop();
			if (last) {
				const seg = decodeURIComponent(last).trim();
				if (TOKEN.test(seg)) tokens.add(seg);
			}
			const hash = url.hash.replace(/^#/, '').trim();
			if (TOKEN.test(hash)) tokens.add(hash);
		} catch {
			// Not a URL after all; the UDI/UUID scan above still applies.
		}
	}

	const values = new Set<string>();
	for (const t of tokens) {
		values.add(t);
		values.add(t.toUpperCase());
		values.add(t.toLowerCase());
	}
	return [...values].slice(0, MAX_VALUES);
}

/** The values a `{serial}` path parameter can match on `udi`. */
export function serialValues(serial: string): string[] {
	return [...new Set([serial, serial.toUpperCase(), serial.toLowerCase()])];
}

/**
 * The one reader a code names. A UDI match wins over a label match, which wins
 * over a Particle serial match. If one kind matches two different readers the
 * code is ambiguous and names none.
 */
export function pickReader<T extends ReaderDoc>(rows: T[], values: string[]): T | null {
	const want = new Set(values);
	const by = (field: (r: T) => string | null | undefined) => {
		const hits = rows.filter((r) => {
			const v = field(r);
			return typeof v === 'string' && want.has(v);
		});
		const ids = new Set(hits.map((r) => r._id));
		return ids.size === 1 ? hits[0] : ids.size > 1 ? 'ambiguous' : null;
	};
	for (const field of [(r: T) => r.udi, (r: T) => r.barcode, (r: T) => r.particleLink?.particleSerial]) {
		const hit = by(field);
		if (hit === 'ambiguous') return null;
		if (hit) return hit;
	}
	return null;
}

/** A customer can hold a reader only once it is released (spu-status.ts lifecycle). */
export function isPairable(status: string | null | undefined): boolean {
	return normalizeSpuStatus(status) === 'released';
}

export type PairDecision =
	| { action: 'pair' }
	| { action: 'already' }
	| { action: 'refuse'; reason: 'not_found' | 'held_by_other' | 'not_available' };

export function evaluatePair(doc: ReaderDoc | null, holderRef: string): PairDecision {
	if (!doc) return { action: 'refuse', reason: 'not_found' };
	const held = doc.holder?.ref ?? null;
	if (held === holderRef) return { action: 'already' };
	if (held) return { action: 'refuse', reason: 'held_by_other' };
	if (!isPairable(doc.status)) return { action: 'refuse', reason: 'not_available' };
	return { action: 'pair' };
}

export type UnpairDecision =
	| { action: 'unpair' }
	| { action: 'not_paired' }
	| { action: 'refuse'; reason: 'not_found' | 'held_by_other' };

export function evaluateUnpair(doc: ReaderDoc | null, holderRef: string): UnpairDecision {
	if (!doc) return { action: 'refuse', reason: 'not_found' };
	const held = doc.holder?.ref ?? null;
	if (!held) return { action: 'not_paired' };
	if (held !== holderRef) return { action: 'refuse', reason: 'held_by_other' };
	return { action: 'unpair' };
}

/** True only when this holder holds the reader. Others' readers look like missing ones. */
export const heldBy = (doc: ReaderDoc | null, holderRef: string): doc is ReaderDoc =>
	Boolean(doc && doc.holder?.ref === holderRef);

const GENERIC = 'Could not change the reader’s Wi-Fi.';

/**
 * Operator wording turned into app wording ("SPU" becomes "reader"). If the
 * message somehow carries the password, none of it is returned.
 */
export function appMessage(text: string, password?: string): string {
	if (password && text.includes(password)) return GENERIC;
	return text
		.replace(/\bthe SPU's\b/g, 'the reader’s')
		.replace(/\bSPU's\b/g, 'reader’s')
		.replace(/\bThis SPU\b/g, 'This reader')
		.replace(/\bSPUs\b/g, 'readers')
		.replace(/^SPU\b/, 'The reader')
		.replace(/\bSPU\b/g, 'reader');
}

/** Firmware from which the reader can scan for and switch Wi-Fi (spu-wifi.ts). */
export const WIFI_MIN_FIRMWARE = 109;
