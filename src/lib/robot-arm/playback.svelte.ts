/**
 * ARM-06 — browser-side playback state for the Animate pages.
 *
 * Play is a page action that renders the path, writes it to the Pi and
 * starts a replay; this class keeps the result, polls `?/playback` until the
 * Pi reports no active session, and estimates the playhead from the clock
 * (the Pi does not report progress). Each Animate page exposes the same
 * `playback`, `stop` and `settle` actions, so one helper serves all three.
 * Go to pose is a one-pose play and runs through here too.
 *
 * When a play finishes on its own, the helper calls `settle` by itself
 * (afterPlay on the server): torque straight back on if the Pi dropped it,
 * nothing else (droop correction removed 2026-11-06). Not after Stop — the
 * arm is mid-path then. `onend` lets the page refresh.
 *
 * 2026-10-30: every request carries a timeout, so a poll that hangs (one did,
 * for a minute, on the arm wax-fill line) can no longer stall the end of a
 * play; the poll runs every half second near the end and sends the run id,
 * which lets the server answer from the Pi's own `replay.stop` webhook
 * without a Pi round trip. A loop play (`{ loop: true }`) is one the robot-arm
 * wax-fill line drives; the loop checks the arm's arrival itself.
 */
import { deserialize } from '$app/forms';

export interface PlayStarted {
	runId: string;
	durationS: number;
	leadInS: number;
	frames: number;
	warnings: string[];
}

/** How long past the path's end the helper keeps asking before it gives up on the Pi. */
const END_GRACE_S = 20;
const POLL_EVERY_MS = 500;
const POLL_TIMEOUT_MS = 8_000;
const ACTION_TIMEOUT_MS = 60_000;

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
	/** What the automatic settle after the play did (or why it skipped). */
	settled = $state<string | null>(null);
	busy = $state(false);
	/** Called once a play has ended and the after-play step is done (or after Stop). */
	onend: (() => void) | null = null;
	private timer: ReturnType<typeof setInterval> | null = null;
	private loopPlay = false;

	readonly elapsedS = $derived(this.running ? Math.max(0, (this.now - this.startedAt) / 1000) : 0);

	/** POST a page action and return its parsed result. Every call is bounded. */
	private async action(name: string, fields: Record<string, string>, timeoutMs = ACTION_TIMEOUT_MS) {
		const fd = new FormData();
		for (const [k, v] of Object.entries(fields)) fd.set(k, v);
		const res = await fetch(`?/${name}`, { method: 'POST', body: fd, headers: { 'x-sveltekit-action': 'true' }, signal: AbortSignal.timeout(timeoutMs) });
		return deserialize(await res.text());
	}

	/**
	 * Start: `action` is the page's play action (playMoveSet / playSequence / play).
	 * `loop: true` marks a robot-arm wax-fill loop play.
	 */
	async play(action: string, fields: Record<string, string>, title: string, opts: { loop?: boolean } = {}) {
		if (this.busy || this.running) return;
		this.busy = true;
		this.error = null;
		this.outcome = null;
		this.settled = null;
		this.warnings = [];
		this.loopPlay = !!opts.loop;
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
			this.timer = setInterval(() => void this.tick(), POLL_EVERY_MS);
		} catch (e) {
			this.error = `Play failed: ${e instanceof Error ? e.message : String(e)}`;
		} finally {
			this.busy = false;
		}
	}

	private polling = false;
	private async tick() {
		this.now = Date.now();
		if (!this.running) return;
		// A play the Pi never reports the end of: give up rather than hang the page.
		if (this.elapsedS > this.durationS + END_GRACE_S) return this.finish('the Pi did not report the end — check the Control tab');
		// Ask only once the path should be nearly done, then every half second.
		if (this.elapsedS < this.durationS - 1 || this.polling) return;
		this.polling = true;
		try {
			const r = await this.action('playback', this.runId ? { runId: this.runId } : {}, POLL_TIMEOUT_MS);
			if (!this.running) return; // gave up (or stopped) while this poll was out
			if (r.type === 'success' && r.data && (r.data as { active?: unknown }).active === null) {
				this.finish('finished');
				void this.settle();
			}
		} catch {
			/* a slow or failed poll: the next tick asks again */
		} finally {
			this.polling = false;
		}
	}

	async stop() {
		if (!this.running || this.busy) return;
		this.busy = true;
		try {
			const r = await this.action('stop', {});
			if (r.type === 'failure') this.error = String((r.data as { error?: string } | undefined)?.error ?? 'Stop failed.');
			else if (r.type === 'success' && r.data?.stop) {
				const s = r.data.stop as { torqueOn: boolean; error: string | null; firesOnly?: boolean };
				this.finish(s.firesOnly ? 'stopped' : s.torqueOn ? 'stopped — the arm is holding its position' : `stopped, but torque could NOT be re-enabled (${s.error}) — the arm may be limp`);
			} else this.finish('stopped');
			this.onend?.();
		} catch (e) {
			this.error = `Stop failed: ${e instanceof Error ? e.message : String(e)}`;
		} finally {
			this.busy = false;
		}
	}

	/** Automatic, after a play ends: torque back on if the Pi dropped it. Nothing else (no droop correction since 2026-11-06). */
	private async settle() {
		const runId = this.runId;
		if (!runId) return;
		this.settled = 'Holding the last pose…';
		try {
			const r = await this.action('settle', { runId });
			type Settle = { torqueRestored: boolean; torqueError: string | null; skipped: string | null };
			const s = r.type === 'success' ? (r.data as { settle?: Settle } | undefined)?.settle : null;
			if (!s) this.settled = r.type === 'failure' ? String((r.data as { error?: string } | undefined)?.error ?? '') : null;
			else if (s.torqueError) this.settled = `Torque could NOT be turned back on (${s.torqueError}) — the arm may be limp.`;
			else this.settled = s.torqueRestored ? 'Torque was off after the play and is back on.' : null;
		} catch (e) {
			this.settled = `After-play check failed: ${e instanceof Error ? e.message : String(e)}`;
		}
		this.onend?.();
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
