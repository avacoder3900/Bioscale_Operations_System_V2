/**
 * Full-text search over the BIMS docs/ tree, used by the search_documentation
 * Ask BIMS tool. Vite bundles every matched .md file at build time via
 * import.meta.glob with raw query, so this works on Vercel serverless without
 * runtime FS access.
 *
 * Allowlist: deliberately excludes session/handoff/transactional docs (noise)
 * and PRDs (per docs/ask-bims-markdown-context.md §1.4 — PRDs describe
 * intended work, not necessarily shipped work, and would risk the agent
 * confidently describing non-existent features).
 *
 * Caps: 5 results, 200 chars per snippet, 500ms timeout. The agent should
 * narrow its query if it hits any of these.
 */

import * as nodeFs from 'node:fs';
import * as nodePath from 'node:path';

// Vite bundles the docs at build time via import.meta.glob. Under raw Node
// (e.g. `npx tsx scripts/test-ask-bims.ts`), import.meta.glob isn't a function,
// so fall back to a synchronous filesystem walk rooted at process.cwd()/docs.
// The fallback path is dead code in Vite builds.
function loadDocsFromFs(): Record<string, string> {
	const root = nodePath.resolve(process.cwd(), 'docs');
	const out: Record<string, string> = {};
	if (!nodeFs.existsSync(root)) return out;
	const walk = (dir: string) => {
		for (const entry of nodeFs.readdirSync(dir, { withFileTypes: true })) {
			const full = nodePath.join(dir, entry.name);
			if (entry.isDirectory()) walk(full);
			else if (entry.isFile() && entry.name.endsWith('.md')) {
				const rel = '/docs/' + nodePath.relative(root, full).split(nodePath.sep).join('/');
				out[rel] = nodeFs.readFileSync(full, 'utf8');
			}
		}
	};
	walk(root);
	return out;
}

const DOCS: Record<string, string> =
	typeof (import.meta as unknown as { glob?: unknown }).glob === 'function'
		? (import.meta.glob('/docs/**/*.md', {
				query: '?raw',
				import: 'default',
				eager: true
		  }) as Record<string, string>)
		: loadDocsFromFs();

const BLOCKED_PATTERNS: RegExp[] = [
	/SESSION-LOG/i,
	/SESSION-HANDOFF/i,
	/tomorrow-catchup/i,
	/audit-handoff/i,
	/ask-bims-session-handoff/i,
	/\/prds\//i,
	/\/migration\//i
];

const RESULT_CHAR_CAP = 200;
const RESULTS_CAP = 5;
const TIMEOUT_MS = 500;
const MIN_QUERY_LEN = 3;

export interface DocSearchMatch {
	file: string;
	lineNo: number;
	snippet: string;
}

export interface DocSearchResult {
	matches: DocSearchMatch[];
	truncated: boolean;
	timedOut: boolean;
	corpusFiles: number;
	queryLength: number;
}

function buildSnippet(line: string, queryLower: string): string {
	const trimmed = line.trim();
	if (trimmed.length <= RESULT_CHAR_CAP) return trimmed;
	const idx = trimmed.toLowerCase().indexOf(queryLower);
	if (idx === -1) return trimmed.slice(0, RESULT_CHAR_CAP) + '…';
	const half = Math.floor(RESULT_CHAR_CAP / 2);
	const start = Math.max(0, idx - half);
	const end = Math.min(trimmed.length, start + RESULT_CHAR_CAP);
	const head = start > 0 ? '…' : '';
	const tail = end < trimmed.length ? '…' : '';
	return head + trimmed.slice(start, end) + tail;
}

export function searchDocs(query: string): DocSearchResult {
	const trimmed = (query ?? '').trim();
	const corpusFiles = Object.keys(DOCS).filter(
		(p) => !BLOCKED_PATTERNS.some((re) => re.test(p))
	).length;

	if (trimmed.length < MIN_QUERY_LEN) {
		return {
			matches: [],
			truncated: false,
			timedOut: false,
			corpusFiles,
			queryLength: trimmed.length
		};
	}

	const startedAt = Date.now();
	const matches: DocSearchMatch[] = [];
	const queryLower = trimmed.toLowerCase();

	// AND-of-words matching: split the query on whitespace and require every
	// token to appear in the line (case-insensitive). Matches the behavior of
	// rg / grep -e / most search UIs. The agent often asks multi-word questions
	// ("laser cutting manufacturing flow audit") that don't appear as literal
	// substrings anywhere; AND-of-words finds the relevant line if every word
	// is present, regardless of order. Falls back to single-substring search
	// when the query is one word.
	const tokens = queryLower.split(/\s+/).filter((t) => t.length > 0);
	const lineMatches = (lineLower: string): boolean => {
		if (tokens.length <= 1) return lineLower.includes(queryLower);
		return tokens.every((t) => lineLower.includes(t));
	};

	for (const [path, content] of Object.entries(DOCS)) {
		if (Date.now() - startedAt > TIMEOUT_MS) {
			return {
				matches,
				truncated: matches.length >= RESULTS_CAP,
				timedOut: true,
				corpusFiles,
				queryLength: trimmed.length
			};
		}
		if (matches.length >= RESULTS_CAP) break;
		if (BLOCKED_PATTERNS.some((re) => re.test(path))) continue;

		const lines = content.split('\n');
		for (let i = 0; i < lines.length; i++) {
			const lineLower = lines[i].toLowerCase();
			if (lineMatches(lineLower)) {
				// Snippet anchored on the first token's hit so it's most relevant.
				const anchor = tokens[0] ?? queryLower;
				matches.push({
					file: path,
					lineNo: i + 1,
					snippet: buildSnippet(lines[i], anchor)
				});
				break; // one snippet per file
			}
		}
	}

	return {
		matches,
		truncated: matches.length >= RESULTS_CAP,
		timedOut: false,
		corpusFiles,
		queryLength: trimmed.length
	};
}
