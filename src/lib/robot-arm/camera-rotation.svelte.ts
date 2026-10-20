/**
 * How the arm camera's picture is turned for viewing, in this browser.
 *
 * The camera can be mounted on its side (portrait) — this only rotates what
 * the operator sees. Frames, AprilTag detection and every normalised
 * coordinate stay in the camera's own orientation, so nothing downstream
 * (pose, depth, calibration) depends on this setting.
 *
 * One module-level value, so the live panel in the arm layout and the Vision
 * tab's pictures always agree. Saved in localStorage like the panel's other
 * view preferences.
 */

export type Rotation = 0 | 90 | 180 | 270;

const STORAGE_KEY = 'bims.armCamera.rotation.v1';

// Starts at 0 on server and client alike, so the first client render matches
// the SSR HTML; components call restore() from an effect (client-only, after
// hydration) to apply the saved value.
let deg = $state<Rotation>(0);
let restored = false;

function restore() {
	if (restored) return;
	restored = true;
	try {
		const n = Number(localStorage.getItem(STORAGE_KEY));
		if (n === 90 || n === 180 || n === 270) deg = n;
	} catch {
		// Unreadable storage: stay upright.
	}
}

function set(next: number) {
	restored = true;
	deg = (((next % 360) + 360) % 360) as Rotation;
	try {
		localStorage.setItem(STORAGE_KEY, String(deg));
	} catch {
		// Private mode / quota. A view preference is a nicety.
	}
}

export const cameraRotation = {
	get deg(): Rotation {
		return deg;
	},
	/** Apply the saved rotation once; call from an $effect. */
	restore,
	/** Quarter turn counter-clockwise. */
	left: () => set(deg - 90),
	/** Quarter turn clockwise. */
	right: () => set(deg + 90),
	reset: () => set(0)
};
