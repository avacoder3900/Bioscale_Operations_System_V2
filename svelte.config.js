import { mdsvex } from 'mdsvex';
import adapter from '@sveltejs/adapter-vercel';

/** @type {import('@sveltejs/kit').Config} */
const config = {
	kit: {
		adapter: adapter({
			runtime: 'nodejs22.x',
			// Atlas (shared with research + consumer) is AWS us-east-1; iad1 sits beside it.
			// pdx1 cost ~60-70 ms per DB round trip (PERF-01 BM-01).
			regions: ['iad1'],
			maxDuration: 30
		})
	},
	preprocess: [mdsvex()],
	extensions: ['.svelte', '.svx']
};

export default config;
