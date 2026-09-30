import { env } from '$env/dynamic/private';

/**
 * Proxy to the brevitest-research-v2 agent API.
 *
 * The research app owns the analysis engine (profiles, views, 4PL calibration
 * curves). BIMS exposes those capabilities through the SAME MCP connector by
 * forwarding an allowlisted subset of /api/agent/research/<path> to
 * `${RESEARCH_API_URL}/api/agent/<path>` with the research agent key.
 *
 * Env:
 *   RESEARCH_API_URL         e.g. https://research.brevitest.com (no trailing slash)
 *   RESEARCH_AGENT_API_KEY   optional; falls back to AGENT_API_KEY (the apps share it today)
 */
export const RESEARCH_ALLOWED_PREFIXES = ['analysis/', 'calibration/'] as const;

const SAFE_SEGMENT = /^[A-Za-z0-9_.-]+$/;

/** Only analysis/* and calibration/* paths made of plain segments are forwarded. */
export function researchPathAllowed(path: string): boolean {
	if (typeof path !== 'string' || path.length === 0 || path.length > 200) return false;
	if (!RESEARCH_ALLOWED_PREFIXES.some((p) => path.startsWith(p))) return false;
	const segments = path.split('/');
	if (segments.length < 2) return false;
	return segments.every((s) => s.length > 0 && s !== '.' && s !== '..' && SAFE_SEGMENT.test(s));
}

export function researchBaseUrl(source: { RESEARCH_API_URL?: string } = env): string | null {
	const raw = source.RESEARCH_API_URL?.trim();
	if (!raw) return null;
	return raw.replace(/\/+$/, '');
}

export function researchApiKey(source: { RESEARCH_AGENT_API_KEY?: string; AGENT_API_KEY?: string } = env): string | null {
	return source.RESEARCH_AGENT_API_KEY?.trim() || source.AGENT_API_KEY?.trim() || null;
}

export interface ForwardResult {
	status: number;
	body: string;
}

/** Forward a request to the research agent API. Never throws; network failures become a 502 body. */
export async function forwardToResearch(
	path: string,
	opts: { method: 'GET' | 'POST'; query?: URLSearchParams; body?: string; timeoutMs?: number }
): Promise<ForwardResult> {
	const base = researchBaseUrl();
	const key = researchApiKey();
	if (!base) return { status: 503, body: JSON.stringify({ success: false, error: 'RESEARCH_API_URL is not configured on BIMS' }) };
	if (!key) return { status: 503, body: JSON.stringify({ success: false, error: 'No research agent key configured on BIMS' }) };

	const qs = opts.query?.toString();
	const url = `${base}/api/agent/${path}${qs ? `?${qs}` : ''}`;
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), opts.timeoutMs ?? 25000);
	try {
		const res = await fetch(url, {
			method: opts.method,
			headers: { 'x-api-key': key, accept: 'application/json', ...(opts.body !== undefined ? { 'content-type': 'application/json' } : {}) },
			body: opts.body,
			signal: controller.signal
		});
		return { status: res.status, body: await res.text() };
	} catch (e) {
		const message = (e as Error)?.name === 'AbortError' ? 'research API timed out' : ((e as Error)?.message ?? String(e));
		return { status: 502, body: JSON.stringify({ success: false, error: `Could not reach the research app: ${message}` }) };
	} finally {
		clearTimeout(timer);
	}
}
