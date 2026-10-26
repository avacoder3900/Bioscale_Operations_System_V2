/**
 * Timers that keep their cadence while the tab is in the background.
 *
 * Chrome's "intensive wake-up throttling" (a tab hidden for ~5 min) aligns the
 * page's setTimeout/setInterval callbacks to ONCE PER MINUTE. The fill pages
 * are the run supervisor (status polling, pause acknowledgement, the start
 * sequence's waits), so an operator who switches to the other robot's tab
 * turns a 1 s loop into a 60 s loop — measured 2026-10-14: 167 of 170 wax-page
 * polling stalls happened while the reagent robot's page was in front, with the
 * stalls clustering at 60 s and 120 s.
 *
 * Dedicated Web Workers are exempt from that throttling, so the timer fires
 * from a tiny inline worker and posts back. Outside a browser (SSR, vitest,
 * the server line) or when a worker can't be created, it is a plain setTimeout.
 *
 * Isomorphic: no DOM access at import time.
 */

type Cancel = () => void;

const WORKER_SRC = `self.onmessage=function(e){var d=e.data;setTimeout(function(){self.postMessage(d.id)},d.ms)};`;

let shared: Worker | null | undefined;
let seq = 0;
const pending = new Map<number, () => void>();

function worker(): Worker | null {
	if (shared !== undefined) return shared;
	shared = null;
	try {
		if (typeof Worker === 'undefined' || typeof Blob === 'undefined' || typeof URL === 'undefined' || typeof URL.createObjectURL !== 'function') return null;
		const url = URL.createObjectURL(new Blob([WORKER_SRC], { type: 'text/javascript' }));
		const w = new Worker(url);
		w.onmessage = (e: MessageEvent<number>) => {
			const fn = pending.get(e.data);
			if (fn) {
				pending.delete(e.data);
				fn();
			}
		};
		w.onerror = () => {
			// A broken worker must never strand a timer: fall back for good.
			shared = null;
			for (const [id, fn] of pending) {
				pending.delete(id);
				setTimeout(fn, 0);
			}
		};
		shared = w;
	} catch {
		shared = null;
	}
	return shared;
}

/** True when timers are being driven from the worker (for diagnostics / tests). */
export function usingWorkerTimers(): boolean {
	return !!worker();
}

/** setTimeout that is not throttled in a background tab. Returns a cancel function. */
export function setUnthrottledTimeout(fn: () => void, ms: number): Cancel {
	const w = worker();
	if (!w) {
		const h = setTimeout(fn, ms);
		return () => clearTimeout(h);
	}
	const id = ++seq;
	pending.set(id, fn);
	w.postMessage({ id, ms });
	return () => {
		pending.delete(id);
	};
}

/** A sleep that keeps its length in a background tab. */
export function sleep(ms: number): Promise<void> {
	return new Promise<void>((resolve) => setUnthrottledTimeout(resolve, ms));
}

/**
 * Run `fn` whenever the document becomes visible again (the operator switched
 * back to this tab), so a page resyncs immediately instead of at its next tick.
 * No-op outside a browser. Returns an unsubscribe function.
 */
export function onVisible(fn: () => void): Cancel {
	if (typeof document === 'undefined' || typeof document.addEventListener !== 'function') return () => {};
	const handler = () => {
		if (document.visibilityState === 'visible') fn();
	};
	document.addEventListener('visibilitychange', handler);
	return () => document.removeEventListener('visibilitychange', handler);
}
