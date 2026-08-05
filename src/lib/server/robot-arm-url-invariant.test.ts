import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, sep, extname } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * ARM-01 §7.6 consequence 1 — "Nothing client-side may reference the Pi."
 *
 * The PRD promised a §11 grep check ("that check remains unwritten; it was never
 * implemented"). This is it, as a test rather than a grep, because a grep is only
 * run when someone remembers to run it.
 *
 * The rule: client-reachable code must never read the value of the Pi's PRIVATE
 * origin, `ROBOT_ARM_BASE_URL`. That variable is server-only by construction —
 * `robot-arm-client.ts` reads it inside load functions and form actions, and the
 * browser only ever talks to BIMS.
 *
 * Two things the naive grep from §11 gets wrong, and this check gets right:
 *
 *  1. `ROBOT_ARM_PUBLIC_URL` is the sanctioned ARM-02 mode-B exception, recorded
 *     in the amendment to §7.6 dated 2026-08-05. It must stay allowed forever.
 *     Asserted explicitly below so a future edit cannot silently ban it.
 *
 *  2. Printing the NAME to an operator is not reading the VALUE. Three files in
 *     the tree today legitimately render the bare string inside error copy so an
 *     operator knows which env var to go fix. Banning the name outright would
 *     make the check unlandable, and the usual response to an unlandable check
 *     is to delete it. So the check distinguishes value ACCESS from name MENTION:
 *     mentions are allowed in markup text and in comments; anything in a code
 *     region is a violation.
 */

const BANNED_NAMES = ['ROBOT_ARM_BASE_URL'] as const;

/** Sanctioned by the §7.6 amendment (ARM-02 mode B). Never bannable. */
const ALLOWED_NAMES = ['ROBOT_ARM_PUBLIC_URL'] as const;

/**
 * Boundary is "not alphanumeric" rather than \b, so that an underscore-joined
 * alias — `PUBLIC_ROBOT_ARM_BASE_URL`, `ROBOT_ARM_BASE_URL_2` — is still caught.
 * \b would let those through, since `_` is a word character.
 */
function bannedPattern(): RegExp {
	return new RegExp(`(?<![A-Za-z0-9])(?:${BANNED_NAMES.join('|')})(?![A-Za-z0-9])`, 'g');
}

// ---------------------------------------------------------------------------
// Masking: blank out the regions where a bare name mention is legitimate
// (markup text, comments), leaving a same-length "code view" of the file.
// Same length, and newlines preserved, so reported line numbers stay true.
// ---------------------------------------------------------------------------

const SPACE = ' ';

function blank(ch: string): string {
	return ch === '\n' || ch === '\r' ? ch : SPACE;
}

/**
 * JS/TS: comments become blanks. String and template-literal CONTENTS are kept
 * as code deliberately — `env['ROBOT_ARM_BASE_URL']` and
 * `` `${env.ROBOT_ARM_BASE_URL}/x` `` are both access, and a client module has
 * no business carrying the name as a string constant either. Prose belongs in a
 * comment or in markup.
 */
export function maskScript(src: string): string {
	const out: string[] = new Array(src.length);
	type State = 'code' | 'line' | 'block' | 'sq' | 'dq' | 'tpl';
	let state: State = 'code';
	// Template-literal `${ ... }` nesting: each entry is the brace depth of one
	// open interpolation, so `` `${ {a:1} }` `` does not close early.
	const tplStack: number[] = [];
	let braceDepth = 0;

	for (let i = 0; i < src.length; i++) {
		const c = src[i];
		const next = src[i + 1];

		switch (state) {
			case 'code': {
				if (c === '/' && next === '/') {
					state = 'line';
					out[i] = blank(c);
					continue;
				}
				if (c === '/' && next === '*') {
					state = 'block';
					out[i] = blank(c);
					continue;
				}
				if (c === "'") state = 'sq';
				else if (c === '"') state = 'dq';
				else if (c === '`') state = 'tpl';
				else if (c === '{') braceDepth++;
				else if (c === '}') {
					braceDepth--;
					if (tplStack.length && braceDepth === tplStack[tplStack.length - 1]) {
						tplStack.pop();
						state = 'tpl';
					}
				}
				out[i] = c;
				continue;
			}
			case 'line': {
				out[i] = blank(c);
				if (c === '\n') state = 'code';
				continue;
			}
			case 'block': {
				out[i] = blank(c);
				if (c === '*' && next === '/') {
					out[i + 1] = blank(next);
					i++;
					state = 'code';
				}
				continue;
			}
			case 'sq':
			case 'dq': {
				out[i] = c;
				if (c === '\\') {
					if (i + 1 < src.length) out[++i] = src[i];
					continue;
				}
				if ((state === 'sq' && c === "'") || (state === 'dq' && c === '"')) state = 'code';
				continue;
			}
			case 'tpl': {
				out[i] = c;
				if (c === '\\') {
					if (i + 1 < src.length) out[++i] = src[i];
					continue;
				}
				if (c === '`') {
					state = 'code';
					continue;
				}
				if (c === '$' && next === '{') {
					out[++i] = next;
					tplStack.push(braceDepth);
					braceDepth++;
					state = 'code';
				}
				continue;
			}
		}
	}
	// Unterminated string/template at EOF is fine — chars were already emitted.
	return out.join('');
}

/**
 * Svelte: `<script>` bodies are code (comment-masked); `<style>` bodies and
 * markup text are blanked; `{ ... }` mustaches inside markup are code, because
 * `<img src={env.ROBOT_ARM_BASE_URL} />` is exactly the thing being banned.
 */
export function maskSvelte(src: string): string {
	const out: string[] = new Array(src.length);
	for (let i = 0; i < src.length; i++) out[i] = blank(src[i]);

	// 1. <script> bodies -> masked script.
	const scriptRe = /<script\b[^>]*>([\s\S]*?)<\/script>/gi;
	let m: RegExpExecArray | null;
	const covered: Array<[number, number]> = [];
	while ((m = scriptRe.exec(src))) {
		const start = m.index + m[0].indexOf('>') + 1;
		const body = m[1];
		const masked = maskScript(body);
		for (let k = 0; k < masked.length; k++) out[start + k] = masked[k];
		covered.push([m.index, m.index + m[0].length]);
	}
	// <style> bodies stay blank, but must not be re-scanned as markup.
	const styleRe = /<style\b[^>]*>[\s\S]*?<\/style>/gi;
	while ((m = styleRe.exec(src))) covered.push([m.index, m.index + m[0].length]);

	const inCovered = (i: number) => covered.some(([a, b]) => i >= a && i < b);

	// 2. Markup: mustache expressions are code, everything else stays blank.
	let depth = 0;
	let quote: string | null = null;
	for (let i = 0; i < src.length; i++) {
		if (inCovered(i)) continue;
		const c = src[i];

		if (depth === 0) {
			if (c === '<' && src.startsWith('<!--', i)) {
				const end = src.indexOf('-->', i);
				i = end === -1 ? src.length : end + 2;
				continue;
			}
			if (c === '{') depth = 1;
			continue;
		}

		out[i] = c;
		if (quote) {
			if (c === '\\') {
				if (i + 1 < src.length) out[++i] = src[i];
			} else if (c === quote) quote = null;
			continue;
		}
		if (c === "'" || c === '"' || c === '`') quote = c;
		else if (c === '{') depth++;
		else if (c === '}') depth--;
	}

	return out.join('');
}

const SCRIPT_EXTS = new Set(['.ts', '.js', '.mts', '.cts', '.mjs', '.cjs', '.tsx', '.jsx']);

export function maskForExt(ext: string, src: string): string {
	if (ext === '.svelte') return maskSvelte(src);
	if (SCRIPT_EXTS.has(ext)) return maskScript(src);
	// Unknown text format: treat the whole file as code. Strictest option; a
	// new file type never silently gets a free pass.
	return src;
}

// ---------------------------------------------------------------------------
// Matcher
// ---------------------------------------------------------------------------

export type Violation = { line: number; column: number; name: string; text: string };

/** Find value-ACCESS of a banned name. Name mentions in markup/comments are OK. */
export function findViolations(ext: string, src: string): Violation[] {
	// Fast path: masking is only interesting for files that carry the name at all.
	if (!BANNED_NAMES.some((n) => src.includes(n))) return [];

	const masked = maskForExt(ext, src);
	const re = bannedPattern();
	const found: Violation[] = [];
	let m: RegExpExecArray | null;
	while ((m = re.exec(masked))) {
		const before = masked.slice(0, m.index);
		const line = before.split('\n').length;
		const column = m.index - (before.lastIndexOf('\n') + 1);
		const lineText = src.split('\n')[line - 1] ?? '';
		found.push({ line, column, name: m[0], text: lineText.trim() });
	}
	return found;
}

// ---------------------------------------------------------------------------
// Scan surface: every .svelte under src/, plus every file under src/lib that is
// NOT under src/lib/server. Walked from disk, so new files are covered without
// anyone remembering to update a list.
// ---------------------------------------------------------------------------

const REPO_ROOT = fileURLToPath(new URL('../../../', import.meta.url));
const SRC = join(REPO_ROOT, 'src');
const LIB = join(SRC, 'lib');
const LIB_SERVER = join(LIB, 'server');

const BINARY_EXTS = new Set([
	'.png',
	'.jpg',
	'.jpeg',
	'.gif',
	'.webp',
	'.avif',
	'.ico',
	'.bmp',
	'.woff',
	'.woff2',
	'.ttf',
	'.otf',
	'.eot',
	'.pdf',
	'.zip',
	'.gz',
	'.mp4',
	'.webm',
	'.wasm'
]);

const SKIP_DIRS = new Set(['node_modules', '.svelte-kit', 'dist', 'build', '.git']);

function walk(dir: string): string[] {
	const out: string[] = [];
	let entries;
	try {
		entries = readdirSync(dir, { withFileTypes: true });
	} catch {
		return out;
	}
	for (const e of entries) {
		const full = join(dir, e.name);
		if (e.isDirectory()) {
			if (SKIP_DIRS.has(e.name)) continue;
			out.push(...walk(full));
		} else if (e.isFile()) {
			out.push(full);
		}
	}
	return out;
}

function isUnder(file: string, dir: string): boolean {
	const rel = relative(dir, file);
	return rel !== '' && !rel.startsWith('..') && !rel.startsWith(sep + '..');
}

/** The client-reachable surface, exactly as ARM-01 §7.6 scopes it. */
export function clientReachableFiles(): string[] {
	const all = walk(SRC);
	return all
		.filter((f) => {
			const ext = extname(f).toLowerCase();
			if (BINARY_EXTS.has(ext)) return false;
			if (ext === '.svelte') return true; // every .svelte under src/
			return isUnder(f, LIB) && !isUnder(f, LIB_SERVER); // src/lib minus src/lib/server
		})
		.sort();
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('ARM-01 §7.6.1 — the private Pi origin never reaches the client', () => {
	it('(a) scans a non-trivial, disk-walked surface (guards against a vacuous pass)', () => {
		const files = clientReachableFiles();
		// If a refactor moves or renames src/, this fails loudly instead of the
		// whole invariant quietly passing over an empty file list.
		expect(files.length).toBeGreaterThan(100);
		expect(files.some((f) => f.endsWith('.svelte'))).toBe(true);
		expect(files.some((f) => f.endsWith('.ts') && isUnder(f, LIB))).toBe(true);
		// The surface must exclude the server dir — that is where the var lives.
		expect(files.some((f) => isUnder(f, LIB_SERVER))).toBe(false);
		// ...and this very test file must not be in its own scan surface.
		expect(files.some((f) => f.endsWith('robot-arm-url-invariant.test.ts'))).toBe(false);
	});

	it('(b) no client-reachable file reads the value of ROBOT_ARM_BASE_URL', () => {
		const offenders: string[] = [];
		for (const file of clientReachableFiles()) {
			let src: string;
			try {
				src = readFileSync(file, 'utf8');
			} catch {
				continue;
			}
			for (const v of findViolations(extname(file).toLowerCase(), src)) {
				offenders.push(`${relative(REPO_ROOT, file)}:${v.line}:${v.column}  ${v.text}`);
			}
		}
		expect(
			offenders,
			offenders.length
				? `ARM-01 §7.6.1: client-reachable code must not read the Pi's private origin.\n` +
						`Use ROBOT_ARM_PUBLIC_URL (the sanctioned ARM-02 mode-B origin) or keep the\n` +
						`call server-side in a load function / form action / +server.ts.\n` +
						`Printing the NAME to an operator is fine — put it in markup text or a\n` +
						`comment, not in a code expression or a string literal.\n\n` +
						offenders.join('\n')
				: undefined
		).toEqual([]);
	});

	it('(c) the three operator-facing NAME mentions in the tree today are allowed', () => {
		// These print the bare name in error copy so an operator knows what to fix.
		// They read no value. If any of these starts failing, the matcher has
		// regressed into a dumb grep.
		const mentions = [
			'src/lib/components/RobotArmCameraPanel.svelte',
			'src/lib/components/RobotArmConnectionPanel.svelte',
			'src/routes/manufacturing/cart-mfg/robot-arm/+layout.svelte'
		];
		for (const rel of mentions) {
			const abs = join(REPO_ROOT, rel);
			expect(statSync(abs).isFile(), `${rel} moved — update this list`).toBe(true);
			const src = readFileSync(abs, 'utf8');
			// Precondition: the file really does still contain the name as text.
			expect(src.includes('ROBOT_ARM_BASE_URL'), `${rel} no longer mentions the name`).toBe(true);
			expect(findViolations('.svelte', src)).toEqual([]);
		}
	});
});

describe('ARM-01 §7.6.1 — positive controls (the matcher actually bites)', () => {
	const offending: Array<[string, string, string]> = [
		['.ts', 'private $env import', `import { ROBOT_ARM_BASE_URL } from '$env/static/private';`],
		['.ts', 'dynamic $env import', `import { env } from '$env/dynamic/private';\nconst u = env.ROBOT_ARM_BASE_URL;`],
		['.ts', 'process.env', `const u = process.env.ROBOT_ARM_BASE_URL ?? '';`],
		['.ts', 'import.meta.env', `const u = import.meta.env.ROBOT_ARM_BASE_URL;`],
		['.ts', 'destructuring', `const { ROBOT_ARM_BASE_URL } = env;`],
		['.ts', 'bracket access', `const u = env['ROBOT_ARM_BASE_URL'];`],
		['.ts', 'bracket access, double quotes', `const u = env["ROBOT_ARM_BASE_URL"];`],
		['.ts', 'string constant used for indirection', `const K = 'ROBOT_ARM_BASE_URL';\nconst u = env[K];`],
		['.ts', 'bare identifier in an expression', `fetch(ROBOT_ARM_BASE_URL + '/health');`],
		['.ts', 'underscore-joined alias (\\b would miss this)', `const u = env.PUBLIC_ROBOT_ARM_BASE_URL;`],
		['.svelte', 'access in a script block', `<script>\n  import { env } from '$env/dynamic/private';\n  const u = env.ROBOT_ARM_BASE_URL;\n</script>\n<p>hi</p>`],
		['.svelte', 'bare identifier in an img mustache', `<img src={ROBOT_ARM_BASE_URL + '/cameras/top/stream'} alt="arm" />`],
		['.svelte', 'template literal inside a mustache', '<a href={`${env.ROBOT_ARM_BASE_URL}/docs`}>docs</a>'],
		['.svelte', 'template literal inside a script block', '<script>\n  const s = `${env.ROBOT_ARM_BASE_URL}/x`;\n</script>'],
		['.svelte', 'access after a legitimate mention on an earlier line', `<p>Check <code>ROBOT_ARM_BASE_URL</code>.</p>\n<script>const u = env.ROBOT_ARM_BASE_URL;</script>`]
	];

	for (const [ext, label, src] of offending) {
		it(`flags: ${ext} — ${label}`, () => {
			expect(findViolations(ext, src).length).toBeGreaterThan(0);
		});
	}

	const benign: Array<[string, string, string]> = [
		['.svelte', 'name inside a <code> tag in error copy', `<p>Arm unreachable. Check <code>ROBOT_ARM_BASE_URL</code>.</p>`],
		['.svelte', 'name as bare prose in error copy', `<p class="mt-1">\n  Check ROBOT_ARM_BASE_URL and ROBOT_ARM_API_KEY, and that the service is running.\n</p>`],
		['.svelte', 'name inside an HTML comment', `<!-- ROBOT_ARM_BASE_URL is server-only; see ARM-01 §7.6 -->\n<p>ok</p>`],
		['.svelte', 'name mentioned inside an {#if} block body', `{#if !reachable}\n  <p>Check <code>ROBOT_ARM_BASE_URL</code>.</p>\n{/if}`],
		['.ts', 'name in a line comment', `// ROBOT_ARM_BASE_URL is read server-side only (ARM-01 §7.6).\nexport const x = 1;`],
		['.ts', 'name in a block comment', `/**\n * Never expose ROBOT_ARM_BASE_URL to the browser.\n */\nexport const x = 1;`],
		['.ts', 'a // inside a string does not swallow the rest of the line', `const home = 'http://arm-pi:8000'; // ROBOT_ARM_BASE_URL note\nexport const x = 1;`]
	];

	for (const [ext, label, src] of benign) {
		it(`allows: ${ext} — ${label}`, () => {
			expect(findViolations(ext, src)).toEqual([]);
		});
	}
});

describe('ARM-01 §7.6 amendment — ROBOT_ARM_PUBLIC_URL is permanently allowed', () => {
	it('(a) is not in the banned list, and no banned name is an allowed name', () => {
		expect(ALLOWED_NAMES).toContain('ROBOT_ARM_PUBLIC_URL');
		expect(BANNED_NAMES).toContain('ROBOT_ARM_BASE_URL');
		for (const allowed of ALLOWED_NAMES) {
			expect(BANNED_NAMES as readonly string[]).not.toContain(allowed);
			// Also guard the regex, not just the list: a future edit that broadens
			// the pattern (e.g. to /ROBOT_ARM_\w*URL/) must fail here.
			expect(bannedPattern().test(allowed), `pattern must not match ${allowed}`).toBe(false);
		}
	});

	it('(b) full mode-B usage in client code produces zero violations', () => {
		const modeB = [
			`<script>`,
			`  let streamUrl = $state(null);`,
			`  async function negotiate() {`,
			`    const r = await fetch('/api/robot-arm/cameras/stream-url');`,
			`    const { available, origin, token } = await r.json();`,
			`    if (available) streamUrl = \`\${origin}/cameras/top/stream?token=\${token}\`;`,
			`  }`,
			`</script>`,
			`{#if streamUrl}<img src={streamUrl} alt="arm camera" />{/if}`,
			`<p>Set <code>ROBOT_ARM_PUBLIC_URL</code> to enable the direct stream.</p>`
		].join('\n');
		expect(findViolations('.svelte', modeB)).toEqual([]);

		// Even direct env access of the PUBLIC var must not trip the check.
		expect(findViolations('.ts', `const o = env.ROBOT_ARM_PUBLIC_URL;`)).toEqual([]);
		expect(
			findViolations('.ts', `import { ROBOT_ARM_PUBLIC_URL } from '$env/static/public';`)
		).toEqual([]);
	});
});
