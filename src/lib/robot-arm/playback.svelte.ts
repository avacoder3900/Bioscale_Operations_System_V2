/**
 * ARM-06 — browser-side playback state for the Animate pages.
 *
 * Play is a page action that renders the path, writes it to the Pi and
 * starts a replay; this class keeps the result, polls `?/playback` until the
 * Pi reports no active session, and estimates the playhead from the clock
 * (the Pi does not report progress). Each Animate page exposes the same
 * `playback`, `stop` and `settle` actions, so one helper serves all three.
 *
 * When a play finishes on its own, the helper calls `settle` by itself: the
 * server nudges the arm onto the last pose and learns that pose's droop
 * correction (settleAfterPlay). Not after Stop — the arm is mid-path then.
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
	/** What the automatic settle after the play did (or why it skipped). */
	settled = $state<string | null>(null);
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
		this.settled = null;
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
			if (r.type === 'success' && r.data && (r.data as { active?: unknown }).active === null) {
				this.finish('finished');
				void this.settle();
			}
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

	/** Automatic: correct the arm onto the last pose and learn its droop. */
	private async settle() {
		const runId = this.runId;
		if (!runId) return;
		this.settled = 'Correcting for droop at the last pose…';
		try {
			const r = await this.action('settle', { runId });
			type PiPose = { poseName: string; trim: number[]; residual: number[]; rounds: number; ok: boolean };
			type Settle = { poseName: string; skipped: string | null; pi: { poses: PiPose[] } | null; droop: { trim: number[]; rounds: number; warnings: string[] } | null };
			const s = r.type === 'success' ? (r.data as { settle?: Settle } | undefined)?.settle : null;
			if (!s) this.settled = r.type === 'failure' ? `Droop correction failed: ${String((r.data as { error?: string } | undefined)?.error ?? '')}` : null;
			else if (s.skipped) this.settled = `Droop correction skipped: ${s.skipped}.`;
			else if (s.pi) {
				// The Pi settled each held pose during the replay (closed-loop route); nothing moved afterwards.
				const parts = s.pi.poses.map((p) => {
					const worst = p.residual.length ? Math.max(...p.residual.map(Math.abs)) : 0;
					return `"${p.poseName}" ${p.ok ? `on target (${p.rounds} round${p.rounds === 1 ? '' : 's'})` : `still ${worst} step(s) off when the hold ran out`}`;
				});
				const missed = s.pi.poses.filter((p) => !p.ok).length;
				this.settled = `Settled on the arm during the play: ${parts.join('; ')}. Corrections learned for the next play.${missed ? ' Give the poses that missed a longer hold.' : ''}`;
			} else if (s.droop) {
				const t = s.droop.trim.map((v, i) => (v ? `servo ${i + 1} ${v > 0 ? '+' : ''}${v}` : null)).filter(Boolean);
				this.settled = `Settled on "${s.poseName}"${t.length ? ` — droop correction ${t.join(', ')}` : ' — no droop'} (learned; used from the next play).` + (s.droop.warnings.length ? ' ' + s.droop.warnings.join(' ') : '');
			}
		} catch (e) {
			this.settled = `Droop correction failed: ${e instanceof Error ? e.message : String(e)}`;
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
