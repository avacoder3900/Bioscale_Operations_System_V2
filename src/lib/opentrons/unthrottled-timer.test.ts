/**
 * unthrottled-timer: in a browser the timer runs from a Web Worker (exempt from
 * Chrome's background-tab throttling); without one it is a plain setTimeout.
 * vitest has no Worker, so these cover the fallback contract both pages rely on.
 */
import { describe, it, expect } from 'vitest';
import { setUnthrottledTimeout, sleep, onVisible, usingWorkerTimers } from './unthrottled-timer';

describe('unthrottled-timer (no Worker here → setTimeout fallback)', () => {
	it('falls back cleanly when no Worker exists', () => {
		expect(usingWorkerTimers()).toBe(false);
	});
	it('fires after the delay and can be cancelled', async () => {
		const fired: number[] = [];
		setUnthrottledTimeout(() => fired.push(1), 10);
		const cancel = setUnthrottledTimeout(() => fired.push(2), 10);
		cancel();
		await sleep(40);
		expect(fired).toEqual([1]);
	});
	it('sleep waits at least the requested time', async () => {
		const t0 = Date.now();
		await sleep(30);
		expect(Date.now() - t0).toBeGreaterThanOrEqual(25);
	});
	it('onVisible is a no-op outside a browser and returns an unsubscribe', () => {
		const off = onVisible(() => {});
		expect(typeof off).toBe('function');
		off();
	});
});
