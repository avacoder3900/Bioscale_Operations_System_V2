<script lang="ts">
	/**
	 * Robot Arm — Wax fill. One cart per cycle: grab (arm) → scan (OT-2 gantry
	 * scanner at the taught position) → fill (OT-2 wax protocol, one cart) →
	 * withdraw (arm), for as many runs as asked. This page is the driver: each
	 * step is a page action whose result lands on the ArmWaxFillRun before the
	 * next one starts, so a reload shows where the cycle is and Resume carries
	 * on from there. The arm steps reuse the Animate Playback helper (end-of-
	 * play poll + settle); the fill step reuses EmbeddedRunController.
	 */
	import { onDestroy, onMount } from 'svelte';
	import { enhance, deserialize } from '$app/forms';
	import { invalidateAll } from '$app/navigation';
	import { Playback } from '$lib/robot-arm/playback.svelte';
	import { openRobotSession } from '$lib/opentrons/direct-client';
	import { restartServerOverBridge } from '$lib/opentrons/fill-bridge-jobs';
	import type { RobotHealth } from '$lib/server/opentrons/health';
	import EmbeddedRunController from '$lib/components/manufacturing/EmbeddedRunController.svelte';
	import type { LoopView, LoopCycleView, CalibrationView } from '$lib/server/arm-wax-fill';

	let { data, form } = $props();

	const STEP_LABEL: Record<string, string> = {
		grab: 'Grab',
		scan: 'Scan',
		fill: 'Fill',
		withdraw: 'Withdraw',
		done: 'Done',
		failed: 'Failed',
		stopped: 'Stopped'
	};
	const STEPS = ['grab', 'scan', 'fill', 'withdraw'] as const;

	// ── page state ───────────────────────────────────────────────────────
	let loop = $state<LoopView | null>(data.activeLoop);
	let calibration = $state<CalibrationView | null>(data.calibration);
	$effect(() => {
		// A reload (invalidateAll after a save) refreshes both from the server.
		calibration = data.calibration;
		// A finished loop stays on screen until the next Start; a running one found on load takes over.
		if (!driving && data.activeLoop) loop = data.activeLoop;
	});

	let runs = $state(1);
	let driving = $state(false);
	let busy = $state(false);
	let pageError = $state<string | null>(null);
	let log = $state<{ at: string; text: string; level: 'info' | 'warn' | 'error' }[]>([]);
	let fillRun = $state<{ opentronsRunId: string; waxRunId: string } | null>(null);
	let changingAnimations = $state(false);

	const currentCycle = $derived<LoopCycleView | null>(loop ? (loop.cycles[loop.cycles.length - 1] ?? null) : null);
	const robotId = $derived(data.settings.robotId);
	const anim = $derived(data.settings);
	// The robot runs the stage protocol (Wax_Filling_GEN7_ArmStage.py: fills the taught,
	// tip-neutral cart location, loads no deck) rather than the legacy carriage protocol.
	const stage = $derived(!!data.protocol?.declaresCartLocation);
	const animationOptions = $derived([
		...data.moveSets.map((m: { _id: string; name: string; keyframes: number }) => ({ value: `move_set:${m._id}`, label: `${m.name} (move set, ${m.keyframes} poses)` })),
		...data.sequences.map((s: { _id: string; name: string; items: number }) => ({ value: `sequence:${s._id}`, label: `${s.name} (sequence, ${s.items} move sets)` }))
	]);
	const animValue = (a: { kind: string; id: string } | null) => (a ? `${a.kind}:${a.id}` : '');

	function note(text: string, level: 'info' | 'warn' | 'error' = 'info') {
		log = [...log.slice(-199), { at: new Date().toLocaleTimeString(), text, level }];
	}

	async function post(name: string, fields: Record<string, string> = {}): Promise<{ ok: true; data: any } | { ok: false; error: string; status: number }> {
		const fd = new FormData();
		for (const [k, v] of Object.entries(fields)) fd.set(k, v);
		const res = await fetch(`?/${name}`, { method: 'POST', body: fd, headers: { 'x-sveltekit-action': 'true' } });
		const r = deserialize(await res.text());
		if (r.type === 'success') return { ok: true, data: r.data ?? {} };
		if (r.type === 'failure') return { ok: false, error: String((r.data as any)?.error ?? 'Failed'), status: r.status };
		if (r.type === 'error') return { ok: false, error: r.error?.message ?? 'Failed', status: r.status ?? 500 };
		return { ok: false, error: 'Unexpected response', status: 500 };
	}

	// ── the arm steps (Animate Playback helper) ──────────────────────────
	const playback = new Playback();
	onDestroy(() => playback.destroy());

	/**
	 * Play one arm step and resolve when the play has ended and settled. The
	 * helper only calls onend after a finished play's settle (or a Stop); a
	 * play the Pi never reports the end of just stops running with an outcome,
	 * so a watchdog turns that into a failure instead of a hang.
	 */
	function playStep(action: 'cycleGrab' | 'cycleWithdraw', title: string): Promise<{ ok: boolean; error?: string }> {
		return new Promise((resolve) => {
			let settled = false;
			let watchdog: ReturnType<typeof setInterval> | null = null;
			const done = (r: { ok: boolean; error?: string }) => {
				if (settled) return;
				settled = true;
				playback.onend = null;
				if (watchdog) clearInterval(watchdog);
				resolve(r);
			};
			playback.onend = () => {
				if (playback.outcome === 'finished') done({ ok: true });
				else done({ ok: false, error: playback.outcome ?? 'play did not finish' });
			};
			void playback.play(action, { loopId: loop!._id }, title).then(() => {
				if (playback.error) return done({ ok: false, error: playback.error });
				watchdog = setInterval(() => {
					if (!playback.running && playback.outcome && playback.outcome !== 'finished') done({ ok: false, error: playback.outcome });
				}, 1000);
			});
		});
	}

	// ── the scan step (one-slot sweep over the production scanner route) ─
	const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

	async function scanStep(): Promise<{ ok: true; sweepRunId: string; barcode: string } | { ok: false; error: string }> {
		if (!calibration?.scanPositionSetId) return { ok: false, error: 'No scan position is taught.' };
		let res: Response;
		try {
			res = await fetch('/api/scanner/sweep', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				credentials: 'same-origin',
				// liftBeforeMove: the daemon homes the pipette's Z (all the way up) before
				// every gantry move of this sweep — the arm and its stage stand above
				// anything the OT-2's planner knows about. The route also forces it for
				// the arm's one-slot set.
				body: JSON.stringify({ robotId, positionSetId: calibration.scanPositionSetId, source: 'wax_filling', contextRef: loop!._id, maxSlots: 1, liftBeforeMove: true })
			});
		} catch (e) {
			return { ok: false, error: `sweep request failed: ${e instanceof Error ? e.message : String(e)}` };
		}
		const body = await res.json().catch(() => ({}));
		if (!res.ok) return { ok: false, error: body?.message ?? `sweep refused (HTTP ${res.status})` };
		const sweepRunId = String(body.sweepRunId);
		note(`Scan: sweep ${sweepRunId} queued on ${loop!.robot.name}.`);
		const deadline = Date.now() + 3 * 60_000;
		while (Date.now() < deadline) {
			await sleep(1000);
			if (stopAsked) break;
			const r = await fetch(`/api/scanner/sweep/${sweepRunId}`, { credentials: 'same-origin' }).catch(() => null);
			if (!r?.ok) continue;
			const s = await r.json().catch(() => null);
			if (!s) continue;
			if (s.status === 'running' || s.status === 'paused') continue;
			const scan = (s.scans ?? [])[0];
			if (s.status === 'completed' && scan?.barcode) return { ok: true, sweepRunId, barcode: String(scan.barcode) };
			const err = (s.errors ?? [])[0]?.message ?? s.abortReason ?? `sweep ${s.status} with no barcode`;
			return { ok: false, error: err };
		}
		return { ok: false, error: stopAsked ? 'stopped while scanning' : 'the scanner did not answer within 3 minutes' };
	}

	// ── the fill step (EmbeddedRunController reports the end) ────────────
	let fillDone: ((status: string) => void) | null = null;
	function onFillComplete(status: string) {
		fillDone?.(status);
	}

	// ── the driver ───────────────────────────────────────────────────────
	let stopAsked = $state(false);

	async function fail(step: string, error: string) {
		note(`${STEP_LABEL[step] ?? step} failed: ${error}`, 'error');
		const r = await post('failLoop', { loopId: loop!._id, step, error });
		if (r.ok) loop = r.data.loop;
	}

	async function refreshLoop() {
		if (!loop) return;
		const r = await post('loopState', { loopId: loop._id });
		if (r.ok) loop = r.data.loop;
	}

	async function drive() {
		if (driving || !loop) return;
		driving = true;
		pageError = null;
		try {
			while (loop && loop.status === 'running') {
				const cycle = loop.cycles[loop.cycles.length - 1];
				if (!cycle) break;
				const tag = `Cycle ${cycle.index}/${loop.requestedRuns}`;
				if (cycle.step === 'grab') {
					if (stopAsked) break;
					// The OT-2 gantry must be home before the arm swings in over the stage; the
					// server refuses cycleGrab without this stamp, so a failure here ends the loop.
					note(`${tag}: homing the OT-2 gantry before the arm moves.`);
					const h = await post('homeGantry', { loopId: loop._id, before: 'grab' });
					if (stopAsked) {
						await refreshLoop();
						break;
					}
					if (!h.ok) {
						await fail('grab', `the OT-2 did not report home: ${h.error}`);
						break;
					}
					note(`${tag}: OT-2 home — grab — playing "${loop.grabAnimation?.name ?? ''}".`);
					const p = await playStep('cycleGrab', `Grab (cycle ${cycle.index})`);
					if (stopAsked) {
						// Stop ended the loop on the server while the arm was moving.
						await refreshLoop();
						break;
					}
					if (!p.ok) {
						await fail('grab', p.error ?? 'play failed');
						break;
					}
					const r = await post('cycleGrabDone', { loopId: loop._id });
					if (!r.ok) {
						await fail('grab', r.error);
						break;
					}
					loop = r.data.loop;
				} else if (cycle.step === 'scan') {
					if (stopAsked) break;
					note(`${tag}: scan at the taught position.`);
					const s = await scanStep();
					if (stopAsked) {
						await refreshLoop();
						break;
					}
					if (!s.ok) {
						await fail('scan', s.error);
						break;
					}
					note(`${tag}: read ${s.barcode}.`);
					const r = await post('cycleScanned', { loopId: loop._id, sweepRunId: s.sweepRunId, barcode: s.barcode });
					if (!r.ok) {
						await fail('scan', r.error);
						break;
					}
					loop = r.data.loop;
				} else if (cycle.step === 'fill') {
					let run = cycle.opentronsRunId && cycle.waxRunId ? { opentronsRunId: cycle.opentronsRunId, waxRunId: cycle.waxRunId } : null;
					if (!run) {
						note(`${tag}: starting the wax fill for ${cycle.barcode} (${stage ? 'at the taught stage location' : `deck position ${loop.cartPosition}`}).`);
						const r = await post('cycleFill', { loopId: loop._id });
						if (!r.ok) {
							await fail('fill', r.error);
							break;
						}
						run = { opentronsRunId: r.data.opentronsRunId, waxRunId: r.data.waxRunId };
					} else {
						note(`${tag}: watching robot run ${run.opentronsRunId} already started.`);
					}
					fillRun = run;
					const status = await new Promise<string>((resolve) => (fillDone = resolve));
					fillDone = null;
					fillRun = null;
					note(`${tag}: robot run ended ${status}.`, status === 'succeeded' ? 'info' : 'error');
					if (stopAsked) {
						// A Reset while the OT-2 was filling ended the loop on the server (a plain
						// Stop leaves it running: the fill and the withdraw finish first).
						await refreshLoop();
						if (loop?.status !== 'running') break;
					}
					const r = await post('cycleFillDone', { loopId: loop._id, finalStatus: status });
					if (!r.ok) {
						await fail('fill', r.error);
						break;
					}
					loop = r.data.loop;
				} else if (cycle.step === 'withdraw') {
					// The fill's protocol homes at its end too; this is the stamp the server insists on.
					note(`${tag}: homing the OT-2 gantry before the arm moves.`);
					const h = await post('homeGantry', { loopId: loop._id, before: 'withdraw' });
					if (!h.ok) {
						if (stopAsked) {
							// A Reset while homing ended the loop on the server; nothing to fail.
							await refreshLoop();
							if (loop?.status !== 'running') break;
						}
						await fail('withdraw', `the OT-2 did not report home: ${h.error}`);
						break;
					}
					note(`${tag}: OT-2 home — withdraw — playing "${loop.withdrawAnimation?.name ?? ''}".`);
					const p = await playStep('cycleWithdraw', `Withdraw (cycle ${cycle.index})`);
					if (stopAsked) {
						// Stop pressed while the arm was withdrawing ends the loop on the server; a Stop
						// pressed during the fill leaves it running and cycleWithdrawDone ends it below.
						await refreshLoop();
						if (loop?.status !== 'running') break;
					}
					if (!p.ok) {
						await fail('withdraw', p.error ?? 'play failed');
						break;
					}
					const r = await post('cycleWithdrawDone', { loopId: loop._id });
					if (!r.ok) {
						await fail('withdraw', r.error);
						break;
					}
					loop = r.data.loop;
					note(r.data.next ? `${tag} done — ${loop!.completedRuns} of ${loop!.requestedRuns} filled.` : `Loop ${loop!.status}: ${loop!.completedRuns} of ${loop!.requestedRuns} filled.`);
				} else {
					await refreshLoop();
					break;
				}
			}
		} catch (e) {
			pageError = e instanceof Error ? e.message : String(e);
		} finally {
			driving = false;
			stopAsked = false;
			await invalidateAll();
		}
	}

	async function start() {
		if (busy || driving) return;
		busy = true;
		pageError = null;
		log = [];
		try {
			const r = await post('startLoop', { runs: String(runs) });
			if (!r.ok) {
				pageError = r.error;
				return;
			}
			loop = r.data.loop;
			note(`Loop started: ${loop!.requestedRuns} run${loop!.requestedRuns === 1 ? '' : 's'} on ${loop!.robot.name}.`);
		} finally {
			busy = false;
		}
		void drive();
	}

	async function stop() {
		if (!loop || busy) return;
		busy = true;
		try {
			stopAsked = true;
			const r = await post('stopLoop', { loopId: loop._id });
			if (!r.ok) {
				pageError = r.error;
				return;
			}
			loop = r.data.loop;
			if (r.data.stoppedArm) note(r.data.torqueOn ? 'Stopped — the arm is holding its position.' : 'Stopped, but torque could NOT be re-enabled — the arm may be limp.', r.data.torqueOn ? 'warn' : 'error');
			else if (loop!.status === 'running') note('Stop requested — the current fill and withdraw finish first.', 'warn');
			else note('Stopped.', 'warn');
		} finally {
			busy = false;
		}
	}

	// ── OT-2 controls (the Robots board's card for this one robot) ────────
	// Health is the bridge heartbeat (ready / busy / hung / offline), polled
	// every 10 s from the same endpoint the board uses, so the dot stays fresh
	// without an invalidateAll in the middle of a loop. Restart (robot server),
	// Reset (force back to idle), Home, Lights and Identify are the controls
	// the wax and reagent filling sides have; Play / Pause / Stop for the fill
	// itself are on the embedded run controller while a cart is being filled.
	let health = $state<RobotHealth | null>(data.health);
	$effect(() => {
		health = data.health;
	});
	let robotBusy = $state<'restart' | 'reset' | 'home' | 'lights' | 'identify' | null>(null);
	let robotMsg = $state<{ text: string; level: 'info' | 'warn' | 'error' } | null>(null);
	let lightsOn = $state<boolean | null>(null);

	async function pollHealth() {
		if (!robotId) return;
		try {
			const res = await fetch('/api/opentrons-lab/robots/health', { credentials: 'same-origin' });
			if (!res.ok) return;
			const body = await res.json();
			const h = body?.health?.[robotId];
			if (h) health = h;
		} catch {
			/* transient — keep the last reading */
		}
	}

	async function readLights() {
		if (!robotId) return;
		try {
			const res = await fetch(`/api/opentrons-lab/robots/${robotId}/lights`, { credentials: 'same-origin' });
			if (res.ok) lightsOn = !!(await res.json())?.on;
		} catch {
			/* unknown until the next toggle */
		}
	}

	onMount(() => {
		void pollHealth();
		const t = setInterval(pollHealth, 10_000);
		return () => clearInterval(t);
	});
	$effect(() => {
		if (robotId) void readLights();
		else lightsOn = null;
	});

	function say(text: string, level: 'info' | 'warn' | 'error' = 'info') {
		robotMsg = { text, level };
		if (loop) note(text, level);
	}

	function healthDot(status?: string | null): string {
		switch (status) {
			case 'ready': return 'bg-green-400';
			case 'busy': return 'bg-amber-400';
			case 'hung': return 'bg-red-500 animate-pulse';
			case 'offline': return 'bg-gray-500';
			default: return 'bg-gray-600';
		}
	}
	function healthText(status?: string | null): string {
		switch (status) {
			case 'ready': return 'text-green-300';
			case 'busy': return 'text-amber-300';
			case 'hung': return 'text-red-300';
			case 'offline': return 'text-gray-400';
			default: return 'text-[var(--color-tron-text-secondary)]';
		}
	}

	/** Restart the OT-2 robot server (clears a hung engine, ~90 s) — the board's Restart. */
	async function restartServer() {
		if (!robotId || robotBusy) return;
		const name = data.robotName ?? 'this robot';
		const extra = loop?.status === 'running' ? '\n\nA loop is running: the robot server refuses the restart while a fill is live; stop or reset the loop first if it needs to come down now.' : '';
		if (!confirm(`Restart the robot server on ${name}?\n\nThis clears a hung engine (~90 s to come back). Any in-progress run on this robot will be cancelled.${extra}`)) return;
		robotBusy = 'restart';
		robotMsg = null;
		try {
			// Tailnet line: the restart is a daemon job over /bridge (BIMS audits it first). Otherwise the queue POST.
			const session = await openRobotSession(robotId);
			try {
				const bridge = session.bridge();
				if (bridge) {
					const r = await restartServerOverBridge(bridge, robotId);
					say(r.ok ? r.message : r.error, r.ok ? 'warn' : 'error');
					return;
				}
			} finally {
				session.close();
			}
			const res = await fetch(`/api/opentrons-lab/robots/${robotId}/restart-server`, { method: 'POST', credentials: 'same-origin' });
			const body = await res.json().catch(() => ({}));
			say(res.ok ? (body.message ?? 'Restart sent.') : (body.message ?? body.error ?? 'Restart failed.'), res.ok ? 'warn' : 'error');
		} catch {
			say('Restart request failed — check the bridge.', 'error');
		} finally {
			robotBusy = null;
			setTimeout(pollHealth, 3000);
		}
	}

	/**
	 * Force everything back to idle — the board's Reset, plus this line's loop:
	 * the loop ends now (the arm's play is stopped if it is moving), then the
	 * OT-2 force-reset aborts the one-cart wax run and clears the robot's own
	 * run and any stale maintenance run. Carts are left as they are.
	 */
	async function forceReset() {
		if (!robotId || robotBusy) return;
		const name = data.robotName ?? 'this robot';
		if (!confirm(`Force ${name} back to idle?\n\nThis ENDS the running loop (stopping the arm if it is moving), ABORTS any active wax/reagent run on this robot and clears its run state. Use for stale/stuck runs. Carts are left as-is.`)) return;
		robotBusy = 'reset';
		robotMsg = null;
		stopAsked = true;
		try {
			const r = await post('resetLoop');
			if (!r.ok) {
				say(`Loop reset failed: ${r.error}`, 'error');
				return;
			}
			if (r.data.loop) {
				loop = r.data.loop;
				if (r.data.stoppedArm) note(r.data.torqueOn ? 'Reset — the arm was stopped and is holding its position.' : 'Reset — the arm was stopped, but torque could NOT be re-enabled; it may be limp.', r.data.torqueOn ? 'warn' : 'error');
			}
			const res = await fetch(`/api/opentrons-lab/robots/${robotId}/force-reset`, { method: 'POST', credentials: 'same-origin' });
			const body = await res.json().catch(() => ({}));
			say(res.ok ? (body.message ?? 'Reset to idle.') : (body.message ?? body.error ?? 'Reset failed.'), res.ok ? 'warn' : 'error');
			await invalidateAll();
		} catch {
			say('Reset request failed — check the bridge.', 'error');
		} finally {
			// The driver clears stopAsked itself when it winds down; nothing was driving otherwise.
			if (!driving) stopAsked = false;
			robotBusy = null;
			setTimeout(pollHealth, 1500);
		}
	}

	/** Home the OT-2 gantry (not during a loop or with the teach panel's maintenance run open). */
	async function homeGantry() {
		if (!robotId || robotBusy) return;
		if (!confirm(`Home all axes on ${data.robotName ?? 'this robot'}? Make sure the deck is clear.`)) return;
		robotBusy = 'home';
		robotMsg = null;
		try {
			const res = await fetch(`/api/opentrons-lab/robots/${robotId}/home`, { method: 'POST', credentials: 'same-origin' });
			const body = await res.json().catch(() => ({}));
			say(res.ok ? 'Homed.' : (body.message ?? body.error ?? 'Home failed.'), res.ok ? 'info' : 'error');
		} catch (e) {
			say(`Home failed: ${e instanceof Error ? e.message : String(e)}`, 'error');
		} finally {
			robotBusy = null;
		}
	}

	async function toggleLights() {
		if (!robotId || robotBusy) return;
		robotBusy = 'lights';
		try {
			const res = await fetch(`/api/opentrons-lab/robots/${robotId}/lights`, {
				method: 'POST',
				credentials: 'same-origin',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ on: !lightsOn })
			});
			if (res.ok) lightsOn = !lightsOn;
			else say('Could not switch the rail lights.', 'error');
		} catch {
			say('Could not reach the robot for the lights.', 'error');
		} finally {
			robotBusy = null;
		}
	}

	async function identify() {
		if (!robotId || robotBusy) return;
		robotBusy = 'identify';
		try {
			const res = await fetch(`/api/opentrons-lab/robots/${robotId}/identify`, { method: 'POST', credentials: 'same-origin' });
			if (!res.ok) say('Could not reach the robot to blink its lights.', 'error');
		} catch {
			say('Could not reach the robot to blink its lights.', 'error');
		} finally {
			robotBusy = null;
		}
	}

	const ctl = 'rounded border px-2.5 py-1 text-[11px] font-medium transition-colors disabled:opacity-50';
	const ctlPlain = `${ctl} border-[var(--color-tron-border)] text-[var(--color-tron-text-secondary)] hover:border-[var(--color-tron-cyan)] hover:text-[var(--color-tron-text)]`;

	// The calibration for this robot's wax fill (scan position, tip-neutral cart
	// location, dispense depth, stage geometry) is taught on its own tab, the arm
	// line's Stage calibration studio; this page only shows what is taught.
	const STAGE_CALIBRATION_HREF = '/manufacturing/cart-mfg/robot-arm/stage-calibration';

	const fmt = (p: { x: number; y: number; z: number } | null) => (p ? `x ${p.x.toFixed(2)} · y ${p.y.toFixed(2)} · z ${p.z.toFixed(2)}` : 'not taught');
	const when = (iso: string | null) => (iso ? new Date(iso).toLocaleString() : '');
	const stepClass = (cycle: LoopCycleView | null, step: string) => {
		if (!cycle) return 'border-[var(--color-tron-border)] text-[var(--color-tron-text-secondary)]';
		const i = STEPS.indexOf(step as (typeof STEPS)[number]);
		const cur = STEPS.indexOf(cycle.step as (typeof STEPS)[number]);
		if (cycle.step === 'done' || (cur > i && cur >= 0)) return 'border-green-500/40 bg-green-900/15 text-green-300';
		if (cur === i) return 'border-[var(--color-tron-cyan)] bg-[var(--color-tron-cyan)]/15 text-[var(--color-tron-cyan)]';
		if (cycle.step === 'failed' || cycle.step === 'stopped') return 'border-red-500/30 text-red-300/70';
		return 'border-[var(--color-tron-border)] text-[var(--color-tron-text-secondary)]';
	};
</script>

<div class="space-y-4">
	<div>
		<h2 class="text-lg font-bold" style="color: var(--color-tron-cyan)">Wax fill</h2>
		<p class="mt-1 text-xs" style="color: var(--color-tron-text-secondary)">
			The arm feeds one cart at a time onto its stage: OT-2 gantry <span class="font-semibold">home</span> → <span class="font-semibold">grab</span> →
			<span class="font-semibold">scan</span> at the taught position → <span class="font-semibold">fill</span>
			{#if stage}at the taught cart location with the stage protocol{:else}with the robot's carriage protocol (one cart, deck position {data.settings.cartPosition}){/if}
			→ gantry <span class="font-semibold">home</span> → <span class="font-semibold">withdraw</span>, for as many runs as you ask. The arm never
			moves until the OT-2 confirms its gantry is home. The cart-drop unit will slot in before the grab once it is ready.
		</p>
	</div>

	{#if form?.error}<div class="rounded border border-red-500/40 bg-red-900/20 p-2 text-xs text-red-300">{form.error}</div>{/if}
	{#if form?.success}<div class="rounded border border-green-500/30 bg-green-900/15 p-2 text-xs text-green-300">{form.success}</div>{/if}
	{#if pageError}<div class="rounded border border-red-500/40 bg-red-900/20 p-2 text-xs text-red-300">{pageError}</div>{/if}

	<!-- ── Run ───────────────────────────────────────────────────────── -->
	<section class="rounded-lg border border-[var(--color-tron-cyan)]/30 bg-[var(--color-tron-surface)]/40 p-4 space-y-3">
		<!-- The OT-2's card from the Robots board: health, Restart, Reset — plus Home, Lights, Identify. -->
		<div class="rounded border px-3 py-2 text-xs {health?.status === 'hung' ? 'border-red-500/50 bg-red-900/10' : 'border-[var(--color-tron-border)] bg-black/30'}" aria-label="Robot controls">
			<div class="flex flex-wrap items-center justify-between gap-2">
				<div class="flex min-w-0 items-center gap-2">
					<span class="h-2.5 w-2.5 shrink-0 rounded-full {healthDot(health?.status)}" title={health ? `${health.label}: ${health.detail}` : 'No health data'}></span>
					{#if robotId}
						<span class="truncate font-semibold" style="color: var(--color-tron-text)">{data.robotName ?? robotId}</span>
						<span class="truncate {healthText(health?.status)}" title={health?.detail ?? ''}>
							{health?.label ?? 'No health data'}{#if health?.detail} <span style="color: var(--color-tron-text-secondary)">— {health.detail}</span>{/if}
						</span>
					{:else}
						<span style="color: var(--color-tron-text-secondary)">No OT-2 chosen — pick one in Setup.</span>
					{/if}
				</div>
				<div class="flex flex-wrap items-center gap-1">
					<a href={STAGE_CALIBRATION_HREF}
						title="This robot's wax-fill calibration: scan position, tip-neutral cart location, dispense depth, stage geometry (its own tab)"
						class="{ctl} border-[var(--color-tron-cyan)]/60 bg-[var(--color-tron-cyan)]/10 text-[var(--color-tron-cyan)] hover:bg-[var(--color-tron-cyan)]/20">
						Stage calibration
					</a>
					<button type="button" onclick={identify} disabled={!robotId || robotBusy !== null} title="Blink the rail lights to find this robot" class={ctlPlain}>
						{robotBusy === 'identify' ? 'Blinking…' : 'Identify'}
					</button>
					<button type="button" onclick={toggleLights} disabled={!robotId || robotBusy !== null} title="Toggle the rail lights"
						class="{ctl} {lightsOn ? 'border-[var(--color-tron-cyan)]/60 bg-[var(--color-tron-cyan)]/10 text-[var(--color-tron-cyan)]' : 'border-[var(--color-tron-border)] text-[var(--color-tron-text-secondary)] hover:border-[var(--color-tron-cyan)] hover:text-[var(--color-tron-text)]'}">
						{lightsOn === null ? 'Lights' : lightsOn ? 'Lights on' : 'Lights off'}
					</button>
					<button type="button" onclick={homeGantry} disabled={!robotId || robotBusy !== null || loop?.status === 'running'}
						title={loop?.status === 'running' ? 'Not while a loop is running' : 'Home all axes'} class={ctlPlain}>
						{robotBusy === 'home' ? 'Homing…' : 'Home'}
					</button>
					<button type="button" onclick={restartServer} disabled={!robotId || robotBusy !== null} title="Restart the robot server (clears a hung engine, ~90 s)"
						class="{ctl} {health?.status === 'hung' ? 'border-red-500/60 bg-red-900/30 text-red-200 hover:bg-red-900/50' : 'border-[var(--color-tron-border)] text-[var(--color-tron-text-secondary)] hover:border-[var(--color-tron-cyan)] hover:text-[var(--color-tron-text)]'}">
						{robotBusy === 'restart' ? 'Restarting…' : 'Restart'}
					</button>
					<button type="button" onclick={forceReset} disabled={!robotId || robotBusy !== null} title="End the loop, abort any stale run and force this robot back to idle"
						class="{ctl} border-red-500/40 bg-red-900/15 text-red-300 hover:bg-red-900/30">
						{robotBusy === 'reset' ? 'Resetting…' : 'Reset'}
					</button>
				</div>
			</div>
			{#if robotMsg}
				<p class="mt-1.5 text-[11px] {robotMsg.level === 'error' ? 'text-red-300' : robotMsg.level === 'warn' ? 'text-amber-300' : ''}" style={robotMsg.level === 'info' ? 'color: var(--color-tron-text-secondary)' : ''}>{robotMsg.text}</p>
			{/if}
		</div>

		<div class="flex flex-wrap items-center justify-between gap-3">
			<h3 class="text-sm font-bold uppercase tracking-wider" style="color: var(--color-tron-text-secondary)">Run</h3>
			{#if loop && loop.status === 'running'}
				<div class="flex items-center gap-2">
					{#if !driving}
						<button type="button" onclick={() => void drive()} disabled={busy}
							class="rounded border border-[var(--color-tron-cyan)] bg-[var(--color-tron-cyan)]/15 px-4 py-2 text-sm font-bold text-[var(--color-tron-cyan)] hover:bg-[var(--color-tron-cyan)]/25 disabled:opacity-40">
							Resume
						</button>
					{/if}
					<button type="button" onclick={stop} disabled={busy || loop.stopRequested}
						class="rounded border border-red-500/50 bg-red-900/15 px-4 py-2 text-sm font-bold text-red-300 hover:bg-red-900/25 disabled:opacity-40">
						{loop.stopRequested ? 'Stopping…' : 'Stop'}
					</button>
				</div>
			{:else}
				<form class="flex items-center gap-2" onsubmit={(e) => { e.preventDefault(); void start(); }}>
					<label class="flex items-center gap-2 text-xs" style="color: var(--color-tron-text-secondary)">
						Runs
						<input type="number" min="1" max="500" bind:value={runs}
							class="w-20 rounded border border-[var(--color-tron-border)] bg-black/30 px-2 py-1.5 font-mono text-sm" style="color: var(--color-tron-text)" />
					</label>
					<button type="submit" disabled={busy || data.readiness.blocking.length > 0}
						class="rounded-lg bg-[var(--color-tron-cyan)] px-5 py-2 text-sm font-semibold text-white hover:bg-[var(--color-tron-cyan)]/80 disabled:opacity-40">
						{busy ? 'Starting…' : `Start ${runs} run${runs === 1 ? '' : 's'}`}
					</button>
				</form>
			{/if}
		</div>

		{#if !(loop && loop.status === 'running')}
			{#if data.readiness.blocking.length}
				<ul class="space-y-1 rounded border border-amber-500/40 bg-amber-900/15 p-2 text-xs text-amber-200">
					{#each data.readiness.blocking as b (b)}<li>· {b}</li>{/each}
				</ul>
			{/if}
			{#each data.readiness.notes as n (n)}
				<p class="text-[11px]" style="color: var(--color-tron-text-secondary)">{n}</p>
			{/each}
		{/if}

		{#if loop}
			<div class="rounded border border-[var(--color-tron-border)] bg-black/30 p-3 space-y-3">
				<div class="flex flex-wrap items-center justify-between gap-2 text-xs">
					<span style="color: var(--color-tron-text)">
						<span class="font-semibold">Cycle {currentCycle?.index ?? 0} of {loop.requestedRuns}</span>
						· {loop.completedRuns} filled · {loop.robot.name}
						{#if currentCycle?.barcode}· cart <span class="font-mono" style="color: var(--color-tron-cyan)">{currentCycle.barcode}</span>{/if}
					</span>
					<span class="rounded px-2 py-0.5 text-[10px] font-bold uppercase tracking-wider
						{loop.status === 'running' ? 'bg-[var(--color-tron-cyan)]/20 text-[var(--color-tron-cyan)]' : loop.status === 'completed' ? 'bg-green-900/30 text-green-300' : 'bg-red-900/30 text-red-300'}">
						{loop.status}{driving ? ' · driving' : loop.status === 'running' ? ' · paused in this browser' : ''}
					</span>
				</div>
				<div class="grid grid-cols-4 gap-2">
					{#each STEPS as s (s)}
						<div class="rounded border px-2 py-2 text-center text-xs font-semibold {stepClass(currentCycle, s)}">{STEP_LABEL[s]}</div>
					{/each}
				</div>
				{#if loop.error}<p class="text-xs text-red-300">{loop.error}</p>{/if}

				{#if playback.running}
					<div class="text-xs" style="color: var(--color-tron-text-secondary)">
						Arm: {playback.title} — {playback.elapsedS.toFixed(0)} / {playback.durationS.toFixed(0)} s
						{#if playback.warnings.length}<span class="text-amber-300">· {playback.warnings.join(' ')}</span>{/if}
					</div>
				{:else if playback.settled}
					<div class="text-[11px]" style="color: var(--color-tron-text-secondary)">{playback.settled}</div>
				{/if}

				{#if fillRun}
					<EmbeddedRunController robotId={loop.robot._id} robotName={loop.robot.name} opentronsRunId={fillRun.opentronsRunId} onComplete={onFillComplete} />
				{/if}

				{#if log.length}
					<ul class="max-h-56 space-y-0.5 overflow-y-auto font-mono text-[11px]">
						{#each log as l, i (i)}
							<li class={l.level === 'error' ? 'text-red-300' : l.level === 'warn' ? 'text-amber-300' : ''} style={l.level === 'info' ? 'color: var(--color-tron-text-secondary)' : ''}>
								<span class="opacity-60">{l.at}</span> {l.text}
							</li>
						{/each}
					</ul>
				{/if}

				{#if loop.cycles.length > 1 || loop.status !== 'running'}
					<details class="text-xs">
						<summary class="cursor-pointer" style="color: var(--color-tron-text-secondary)">Cycles ({loop.cycles.length})</summary>
						<table class="mt-2 w-full text-left text-[11px]">
							<thead style="color: var(--color-tron-text-secondary)"><tr><th class="pr-2">#</th><th class="pr-2">Step</th><th class="pr-2">Cart</th><th class="pr-2">Robot run</th><th>Note</th></tr></thead>
							<tbody>
								{#each loop.cycles as c (c.index)}
									<tr style="color: var(--color-tron-text)">
										<td class="pr-2">{c.index}</td>
										<td class="pr-2">{STEP_LABEL[c.step] ?? c.step}</td>
										<td class="pr-2 font-mono">{c.barcode ?? '—'}</td>
										<td class="pr-2 font-mono">{c.opentronsRunId ? `${c.opentronsRunId.slice(0, 8)}… ${c.opentronsRunFinalStatus ?? ''}` : '—'}</td>
										<td class={c.error ? 'text-red-300' : ''}>{c.error ?? ''}</td>
									</tr>
								{/each}
							</tbody>
						</table>
					</details>
				{/if}
			</div>
		{/if}
	</section>

	<div class="grid grid-cols-1 gap-4 lg:grid-cols-2">
		<!-- ── Setup ─────────────────────────────────────────────────── -->
		<section class="rounded-lg border border-[var(--color-tron-border)] bg-[var(--color-tron-surface)] p-4">
			<h3 class="text-sm font-bold uppercase tracking-wider" style="color: var(--color-tron-text-secondary)">Setup</h3>
			<form method="POST" action="?/saveSetup" use:enhance class="mt-3 space-y-3 text-xs">
				<label class="block">
					<span style="color: var(--color-tron-text-secondary)">OT-2 the arm feeds</span>
					<select name="robotId" required class="mt-1 w-full rounded border border-[var(--color-tron-border)] bg-black/30 px-2 py-1.5" style="color: var(--color-tron-text)">
						<option value="">— pick a robot —</option>
						{#each data.robots as r (r._id)}<option value={r._id} selected={r._id === data.settings.robotId}>{r.name}</option>{/each}
					</select>
				</label>
				<label class="block">
					<span style="color: var(--color-tron-text-secondary)">{stage ? 'Deck (optional — provenance only; the stage protocol loads no deck)' : 'Deck the single-cart fixture is registered as'}</span>
					<select name="deckId" required={!stage} class="mt-1 w-full rounded border border-[var(--color-tron-border)] bg-black/30 px-2 py-1.5" style="color: var(--color-tron-text)">
						<option value="">{stage ? '— none —' : '— pick a deck —'}</option>
						{#each data.decks as d (d._id)}
							<option value={d._id} selected={d._id === data.settings.deckId}>{d.name}{d.deckLoadName ? ` · ${d.deckLoadName}` : ' · not bound to a labware definition'}</option>
						{/each}
					</select>
					<span class="mt-1 block text-[11px]" style="color: var(--color-tron-text-secondary)">
						{#if stage}
							The stage protocol fills the taught cart location (Calibration below): it reads no Particle id and loads no deck definition.
						{:else}
							The carriage protocol picks the deck definition by the Particle id it reads at run start, so the fixture must be a registered, bound deck — a stopgap: for the elevated single-cart stage upload <span class="font-mono">protocols/Wax_Filling_GEN7_ArmStage.py</span> to this robot.
						{/if}
					</span>
				</label>
				<div class="grid grid-cols-2 gap-3">
					{#if stage}
						<div class="block text-[11px]" style="color: var(--color-tron-text-secondary)">
							<span class="block" style="color: var(--color-tron-text-secondary)">Stage</span>
							<span class="mt-1 block">Cart rotation and dispense depth are taught on the <a href={STAGE_CALIBRATION_HREF} class="underline" style="color: var(--color-tron-cyan)">Stage calibration</a> tab. The pipette goes all the way up before every move.</span>
						</div>
					{:else}
						<label class="block">
							<span style="color: var(--color-tron-text-secondary)">Deck position filled (1–24)</span>
							<input name="cartPosition" type="number" min="1" max="24" value={data.settings.cartPosition} required
								class="mt-1 w-full rounded border border-[var(--color-tron-border)] bg-black/30 px-2 py-1.5 font-mono" style="color: var(--color-tron-text)" />
						</label>
					{/if}
					<label class="block">
						<span style="color: var(--color-tron-text-secondary)">Wax lot (optional)</span>
						<input name="waxSourceLot" value={data.settings.waxSourceLot ?? ''} placeholder="stamped on each wax run"
							class="mt-1 w-full rounded border border-[var(--color-tron-border)] bg-black/30 px-2 py-1.5 font-mono" style="color: var(--color-tron-text)" />
					</label>
				</div>
				<label class="flex items-center gap-2" style="color: var(--color-tron-text-secondary)">
					<input type="checkbox" name="testMode" checked={data.settings.testMode} />
					Test mode — a barcode the system does not know becomes a synthetic backed cart (as in the wax wizard's test mode)
				</label>
				<div class="flex items-center justify-between gap-3">
					<span class="text-[11px]" style="color: var(--color-tron-text-secondary)">
						{#if data.protocol}
							Protocol on {data.robotName}: <span class="font-mono">{data.protocol.protocolName}</span>
							{data.protocol.declaresCartLocation ? '· stage protocol: fills the taught cart location (arm_cart_x/y/z)' : '· carriage protocol: fills the deck position; arm_cart_x/y/z not declared'}
						{:else if data.settings.robotId}
							<span class="text-amber-300">No wax-filling protocol on this robot.</span>
						{/if}
					</span>
					<button type="submit" class="rounded border border-[var(--color-tron-cyan)] bg-[var(--color-tron-cyan)]/15 px-4 py-1.5 text-xs font-bold text-[var(--color-tron-cyan)] hover:bg-[var(--color-tron-cyan)]/25">Save setup</button>
				</div>
			</form>
		</section>

		<!-- ── Animations ────────────────────────────────────────────── -->
		<section class="rounded-lg border border-[var(--color-tron-border)] bg-[var(--color-tron-surface)] p-4">
			<div class="flex items-center justify-between">
				<h3 class="text-sm font-bold uppercase tracking-wider" style="color: var(--color-tron-text-secondary)">Animations</h3>
				{#if !changingAnimations}
					<button type="button" onclick={() => (changingAnimations = true)} disabled={loop?.status === 'running'}
						class="rounded border border-[var(--color-tron-border)] px-3 py-1 text-xs hover:border-[var(--color-tron-cyan)] disabled:opacity-40" style="color: var(--color-tron-text)">
						Change animations
					</button>
				{/if}
			</div>
			<p class="mt-1 text-[11px]" style="color: var(--color-tron-text-secondary)">
				Chosen once and kept for every run. Made in <a href="/manufacturing/cart-mfg/robot-arm/animate" class="underline" style="color: var(--color-tron-cyan)">Animate</a> (move sets or sequences).
			</p>
			{#if changingAnimations}
				<form method="POST" action="?/saveAnimations" use:enhance={() => async ({ update }) => { changingAnimations = false; await update(); }} class="mt-3 space-y-3 text-xs">
					<label class="block">
						<span style="color: var(--color-tron-text-secondary)">Grab — plays before the scan</span>
						<select name="grab" required class="mt-1 w-full rounded border border-[var(--color-tron-border)] bg-black/30 px-2 py-1.5" style="color: var(--color-tron-text)">
							<option value="">— pick —</option>
							{#each animationOptions as o (o.value)}<option value={o.value} selected={o.value === animValue(anim.grabAnimation)}>{o.label}</option>{/each}
						</select>
					</label>
					<label class="block">
						<span style="color: var(--color-tron-text-secondary)">Withdraw — plays after the fill</span>
						<select name="withdraw" required class="mt-1 w-full rounded border border-[var(--color-tron-border)] bg-black/30 px-2 py-1.5" style="color: var(--color-tron-text)">
							<option value="">— pick —</option>
							{#each animationOptions as o (o.value)}<option value={o.value} selected={o.value === animValue(anim.withdrawAnimation)}>{o.label}</option>{/each}
						</select>
					</label>
					<div class="flex justify-end gap-2">
						<button type="button" onclick={() => (changingAnimations = false)} class="rounded border border-[var(--color-tron-border)] px-3 py-1.5 text-xs" style="color: var(--color-tron-text)">Cancel</button>
						<button type="submit" class="rounded border border-[var(--color-tron-cyan)] bg-[var(--color-tron-cyan)]/15 px-4 py-1.5 text-xs font-bold text-[var(--color-tron-cyan)] hover:bg-[var(--color-tron-cyan)]/25">Save animations</button>
					</div>
				</form>
			{:else}
				<dl class="mt-3 grid grid-cols-[auto_1fr] gap-x-4 gap-y-2 text-xs">
					<dt style="color: var(--color-tron-text-secondary)">Grab</dt>
					<dd class="font-semibold" style="color: var(--color-tron-text)">{anim.grabAnimation?.name ?? '— not chosen —'}{#if anim.grabAnimation}<span class="ml-1 font-normal opacity-60">({anim.grabAnimation.kind === 'sequence' ? 'sequence' : 'move set'})</span>{/if}</dd>
					<dt style="color: var(--color-tron-text-secondary)">Withdraw</dt>
					<dd class="font-semibold" style="color: var(--color-tron-text)">{anim.withdrawAnimation?.name ?? '— not chosen —'}{#if anim.withdrawAnimation}<span class="ml-1 font-normal opacity-60">({anim.withdrawAnimation.kind === 'sequence' ? 'sequence' : 'move set'})</span>{/if}</dd>
				</dl>
				{#if anim.animationsChangedAt}
					<p class="mt-2 text-[11px]" style="color: var(--color-tron-text-secondary)">Last changed {when(anim.animationsChangedAt)}{anim.animationsChangedBy ? ` by ${anim.animationsChangedBy}` : ''}.</p>
				{/if}
			{/if}
		</section>
	</div>

	<!-- ── Calibration summary (taught on the Stage calibration tab) ────── -->
	<section class="rounded-lg border border-[var(--color-tron-border)] bg-[var(--color-tron-surface)] p-4 space-y-3">
		<div class="flex flex-wrap items-center justify-between gap-2">
			<div>
				<h3 class="text-sm font-bold uppercase tracking-wider" style="color: var(--color-tron-text-secondary)">Stage calibration{#if data.robotName} · {data.robotName}{/if}{#if data.protocol} · <span class="font-mono normal-case tracking-normal">{data.protocol.protocolName}</span>{/if}</h3>
				<p class="mt-1 text-[11px]" style="color: var(--color-tron-text-secondary)">What this robot's wax fill runs on. Taught on the <a href={STAGE_CALIBRATION_HREF} class="underline" style="color: var(--color-tron-cyan)">Stage calibration</a> tab — the arm line's own studio for the single-cart stage.</p>
			</div>
			<a href={STAGE_CALIBRATION_HREF} class="rounded border border-[var(--color-tron-cyan)] bg-[var(--color-tron-cyan)]/15 px-4 py-1.5 text-xs font-bold text-[var(--color-tron-cyan)] hover:bg-[var(--color-tron-cyan)]/25">Open Stage calibration</a>
		</div>
		<div class="grid grid-cols-1 gap-3 text-xs md:grid-cols-2 xl:grid-cols-4">
			<div class="rounded border border-[var(--color-tron-border)] bg-black/30 p-3">
				<div class="font-semibold" style="color: var(--color-tron-text)">Scan position</div>
				<div class="mt-1 font-mono" style="color: var(--color-tron-cyan)">{fmt(calibration?.scanPosition ?? null)}</div>
				<div class="mt-1 text-[11px]" style="color: var(--color-tron-text-secondary)">
					Where the gantry scanner reads the cart.
					{#if calibration?.scanPosition?.taughtAt}Taught {when(calibration.scanPosition.taughtAt)}{calibration.scanPosition.taughtBy ? ` by ${calibration.scanPosition.taughtBy}` : ''}.{/if}
				</div>
			</div>
			<div class="rounded border border-[var(--color-tron-border)] bg-black/30 p-3">
				<div class="font-semibold" style="color: var(--color-tron-text)">Cart location</div>
				<div class="mt-1 font-mono" style="color: var(--color-tron-cyan)">{fmt(calibration?.cartLocation ?? null)}</div>
				<div class="mt-1 text-[11px]" style="color: var(--color-tron-text-secondary)">
					First wax hole rim, tip-neutral.
					{#if calibration?.cartLocation?.tipAdjust}Probe at teach <span class="font-mono">{calibration.cartLocation.tipAdjust.x}, {calibration.cartLocation.tipAdjust.y}</span>.{:else if calibration?.cartLocation}<span class="text-amber-300">Taught without a probed tip — teach again.</span>{/if}
				</div>
			</div>
			<div class="rounded border border-[var(--color-tron-border)] bg-black/30 p-3">
				<div class="font-semibold" style="color: var(--color-tron-text)">Dispense depth</div>
				<div class="mt-1 font-mono" style="color: var(--color-tron-cyan)">
					{#if calibration?.dispenseDepth}{Math.abs(calibration.dispenseDepth.mm)} mm {calibration.dispenseDepth.mm >= 0 ? 'below' : 'above'} the rim{:else}not taught{/if}
				</div>
				<div class="mt-1 text-[11px]" style="color: var(--color-tron-text-secondary)">Where the tip end sits when wax is dispensed.{#if !calibration?.dispenseDepth} <span class="text-amber-300">Required before a stage fill.</span>{/if}</div>
			</div>
			<div class="rounded border border-[var(--color-tron-border)] bg-black/30 p-3">
				<div class="font-semibold" style="color: var(--color-tron-text)">Stage geometry</div>
				<div class="mt-1 font-mono" style="color: var(--color-tron-cyan)">rotation {calibration?.stageRotationDeg ?? 0}° · travel: all the way up</div>
				<div class="mt-1 text-[11px]" style="color: var(--color-tron-text-secondary)">How the stage holds the cart. Every move between stations starts with a full lift of the pipette.</div>
			</div>
		</div>
	</section>

	<!-- ── History ───────────────────────────────────────────────────── -->
	{#if data.recentLoops.length}
		<section class="rounded-lg border border-[var(--color-tron-border)] bg-[var(--color-tron-surface)] p-4">
			<h3 class="text-sm font-bold uppercase tracking-wider" style="color: var(--color-tron-text-secondary)">Recent loops</h3>
			<table class="mt-2 w-full text-left text-xs">
				<thead style="color: var(--color-tron-text-secondary)"><tr><th class="pr-3 py-1">Started</th><th class="pr-3">By</th><th class="pr-3">Robot</th><th class="pr-3">Filled</th><th class="pr-3">Status</th><th>Note</th></tr></thead>
				<tbody>
					{#each data.recentLoops as l (l._id)}
						<tr style="color: var(--color-tron-text)">
							<td class="pr-3 py-1">{when(l.startedAt)}</td>
							<td class="pr-3">{l.startedBy ?? ''}</td>
							<td class="pr-3">{l.robot.name}</td>
							<td class="pr-3 font-mono">{l.completedRuns} / {l.requestedRuns}</td>
							<td class="pr-3 {l.status === 'completed' ? 'text-green-300' : l.status === 'failed' ? 'text-red-300' : 'text-amber-300'}">{l.status}</td>
							<td class="text-[11px]" style="color: var(--color-tron-text-secondary)">{l.error ?? ''}</td>
						</tr>
					{/each}
				</tbody>
			</table>
		</section>
	{/if}
</div>
