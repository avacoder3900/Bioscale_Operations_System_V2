/**
 * Content hash for a labware definition.
 *
 * Deliberately dependency-free (no $lib imports, no DB) so migration scripts and
 * the running app compute byte-identical hashes. If these ever diverged, a
 * backfilled snapshot would look "changed" to the app and trigger a spurious
 * republish of geometry nobody touched.
 */
import { createHash } from 'node:crypto';

/** Stable stringify — key insertion order must not change the hash. */
export function canonicalJson(value: any): string {
	if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
	if (Array.isArray(value)) return '[' + value.map(canonicalJson).join(',') + ']';
	const keys = Object.keys(value).sort();
	return '{' + keys.map((k) => JSON.stringify(k) + ':' + canonicalJson(value[k])).join(',') + '}';
}

/** sha256 of the definition, independent of key ordering. */
export function definitionHash(definition: any): string {
	return createHash('sha256').update(canonicalJson(definition)).digest('hex');
}
