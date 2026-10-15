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

export type StationHolder = { username: string | null; since: string | null };

/**
 * One read-only look at the station lock: does this tab still hold it, and if
 * not, who does? null = couldn't tell (network error) — treat as "unknown".
 */
export async function checkStationLock(
	stationId: string
): Promise<{ mine: boolean; holder: StationHolder | null } | null> {
	try {
		const res = await fetch(stationLockUrl(stationId), { cache: 'no-store' });
		if (!res.ok) return null;
		const body = await res.json();
		return { mine: body?.mine === true, holder: body?.holder ?? null };
	} catch {
		return null;
	}
}

const STATION_WATCH_MS = 10_000;

/**
 * Newest request wins: while this tab holds a station, check every 10 s that
 * it still does. Once another user or device has taken it over (or it was
 * force-released), call onLost exactly once and stop. Read-only — it never
 * re-claims, so two tabs can't fight over a station. Returns a stop function.
 */
export function watchStationLock(
	stationId: string,
	onLost: (holder: StationHolder | null) => void
): () => void {
	let stopped = false;
	const timer = setInterval(async () => {
		if (stopped) return;
		const state = await checkStationLock(stationId);
		if (stopped || !state || state.mine) return;
		stop();
		onLost(state.holder);
	}, STATION_WATCH_MS);
	function stop() {
		stopped = true;
		clearInterval(timer);
	}
	return stop;
}
