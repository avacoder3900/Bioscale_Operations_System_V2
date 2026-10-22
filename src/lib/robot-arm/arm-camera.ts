/**
 * Which arm camera the operator works with, remembered per browser. The
 * Vision tab and the Animate pages share the key, so a pose reference is
 * taken with the same camera the home calibration uses unless changed.
 */
export const ARM_CAMERA_KEY = 'bims.armVision.camera.v1';

export function loadChosenCamera(): string | null {
	try {
		return localStorage.getItem(ARM_CAMERA_KEY);
	} catch {
		return null;
	}
}

export function saveChosenCamera(name: string): void {
	try {
		localStorage.setItem(ARM_CAMERA_KEY, name);
	} catch {
		/* private window / blocked storage: the choice just does not persist */
	}
}

/** The camera to use: the remembered one if it still exists, else the first one that has references, else the first listed. */
export function pickCamera(names: string[], remembered: string | null, withReferences: string[] = []): string {
	if (remembered && names.includes(remembered)) return remembered;
	return withReferences.find((n) => names.includes(n)) ?? names[0] ?? '';
}
