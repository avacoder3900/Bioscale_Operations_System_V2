// tsx shim for SvelteKit's virtual `$env/dynamic/private` so server services can
// be imported from scripts/ (see scripts/tsconfig.json). dotenv must be loaded
// by the script before any server module is imported.
export const env: Record<string, string | undefined> = process.env;
