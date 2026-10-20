import { describe, it, expect } from 'vitest';
import { parseKeyMap, usernameForKey } from './keys';

describe('voicenotes webhook keys', () => {
	const entries = parseKeyMap(' jacobq:k1-secret , other:k2:with:colons,broken, :nouser,nokey: ');

	it('parses username:key pairs, keeping colons inside the key', () => {
		expect(entries).toEqual([
			{ username: 'jacobq', key: 'k1-secret' },
			{ username: 'other', key: 'k2:with:colons' }
		]);
	});

	it('maps a key to its speaker', () => {
		expect(usernameForKey('k1-secret', entries)).toBe('jacobq');
		expect(usernameForKey('k2:with:colons', entries)).toBe('other');
	});

	it('rejects missing, wrong, and prefix keys', () => {
		expect(usernameForKey(null, entries)).toBeNull();
		expect(usernameForKey('', entries)).toBeNull();
		expect(usernameForKey('k1', entries)).toBeNull();
		expect(usernameForKey('k1-secret', [])).toBeNull();
		expect(parseKeyMap(undefined)).toEqual([]);
	});
});
