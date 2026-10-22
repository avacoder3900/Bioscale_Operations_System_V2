/**
 * ARM-09 — browser-side driver for a verified run.
 *
 * The server keeps the run's state (robot_arm_verified_runs) and advances it
 * one request at a time (`verifiedNext`): start a chunk, notice it ended,
 * verify the step. This class is the loop that keeps calling it: while a
 * chunk plays it waits until the path should be over, then asks every
 * second; otherwise it calls next straight away. It stops when the run is
 * no longer `running` (passed / failed / stopped / error) or on Stop.
 *
 * Reloading the page mid-run: `resume(runId)` picks the loop back up from
 * whatever the server has — the run itself never depended on this tab.
 */
import { deserialize } from '$app/forms';
import type { VerifiedRunSummary } from '$lib/server/robot-arm-verified';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export class VerifiedRun {
	run = $state<VerifiedRunSummary | null>(null);
	/** A request is in flight. */
	busy = $state(false);
	/** The loop is driving the run. */
	active = $state(false);
	error = $state<string | null>(null);
	stopNote = $state<string | null>(null);
	now = $state(Date.now());
	/** Called once the run has ended (any outcome) or after Stop. */
	onend: (() => void) | null = null;
	private timer: ReturnType<typeof setInterval> | null = null;
	private stopRequested = false;

	readonly elapsedS = $derived(this.run?.playing ? Math.max(0, (this.now - Date.parse(this.run.playing.startedAt)) / 1000) : 0);
	readonly running = $derived(this.run?.status === 'running');
	/** The step the run is at: the chunk's verified step, or its last step. */
	readonly currentStep = $derived.by(() => {
		const r = this.run;
		if (!r || r.status !== 'running') return null;
		const c = r.chunks[r.cursor.chunk];
		return c ? (r.steps[c.verifyStep ?? c.to] ?? null) : null;
	});

	private async action(name: string, fields: Record<string, string>) {
		const fd = new FormData();
		for (const [k, v] of Object.entries(fields)) fd.set(k, v);
		const res = await fetch(`?/${name}`, { method: 'POST', body: fd, headers: { 'x-sveltekit-action': 'true' } });
		return deserialize(await res.text());
	}

	private take(r: Awaited<ReturnType<VerifiedRun['action']>>, what: string): boolean {
		if (r.type === 'failure') {
			this.error = String((r.data as { error?: string } | undefined)?.error ?? `${what} failed.`);
			return false;
		}
		if (r.type !== 'success' || !r.data?.run) {
			this.error = r.type === 'error' ? `${what} failed: ${r.error?.message ?? r.status}` : 'Unexpected response from the server.';
			return false;
		}
		this.run = r.data.run as VerifiedRunSummary;
		return true;
	}

	/** Start a run and drive it. The arm MOVES on the first `next`. */
	async start(kind: 'move_set' | 'sequence' | 'pose', id: string, camera: string) {
		if (this.busy || this.active) return;
		this.error = null;
		this.stopNote = null;
		this.stopRequested = false;
		this.busy = true;
		try {
			const r = await this.action('verifiedStart', { kind, id, camera });
			if (!this.take(r, 'Start')) return;
		} catch (e) {
			this.error = `Start failed: ${e instanceof Error ? e.message : String(e)}`;
			return;
		} finally {
			this.busy = false;
		}
		void this.loop();
	}

	/** Pick up a run already on the server (page reload, another tab started it). */
	async resume(runId: string) {
		if (this.busy || this.active) return;
		this.error = null;
		this.busy = true;
		try {
			const r = await this.action('verifiedRun', { runId });
			if (!this.take(r, 'Read')) return;
		} catch (e) {
			this.error = `Could not read the run: ${e instanceof Error ? e.message : String(e)}`;
			return;
		} finally {
			this.busy = false;
		}
		if (this.run?.status === 'running') void this.loop();
	}

	private async loop() {
		this.active = true;
		this.timer = setInterval(() => (this.now = Date.now()), 1000);
		try {
			while (this.active && !this.stopRequested && this.run?.status === 'running') {
				if (this.run.cursor.phase === 'playing' && this.run.playing) {
					// Nothing to do until the path should be over; then ask every second.
					const endAt = Date.parse(this.run.playing.startedAt) + this.run.playing.durationS * 1000;
					await sleep(Math.max(1000, endAt - Date.now() - 1000));
					if (this.stopRequested) break;
				}
				if (!(await this.next())) break;
			}
		} finally {
			this.active = false;
			if (this.timer) clearInterval(this.timer);
			this.timer = null;
			this.onend?.();
		}
	}

	private async next(): Promise<boolean> {
		if (!this.run) return false;
		this.busy = true;
		try {
			const r = await this.action('verifiedNext', { runId: this.run._id });
			return this.take(r, 'Next step');
		} catch (e) {
			this.error = `Next step failed: ${e instanceof Error ? e.message : String(e)}`;
			return false;
		} finally {
			this.busy = false;
		}
	}

	/** Stop: the Pi's replay stops, torque goes back on, the run is marked stopped. */
	async stop() {
		if (!this.run || this.stopRequested) return;
		this.stopRequested = true;
		this.busy = true;
		try {
			const r = await this.action('verifiedStop', { runId: this.run._id });
			if (this.take(r, 'Stop')) {
				const s = (r.type === 'success' ? (r.data as { stop?: { torqueOn: boolean; error: string | null } }).stop : null) ?? null;
				this.stopNote = s?.torqueOn ? 'Stopped — the arm is holding its position.' : `Stopped, but torque could NOT be re-enabled (${s?.error ?? 'unknown'}) — the arm may be limp.`;
			}
		} catch (e) {
			this.error = `Stop failed: ${e instanceof Error ? e.message : String(e)}`;
		} finally {
			this.busy = false;
			this.active = false;
		}
	}

	/** Forget a finished run (the panel closes). */
	clear() {
		if (this.active) return;
		this.run = null;
		this.error = null;
		this.stopNote = null;
	}

	destroy() {
		this.active = false;
		if (this.timer) clearInterval(this.timer);
		this.timer = null;
	}
}
