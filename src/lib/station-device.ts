/**
 * Per-browser-tab device id for the CV station lock (one device per station).
 *
 * Kept in sessionStorage, so it survives reloads of the same tab (the tab keeps
 * its own lock) but every new tab or device gets a fresh id. Storage can be
 * unavailable (private mode, blocked site data) — then the id lives for this
 * page load only, which still keeps two devices apart.
 */
const KEY = 'bims.stationDeviceId';
let memoryId: string | null = null;

function newId(): string {
	try {
		if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
			return crypto.randomUUID();
		}
	} catch {
		// fall through
	}
	return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}`;
}

export function stationDeviceId(): string {
	if (memoryId) return memoryId;
	try {
		const stored = sessionStorage.getItem(KEY);
		if (stored) return (memoryId = stored);
		const id = newId();
		sessionStorage.setItem(KEY, id);
		return (memoryId = id);
	} catch {
		return (memoryId = newId());
	}
}

/** `/api/cv/stations/<id>/lock?device=<this tab>` plus any extra query params. */
export function stationLockUrl(stationId: string, extra: Record<string, string> = {}): string {
	const qs = new URLSearchParams({ device: stationDeviceId(), ...extra });
	return `/api/cv/stations/${encodeURIComponent(stationId)}/lock?${qs}`;
}
