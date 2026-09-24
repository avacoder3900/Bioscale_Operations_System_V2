/**
 * Research proxy unit tests — no DB, no server.
 * Run: npm run test:unit
 */
import { describe, it, expect } from 'vitest';
import { researchPathAllowed, researchBaseUrl, researchApiKey } from './research-proxy';

describe('researchPathAllowed', () => {
	it.each([
		'analysis/catalog',
		'analysis/profiles',
		'analysis/profiles/abc123/activate',
		'analysis/assay/A67AC662/attach',
		'calibration/lots',
		'calibration/curves/xyz-1/activate'
	])('allows %s', (p) => expect(researchPathAllowed(p)).toBe(true));

	it.each([
		'',
		'analysis',
		'analysis/',
		'protocols',
		'reagent-catalog/create',
		'analysis/../users',
		'analysis//profiles',
		'analysis/profiles?x=1',
		'calibration/curves/<script>',
		'x'.repeat(201)
	])('rejects %j', (p) => expect(researchPathAllowed(p)).toBe(false));
});

describe('env resolution', () => {
	it('strips trailing slashes from the base URL and returns null when unset', () => {
		expect(researchBaseUrl({ RESEARCH_API_URL: 'https://research.example.com/' })).toBe('https://research.example.com');
		expect(researchBaseUrl({ RESEARCH_API_URL: '  ' })).toBeNull();
		expect(researchBaseUrl({})).toBeNull();
	});

	it('prefers the dedicated research key and falls back to the shared agent key', () => {
		expect(researchApiKey({ RESEARCH_AGENT_API_KEY: 'r', AGENT_API_KEY: 'a' })).toBe('r');
		expect(researchApiKey({ AGENT_API_KEY: 'a' })).toBe('a');
		expect(researchApiKey({})).toBeNull();
	});
});
