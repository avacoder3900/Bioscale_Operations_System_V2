/**
 * Return to home, driven from the browser (ARM-05).
 *
 * One Return to home is a LOOP of attempts. Each attempt is one request to
 * the Vision tab's `?/returnHome` action (so it fits Vercel's 30 s): servo 1
 * safety gate → open the mouth (attempt 1 only) → servo 2 home → every joint
 * home → close the claw. The loop repeats until shouldRetryHome says stop:
 * home with the claw closed, a freeze, an error, Stop, "close enough" for
 * long enough, or HOME_LOOP_MS. However it ends, the LAST step closes the
 * mouth (`?/closeClaw`) unless it is already closed — except after a freeze,
 * where torque stays off for the technician.
 *
 * The actions live on the Vision tab's route and are addressed by that URL,
 * so the loop can be started from any Robot Arm tab (the ARM CONNECTION card
 * in the layout's right rail) as well as from the Vision tab itself. Both use
 * this one class, so the two can never drift.
 */
import { deserialize } from '$app/forms';
import { invalidateAll } from '$app/navigation';
import { announceBusFree } from '$lib/robot-arm/bus-free';
import { shouldRetryHome } from '$lib/robot-arm/home-calibration';
import type { HomeCheckResult } from '$lib/server/robot-arm-vision';

/** The route whose form actions run each attempt (`?/returnHome`, `?/stopReturn`, `?/closeClaw`). */
export const RETURN_HOME_ROUTE = '/manufacturing/cart-mfg/robot-arm/vision';

/** The Vision tab's chosen camera, remembered per browser; other tabs send it too. */
export const VISION_CAMERA_KEY = 'bims.armVision.camera.v1';

export const RETURN_HOME_CONFIRM =
	'The arm will MOVE until it is home: open the mouth, bring the shoulder (servo 2) home, then every joint, then close the claw. You can press Stop at any time. Is the path clear?';

/** The camera the Vision tab last chose in this browser, or null (the server then takes the newest active calibration). */
export function savedVisionCamera(): string | null {
	try {
		return localStorage.getItem(VISION_CAMERA_KEY);
	} catch {
		return null;
	}
}

export interface ReturnHomeLoop {
	running: boolean;
	attempt: number;
	startedAt: number;
	stopping: boolean;
	outcome: string | null;
	error: string | null;
	/** Final step in progress: closing the claw after the attempts ended. */
	closing: boolean;
	clawClosed: boolean;
	clawError: string | null;
	frozen: boolean;
	/** Sent with every attempt; Stop marks it on the server so the attempt in progress ends before its next jog. */
	runId: string;
}

export class ReturnHome {
	/** The loop in progress, or how the last one ended. Null until the first run (or after reset()). */
	loop = $state<ReturnHomeLoop | null>(null);
	/** The latest attempt's result. */
	result = $state<HomeCheckResult | null>(null);
	/** Ticks every 500 ms while a loop runs, for the elapsed-time readout. */
	now = $state(Date.now());

	readonly running = $derived(this.loop?.running === true);

	constructor(private readonly route: string = RETURN_HOME_ROUTE) {}

	/** Forget the last loop and its result (another home action is taking over the readout). */
	reset() {
		if (this.running) return;
		this.loop = null;
		this.result = null;
	}

	private async post(action: string, fields: Record<string, string>) {
		const fd = new FormData();
		for (const [k, v] of Object.entries(fields)) fd.set(k, v);
		const res = await fetch(`${this.route}?/${action}`, { method: 'POST', body: fd, headers: { 'x-sveltekit-action': 'true' } });
		return deserialize(await res.text());
	}

	/**
	 * Start the loop. `camera` is the Vision tab's camera (its active
	 * calibration holds the encoder home); empty/null lets the server pick the
	 * newest active calibration. Resolves when the loop has ended and the claw
	 * step is done. Does not ask for confirmation — the caller does.
	 */
	async run(camera: string | null) {
		if (this.running) return;
		const cam = camera ?? '';
		this.result = null;
		this.loop = { running: true, attempt: 0, startedAt: Date.now(), stopping: false, outcome: null, error: null, closing: false, clawClosed: false, clawError: null, frozen: false, runId: crypto.randomUUID() };
		// Read back through the proxy so every write below is reactive.
		const loop = this.loop;
		const clock = setInterval(() => (this.now = Date.now()), 500);
		try {
			for (;;) {
				loop.attempt++;
				const r = await this.post('returnHome', { camera: cam, attempt: String(loop.attempt), runId: loop.runId });
				if (r.type === 'failure') {
					loop.error = String((r.data as { error?: string } | undefined)?.error ?? 'Return to home failed.');
					break;
				}
				if (r.type !== 'success' || !r.data?.homeResult) {
					loop.error = r.type === 'error' ? `Return to home failed: ${r.error?.message ?? r.status}` : 'Unexpected response from the server.';
					break;
				}
				const h = r.data.homeResult as HomeCheckResult;
				this.result = h;
				loop.clawClosed = h.clawClosed === true;
				loop.frozen = h.home.verdict === 'frozen';
				const d = shouldRetryHome({ verdict: h.home.verdict, elapsedMs: Date.now() - loop.startedAt, residualMax: h.home.residualMax, clawClosed: h.clawClosed ?? null });
				if (loop.stopping) {
					loop.outcome = 'stopped by you';
					break;
				}
				if (!d.retry) {
					loop.outcome = d.reason;
					break;
				}
			}
		} catch (e) {
			loop.error = `Return to home failed: ${e instanceof Error ? e.message : String(e)}`;
		} finally {
			// The final step, every time: close the mouth (not after a freeze).
			if (!loop.frozen && !loop.clawClosed) await this.closeClawAtEnd(cam);
			clearInterval(clock);
			loop.running = false;
			// Torque changed under the loop (on to move; off after a freeze): let the Torque row re-read.
			announceBusFree('return-home');
			await invalidateAll();
		}
	}

	/**
	 * Stop returning: tell the server so the attempt in progress ends before
	 * its next jog (not after its whole ~20 s slice); the loop then closes the
	 * mouth as its final step. Marked locally first, so even if this request
	 * fails no further attempt starts.
	 */
	async stop(camera: string | null) {
		const loop = this.loop;
		if (!loop?.running || loop.stopping) return;
		loop.stopping = true;
		try {
			await this.post('stopReturn', { camera: camera ?? '', runId: loop.runId });
		} catch {
			/* the local flag still ends the loop after this attempt */
		}
	}

	private async closeClawAtEnd(camera: string) {
		const loop = this.loop;
		if (!loop) return;
		loop.closing = true;
		try {
			// Each request closes for up to ~20 s; three is far more than a claw needs.
			for (let i = 0; i < 3; i++) {
				const r = await this.post('closeClaw', { camera });
				if (r.type === 'failure') {
					loop.clawError = String((r.data as { error?: string } | undefined)?.error ?? 'Closing the claw failed.');
					return;
				}
				if (r.type !== 'success') {
					loop.clawError = r.type === 'error' ? `Closing the claw failed: ${r.error?.message ?? r.status}` : 'Unexpected response while closing the claw.';
					return;
				}
				if ((r.data?.clawResult as { closed?: boolean } | undefined)?.closed) {
					loop.clawClosed = true;
					return;
				}
			}
			loop.clawError = 'The claw did not reach its closed stop.';
		} catch (e) {
			loop.clawError = `Closing the claw failed: ${e instanceof Error ? e.message : String(e)}`;
		} finally {
			loop.closing = false;
		}
	}
}
