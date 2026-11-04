/**
 * A card's Hide/Show (2026-11-04): shown by default; an explicit Hide is
 * remembered in this browser under `key`. Create it while a component
 * initialises (it reads storage in an effect, after hydration).
 */
export class HideToggle {
	hidden = $state(false);

	constructor(private key: string) {
		$effect(() => {
			try {
				this.hidden = localStorage.getItem(this.key) === '1';
			} catch {
				/* storage unavailable — stay shown */
			}
		});
	}

	toggle() {
		this.hidden = !this.hidden;
		try {
			localStorage.setItem(this.key, this.hidden ? '1' : '0');
		} catch {
			/* ignore */
		}
	}
}
