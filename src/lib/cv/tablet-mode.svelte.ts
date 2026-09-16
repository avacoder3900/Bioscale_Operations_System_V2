/**
 * Tablet mode — device-scoped touch UI switch for the CV capture stations.
 *
 * Defaults to auto-detection via `(pointer: coarse)`, which is right for the
 * Android tablets operators carry around the floor. The manual override exists
 * for the two cases auto-detection gets wrong:
 *
 *   • a touchscreen desktop monitor reports `pointer: coarse`, and letting that
 *     silently switch the page to tablet mode would disable the USB wedge
 *     scanner for a desktop operator — a real regression;
 *   • a tablet with a Bluetooth mouse attached reports `pointer: fine`.
 *
 * Stored in localStorage rather than on the user record ON PURPOSE: tablet mode
 * is a property of the DEVICE, not the operator. The same person uses the bench
 * desktop and the roaming tablet in one shift and needs opposite modes, so a
 * server-side user preference would be actively wrong.
 *
 * Lives in `$lib/cv/` because `$lib/stores/` and `$lib/utils/` are frozen per
 * CLAUDE.md.
 */
import { browser } from '$app/environment';

export type TabletModePref = 'auto' | 'on' | 'off';

const STORAGE_KEY = 'bims.cv.tablet-mode';
const COARSE_QUERY = '(pointer: coarse)';

/** Order the header chip cycles through. */
const CYCLE: TabletModePref[] = ['auto', 'on', 'off'];

function readStoredPref(): TabletModePref {
	if (!browser) return 'auto';
	try {
		const raw = localStorage.getItem(STORAGE_KEY);
		if (raw === 'auto' || raw === 'on' || raw === 'off') return raw;
	} catch {
		// Private mode / blocked storage / quota — fall back to auto.
	}
	return 'auto';
}

class TabletMode {
	/** What the operator chose. 'auto' defers to pointer detection. */
	pref = $state<TabletModePref>(readStoredPref());

	/** Live `(pointer: coarse)` result. Always false during SSR. */
	coarse = $state(false);

	/**
	 * The resolved answer every consumer should read.
	 *
	 * False on the server, so first paint is always the desktop layout and
	 * hydration flips it — avoids an SSR/client markup mismatch on /capture.
	 */
	readonly on = $derived(this.pref === 'auto' ? this.coarse : this.pref === 'on');

	/** Human label for the header chip. */
	readonly label = $derived(
		this.pref === 'auto' ? (this.coarse ? 'Touch (auto)' : 'Desktop (auto)') : this.pref === 'on' ? 'Touch' : 'Desktop'
	);

	constructor() {
		if (!browser) return;

		// matchMedia is missing in some embedded webviews; treat that as fine-pointer.
		const mq = typeof window.matchMedia === 'function' ? window.matchMedia(COARSE_QUERY) : null;
		if (!mq) return;

		this.coarse = mq.matches;
		// Live listener so docking/undocking a mouse updates without a reload.
		// Module-level singleton, so this intentionally lives for the page's lifetime.
		mq.addEventListener('change', (e) => {
			this.coarse = e.matches;
		});
	}

	set(next: TabletModePref) {
		this.pref = next;
		if (!browser) return;
		try {
			localStorage.setItem(STORAGE_KEY, next);
		} catch {
			// Non-fatal: the mode still applies for this page's lifetime.
		}
	}

	/** Advance auto → on → off → auto. Drives the header chip. */
	cycle() {
		const i = CYCLE.indexOf(this.pref);
		this.set(CYCLE[(i + 1) % CYCLE.length]);
	}
}

export const tablet = new TabletMode();
