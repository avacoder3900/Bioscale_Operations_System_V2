/**
 * ARM-06 — browser-side playback state for the Animate pages.
 *
 * Play is a page action that renders the path, writes it to the Pi and
 * starts a replay; this class keeps the result, polls `?/playback` until the
 * Pi reports no active session, and estimates the playhead from the clock
 * (the Pi does not report progress). Each Animate page exposes the same
 * `playback` and `stop` actions, so one helper serves all three.
 */
import { deserialize } from '$app/forms';

export interface PlayStarted {
	runId: string;
	durationS: number;
	leadInS: number;
	frames: number;
	warnings: string[];
}

export class Playback {
	running = $state(false);
	title = $state('');
	runId = $state<string | null>(null);
	startedAt = $state(0);
	durationS = $state(0);
	leadInS = $state(0);
	now = $state(Date.now());
	error = $state<string | null>(null);
	warnings = $state<string[]>([]);
	outcome = $state<string | null>(null);
	busy = $state(false);
	private timer: ReturnType<typeof setInterval> | null = null;

	readonly elapsedS = $derived(this.running ? Math.max(0, (this.now - this.startedAt) / 1000) : 0);

	/** POST a page action and return its parsed result. */
	private async action(name: string, fields: Record<string, string>) {
		const fd = new FormData();
		for (const [k, v] of Object.entries(fields)) fd.set(k, v);
		const res = await fetch(`?/${name}`, { method: 'POST', body: fd, headers: { 'x-sveltekit-action': 'true' } });
		return deserialize(await res.text());
	}

	/** Start: `action` is the page's play action (playMoveSet / playSequence / play). */
	async play(action: string, fields: Record<string, string>, title: string) {
		if (this.busy || this.running) return;
		this.busy = true;
		this.error = null;
		this.outcome = null;
		this.warnings = [];
		try {
			const r = await this.action(action, fields);
			if (r.type === 'failure') {
				this.error = String((r.data as { error?: string } | undefined)?.error ?? 'Play failed.');
				return;
			}
			if (r.type !== 'success' || !r.data?.play) {
				this.error = r.type === 'error' ? `Play failed: ${r.error?.message ?? r.status}` : 'Unexpected response from the server.';
				return;
			}
			const p = r.data.play as PlayStarted;
			this.title = title;
			this.runId = p.runId;
			this.durationS = p.durationS;
			this.leadInS = p.leadInS;
			this.warnings = p.warnings ?? [];
			this.startedAt = Date.now();
			this.now = this.startedAt;
			this.running = true;
			this.timer = setInterval(() => void this.tick(), 1000);
		} catch (e) {
			this.error = `Play failed: ${e instanceof Error ? e.message : String(e)}`;
		} finally {
			this.busy = false;
		}
	}

	private polling = false;
	private async tick() {
		this.now = Date.now();
		// Ask the Pi only once the path should be nearly done, then every second.
		if (this.elapsedS < this.durationS - 1.5 || this.polling) return;
		this.polling = true;
		try {
			const r = await this.action('playback', {});
			if (r.type === 'success' && r.data && (r.data as { active?: unknown }).active === null) this.finish('finished');
		} catch {
			/* keep polling */
		} finally {
			this.polling = false;
		}
		if (this.running && this.elapsedS > this.durationS + 20) this.finish('the Pi did not report the end — check the Control tab');
	}

	async stop() {
		if (!this.running || this.busy) return;
		this.busy = true;
		try {
			const r = await this.action('stop', {});
			if (r.type === 'failure') this.error = String((r.data as { error?: string } | undefined)?.error ?? 'Stop failed.');
			else if (r.type === 'success' && r.data?.stop) {
				const s = r.data.stop as { torqueOn: boolean; error: string | null };
				this.finish(s.torqueOn ? 'stopped — the arm is holding its position' : `stopped, but torque could NOT be re-enabled (${s.error}) — the arm may be limp`);
			} else this.finish('stopped');
		} catch (e) {
			this.error = `Stop failed: ${e instanceof Error ? e.message : String(e)}`;
		} finally {
			this.busy = false;
		}
	}

	private finish(outcome: string) {
		this.running = false;
		this.outcome = outcome;
		if (this.timer) clearInterval(this.timer);
		this.timer = null;
	}

	destroy() {
		if (this.timer) clearInterval(this.timer);
		this.timer = null;
	}
}
