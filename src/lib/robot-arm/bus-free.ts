/**
 * "The arm bus is free again" — a window event, so the panels that read the
 * servo bus (servo temperatures, torque) can re-read the moment a play ends
 * instead of waiting for their next poll. While a session is active the Pi
 * refuses every bus read with a 409 (single-owner bus), so those panels show
 * stale or "paused" values until they ask again.
 *
 * Fired by Playback once a play has fully ended (after-play torque restore
 * included), and by the servo row when the Pi starts answering again after a
 * session it did not start (teleop, a Control-tab replay).
 */
export const ARM_BUS_FREE_EVENT = 'robot-arm:bus-free';

/** `source` lets a listener ignore the event it fired itself. */
export function announceBusFree(source: string): void {
	if (typeof window === 'undefined') return;
	window.dispatchEvent(new CustomEvent(ARM_BUS_FREE_EVENT, { detail: { source } }));
}
