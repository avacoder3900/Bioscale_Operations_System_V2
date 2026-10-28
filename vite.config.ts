import 'dotenv/config';
import { realpathSync } from 'node:fs';
import tailwindcss from '@tailwindcss/vite';
import { sveltekit } from '@sveltejs/kit/vite';
import { defineConfig, searchForWorkspaceRoot } from 'vite';

// A git worktree whose node_modules is a junction into another checkout:
// Vite follows the junction and refuses to serve SvelteKit's client entry
// from outside this folder (403 "outside of Vite serving allow list"), so
// pages render on the server but never hydrate — no dropdown or button
// works. Allowing node_modules' real location fixes that; in a normal
// checkout it is the same folder and changes nothing.
function realNodeModules(): string[] {
	try {
		return [realpathSync('node_modules')];
	} catch {
		return [];
	}
}

export default defineConfig({
	plugins: [tailwindcss(), sveltekit()],

	server: {
		port: 5176,
		strictPort: true,
		host: true,
		fs: {
			allow: [searchForWorkspaceRoot(process.cwd()), ...realNodeModules()]
		}
	}
});
