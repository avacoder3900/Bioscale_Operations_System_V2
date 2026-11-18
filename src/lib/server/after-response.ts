/**
 * Keep `p` running after the HTTP response has been sent. On Vercel this is the runtime's
 * waitUntil (what @vercel/functions reads, without the dependency), bounded by the function's
 * maxDuration; elsewhere the promise simply runs on.
 */
export function runAfterResponse(p: Promise<unknown>): void {
	const ctx = (globalThis as Record<symbol, { get?: () => { waitUntil?: (p: Promise<unknown>) => void } } | undefined>)[
		Symbol.for('@vercel/request-context')
	]?.get?.();
	ctx?.waitUntil?.(p);
}
