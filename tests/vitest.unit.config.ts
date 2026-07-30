import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';

// Pure unit tests over src/. Deliberately does NOT use tests/setup.ts — that one
// logs into a running app for the contract suite; unit tests must run with no
// server and no DB.
export default defineConfig({
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
