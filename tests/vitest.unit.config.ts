import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';

// Unit tests import route handlers directly, and a route may import SvelteKit's
// `$env/dynamic/private`. That specifier only exists inside SvelteKit's own vite
// plugin, which this config deliberately does not load (no server, no DB). Give
// it a resolvable stub so the import graph loads; tests that care about env
// values `vi.mock('$env/dynamic/private')` over it.
const VIRTUAL_DYNAMIC_PRIVATE_ENV = '\0virtual:sveltekit-env-dynamic-private';

const sveltekitEnvStub = {
	name: 'stub-sveltekit-dynamic-private-env',
	resolveId(id: string) {
		if (id === '$env/dynamic/private') return VIRTUAL_DYNAMIC_PRIVATE_ENV;
		return null;
	},
	load(id: string) {
		if (id === VIRTUAL_DYNAMIC_PRIVATE_ENV) return 'export const env = {};';
		return null;
	}
};

// Pure unit tests over src/. Deliberately does NOT use tests/setup.ts — that one
// logs into a running app for the contract suite; unit tests must run with no
// server and no DB.
export default defineConfig({
	plugins: [sveltekitEnvStub],
	resolve: {
		alias: {
			$lib: fileURLToPath(new URL('../src/lib', import.meta.url))
		}
	},
	test: {
		include: ['src/**/*.test.ts'],
		environment: 'node'
	}
});
