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
	import { RobotSession, openRobotSession, type RobotSessionState } from '$lib/opentrons/direct-client';
	import { restartServerOverBridge } from '$lib/opentrons/fill-bridge-jobs';
	import type { RobotHealth } from '$lib/server/opentrons/health';
	import EmbeddedRunController from '$lib/components/manufacturing/EmbeddedRunController.svelte';
	import TransportPill from '$lib/components/opentrons/TransportPill.svelte';
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
	let teaching = $state(false);

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
				body: JSON.stringify({ robotId, positionSetId: calibration.scanPositionSetId, source: 'wax_filling', contextRef: loop!._id, maxSlots: 1 })
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

	/**
	 * "Calibrate wax fill" in the robot row: the calibration for THIS robot's
	 * wax-fill protocol lives on this page (scan position + tip-neutral cart
	 * location, per OT-2), so the button opens the teach panel and scrolls to it.
	 * The tip-calibrator point the probe uses is taught in the Studio; the card
	 * links there with this robot preselected.
	 */
	function goToCalibration() {
		if (!robotId || loop?.status === 'running') return;
		teaching = true;
		requestAnimationFrame(() => document.getElementById('wax-fill-calibration')?.scrollIntoView({ behavior: 'smooth', block: 'start' }));
	}
	const studioCalibratorHref = $derived(robotId ? `/manufacturing/cart-mfg/deck-calibration?kind=calibrator&robot=${encodeURIComponent(robotId)}` : '/manufacturing/cart-mfg/deck-calibration?kind=calibrator');

	// ── calibration: teach panel (maintenance run + jog, as the scanner pages) ──
	let robotSession: RobotSession | null = null;
	let robotConn = $state<RobotSessionState | null>(null);
	$effect(() => {
		const id = robotId;
		if (!id) return;
		const s = new RobotSession(id);
		robotSession = s;
		s.subscribe((st) => (robotConn = st));
		void s.open();
		return () => {
			s.close();
			robotSession = null;
		};
	});

	let maintRunId = $state<string | null>(null);
	let pipetteId = $state<string | null>(null);
	let pipetteMount = $state<string | null>(null);
	let pipetteName = $state<string | null>(null);
	let connecting = $state(false);
	let teachBusy = $state(false);
	let teachError = $state<string | null>(null);
	let teachInfo = $state<string | null>(null);
	let stepSize = $state(1);
	let zAxis = $state<'leftZ' | 'rightZ'>(data.calibration?.pipetteMount === 'right' ? 'rightZ' : 'leftZ');
	let liveX = $state<number | null>(null);
	let liveY = $state<number | null>(null);
	let liveZ = $state<number | null>(null);
	let testScanInFlight = $state(false);
	let testScanError = $state<string | null>(null);
	let testScanLatest = $state<string | null>(null);

	// Tip state for the cart location. The fill probes every tip on the calibrator
	// and adds that tip's adjust to the taught point, so the point has to be saved
	// TIP-NEUTRAL: teach with a probed tip on and store live − adjust (the Deck
	// Calibration Studio's rule). The scan position is the opposite: taught with
	// NO tip, because the sweep runs the gantry without one.
	let hasTip = $state(false);
	let tipAdjust = $state<{ x: number; y: number } | null>(null);
	let tipWell = $state<string>(data.teach?.nextTipWell ?? 'A1');
	let calibrating = $state(false);
	// Arc height for teach-panel travel over the raised stage (the planner only
	// knows the labware on the deck, not the stage). Well inside a p20's reach.
	const TEACH_ARC_Z = 120;

	async function apiRaw(path: string, init?: RequestInit): Promise<{ status: number; ok: boolean; body: any }> {
		const doFetch = robotSession ? robotSession.fetchRoute.bind(robotSession) : fetch;
		const res = await doFetch(path, { ...init, credentials: 'same-origin', headers: { 'Content-Type': 'application/json', ...(init?.headers ?? {}) } });
		const text = await res.text();
		let body: any = null;
		try {
			body = text ? JSON.parse(text) : null;
		} catch {
			body = text;
		}
		return { status: res.status, ok: res.ok, body };
	}

	async function api(path: string, init?: RequestInit): Promise<any> {
		const { status, ok, body } = await apiRaw(path, init);
		if (!ok) throw new Error(`${init?.method ?? 'GET'} ${path} → HTTP ${status}: ${body?.message ?? (typeof body === 'string' ? body : JSON.stringify(body))}`);
		return body;
	}

	async function openMaintenance() {
		teachError = null;
		connecting = true;
		try {
			const body: Record<string, unknown> = {};
			if (calibration?.pipetteMount) body.mount = calibration.pipetteMount;
			if (calibration?.pipetteName) body.pipetteName = calibration.pipetteName;
			const res = await api(`/api/opentrons-lab/robots/${robotId}/maintenance`, { method: 'POST', body: JSON.stringify(body) });
			maintRunId = res.runId ?? null;
			pipetteId = res.pipetteId ?? null;
			pipetteMount = res.mount ?? null;
			pipetteName = res.pipetteName ?? null;
			zAxis = pipetteMount === 'right' ? 'rightZ' : 'leftZ';
			teachInfo = pipetteId ? `Connected: pipette ${pipetteName} on ${pipetteMount}.` : 'Maintenance run opened but no pipette could be loaded — jog will fail.';
		} catch (e) {
			teachError = e instanceof Error ? e.message : String(e);
		} finally {
			connecting = false;
		}
	}

	async function closeMaintenance() {
		if (!maintRunId) return;
		teachBusy = true;
		try {
			// Leave the pipette clean: a tip still on would be carried into the next
			// run's tip-length model. Best effort — the close happens regardless.
			if (hasTip && pipetteId) {
				await api(`/api/opentrons-lab/robots/${robotId}/maintenance/${maintRunId}/drop-tip`, { method: 'POST', body: JSON.stringify({ pipetteId }) }).catch(() => null);
			}
			await api(`/api/opentrons-lab/robots/${robotId}/maintenance/${maintRunId}`, { method: 'DELETE' });
		} catch (e) {
			teachError = e instanceof Error ? e.message : String(e);
		} finally {
			maintRunId = pipetteId = pipetteMount = pipetteName = null;
			liveX = liveY = liveZ = null;
			// The tip and its probe die with the run.
			hasTip = false;
			tipAdjust = null;
			teachBusy = false;
		}
	}

	async function refreshPosition() {
		if (!maintRunId || !pipetteId) return;
		const res = await api(`/api/opentrons-lab/robots/${robotId}/maintenance/${maintRunId}/position`, { method: 'POST', body: JSON.stringify({ pipetteId }) });
		if (res?.position) {
			liveX = res.position.x;
			liveY = res.position.y;
			liveZ = res.position.z;
		}
	}

	async function teach(fn: () => Promise<void>) {
		if (!maintRunId || !pipetteId) {
			teachError = 'Open a maintenance run first.';
			return;
		}
		teachError = null;
		teachBusy = true;
		try {
			await fn();
		} catch (e) {
			teachError = e instanceof Error ? e.message : String(e);
		} finally {
			teachBusy = false;
		}
	}

	const home = () =>
		teach(async () => {
			await api(`/api/opentrons-lab/robots/${robotId}/maintenance/${maintRunId}/home`, { method: 'POST', body: JSON.stringify({}) });
			await refreshPosition();
		});
	const jog = (axis: string, distance: number) =>
		teach(async () => {
			await api(`/api/opentrons-lab/robots/${robotId}/maintenance/${maintRunId}/jog`, { method: 'POST', body: JSON.stringify({ pipetteId, axis, distance }) });
			await refreshPosition();
		});
	const moveTo = (p: { x: number; y: number; z: number }, label: string) =>
		teach(async () => {
			await api(`/api/opentrons-lab/robots/${robotId}/maintenance/${maintRunId}/move-to`, { method: 'POST', body: JSON.stringify({ pipetteId, x: p.x, y: p.y, z: p.z }) });
			teachInfo = `Moved to the ${label}.`;
			await refreshPosition();
		});

	/**
	 * Move to the taught cart location the way the fill arrives: tip-neutral point
	 * + THIS tip's probe adjust, 2 mm above the rim, via a high arc (the planner
	 * cannot see the stage). Needs a tip on: the point is the tip end on the rim.
	 */
	const moveToCart = () =>
		teach(async () => {
			const p = calibration?.cartLocation;
			if (!p) throw new Error('No cart location is taught.');
			if (!hasTip) throw new Error('Pick up a tip (and calibrate it) before moving to the cart location — it was taught with the tip end on the rim.');
			const ax = tipAdjust?.x ?? 0;
			const ay = tipAdjust?.y ?? 0;
			await api(`/api/opentrons-lab/robots/${robotId}/maintenance/${maintRunId}/move-to`, {
				method: 'POST',
				body: JSON.stringify({ pipetteId, x: p.x + ax, y: p.y + ay, z: p.z + 2, minimumZHeight: TEACH_ARC_Z, forceDirect: false })
			});
			teachInfo = `2 mm above the taught first wax hole${tipAdjust ? ` with this tip's adjust (${ax}, ${ay}) applied` : ' — tip NOT probed, so expect it off by this tip\'s bend'}.`;
			await refreshPosition();
		});

	/** Load the p20 rack in slot 11 and press a tip at the cursor's well; the server's cursor answer wins. */
	async function doPickUpTip(allowRecover = true): Promise<void> {
		const r = await apiRaw(`/api/opentrons-lab/robots/${robotId}/maintenance/${maintRunId}/pick-up-tip`, {
			method: 'POST',
			body: JSON.stringify({ pipetteId, tiprackLoadName: data.teach?.tiprackLoadName, slot: '11', tipWell })
		});
		if (r.ok) {
			if (r.body?.nextTipWell) tipWell = r.body.nextTipWell;
			hasTip = true;
			tipAdjust = null;
			return;
		}
		if (r.status === 409 && r.body?.code === 'TIP_ALREADY_ATTACHED' && allowRecover) {
			// The run still models a tip (one swapped by hand, say): trash it, then press again.
			await api(`/api/opentrons-lab/robots/${robotId}/maintenance/${maintRunId}/drop-tip`, { method: 'POST', body: JSON.stringify({ pipetteId }) });
			return doPickUpTip(false);
		}
		throw new Error(r.body?.message ?? (typeof r.body === 'string' ? r.body : `pick-up-tip HTTP ${r.status}`));
	}

	/**
	 * Pick up a p20 tip and probe it on the tip calibrator — the same sequence the
	 * Deck Calibration Studio runs before a hole is captured. The probe runs over
	 * the queue line (/api/scanner/calibrate-tip, attached to this maintenance run
	 * so the tip stays on) and its adjust is what makes the saved cart location
	 * tip-neutral. Travels to the calibrator's approach point first, as the Studio does.
	 */
	async function pickUpAndCalibrateTip() {
		if (!maintRunId || !pipetteId) {
			teachError = 'Open a maintenance run first.';
			return;
		}
		const cal = data.teach?.calibrator;
		if (!cal) {
			teachError = 'No tip-calibrator point is known for this robot — teach it in the Deck Calibration Studio first.';
			return;
		}
		if (pipetteMount !== 'left' && pipetteMount !== 'right') {
			teachError = 'The maintenance run reported no pipette mount — reopen it.';
			return;
		}
		teachError = null;
		teachBusy = true;
		calibrating = true;
		try {
			if (!hasTip) {
				teachInfo = `Picking up a tip (${data.teach?.tiprackLoadName} ${tipWell})…`;
				await doPickUpTip();
			}
			teachInfo = `Moving to the tip calibrator (${cal.x}, ${cal.y}, ${cal.approachZ})…`;
			await api(`/api/opentrons-lab/robots/${robotId}/maintenance/${maintRunId}/move-to`, {
				method: 'POST',
				body: JSON.stringify({ pipetteId, x: cal.x, y: cal.y, z: cal.approachZ, minimumZHeight: TEACH_ARC_Z, forceDirect: false })
			});
			teachInfo = 'Probing the tip on the calibrator (slow limit-switch probe, 1–2 min)…';
			const res = await api('/api/scanner/calibrate-tip', {
				method: 'POST',
				body: JSON.stringify({ robotId, mount: pipetteMount, tipProfile: 'wax', tipWell, runId: maintRunId, pipetteId })
			});
			if (res?.adjust && typeof res.adjust.x === 'number' && typeof res.adjust.y === 'number') {
				tipAdjust = { x: res.adjust.x, y: res.adjust.y };
				teachInfo = `Tip calibrated: adjust x=${tipAdjust.x} y=${tipAdjust.y}. Now jog the tip end onto the rim of the cart's first wax hole and save.`;
			} else {
				teachError = typeof res?.error === 'string' && res.error ? res.error : 'The probe returned no adjust — nothing taught. Calibrate again before saving.';
			}
			await refreshPosition();
		} catch (e) {
			teachError = e instanceof Error ? e.message : String(e);
		} finally {
			teachBusy = false;
			calibrating = false;
		}
	}

	const dropTip = () =>
		teach(async () => {
			await api(`/api/opentrons-lab/robots/${robotId}/maintenance/${maintRunId}/drop-tip`, { method: 'POST', body: JSON.stringify({ pipetteId }) });
			hasTip = false;
			tipAdjust = null;
			teachInfo = 'Tip dropped in the trash.';
			await refreshPosition();
		});

	async function fireTestScan() {
		testScanError = null;
		testScanLatest = null;
		testScanInFlight = true;
		try {
			const res = await api('/api/scanner/trigger', { method: 'POST', body: JSON.stringify({ deviceId: data.scannerDeviceId, source: 'test', contextRef: 'arm-wax-fill:teach' }) });
			const triggerId = res?.triggerId;
			const started = Date.now();
			while (Date.now() - started < 15000) {
				await sleep(400);
				const url = new URL('/api/scanner/events', window.location.origin);
				url.searchParams.set('deviceId', data.scannerDeviceId);
				url.searchParams.set('limit', '20');
				const r = await fetch(url, { credentials: 'same-origin' });
				if (!r.ok) continue;
				const evs: any[] = (await r.json())?.events ?? [];
				const match = evs.find((e) => e?.metadata?.triggerId === triggerId);
				if (match) {
					if (match.eventType === 'scan' && match.barcode) testScanLatest = match.barcode;
					else testScanError = match.errorMessage || 'scanner returned error';
					return;
				}
			}
			testScanError = 'Timed out waiting for the scanner (15 s).';
		} catch (e) {
			testScanError = e instanceof Error ? e.message : String(e);
		} finally {
			testScanInFlight = false;
		}
	}

	async function savePoint(which: 'saveScanPosition' | 'saveCartLocation') {
		await teach(async () => {
			// Frames must match how each point is used: the sweep runs with no tip (a
			// point taught with one would park the scanner a tip length lower); the fill
			// runs with a probed tip and adds its adjust to the saved, tip-neutral point.
			if (which === 'saveScanPosition' && hasTip) throw new Error('Drop the tip before saving the scan position — the scanner sweep runs without one.');
			if (which === 'saveCartLocation' && (!hasTip || !tipAdjust)) throw new Error('Pick up a tip and calibrate it first — the cart location is saved tip-neutral (live − that tip\'s probe adjust).');
			await refreshPosition();
			if (liveX === null || liveY === null || liveZ === null) throw new Error('Could not read the position from the robot.');
			const r = await post(which, {
				x: String(liveX),
				y: String(liveY),
				z: String(liveZ),
				pipetteMount: pipetteMount ?? '',
				pipetteName: pipetteName ?? '',
				...(which === 'saveScanPosition' && testScanLatest ? { testScanBarcode: testScanLatest } : {}),
				...(which === 'saveCartLocation' && tipAdjust ? { hasTip: 'true', adjustX: String(tipAdjust.x), adjustY: String(tipAdjust.y), tipWell } : {})
			});
			if (!r.ok) throw new Error(r.error);
			calibration = r.data.calibration;
			teachInfo = `${r.data.success} x=${liveX.toFixed(2)} y=${liveY.toFixed(2)} z=${liveZ.toFixed(2)}`;
			await invalidateAll();
		});
	}

	const dis = $derived(!maintRunId || !pipetteId || teachBusy);
	const btn = 'rounded border border-[var(--color-tron-border)] px-3 py-3 text-sm hover:border-[var(--color-tron-cyan)] disabled:opacity-40';

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
					<button type="button" onclick={goToCalibration} disabled={!robotId || loop?.status === 'running'}
						title={loop?.status === 'running' ? 'Not while a loop is running' : "Open the calibration for this robot's wax-fill protocol: scan position, tip-neutral cart location, tip calibrator"}
						class="{ctl} border-[var(--color-tron-cyan)]/60 bg-[var(--color-tron-cyan)]/10 text-[var(--color-tron-cyan)] hover:bg-[var(--color-tron-cyan)]/20">
						Calibrate wax fill
					</button>
					<button type="button" onclick={identify} disabled={!robotId || robotBusy !== null} title="Blink the rail lights to find this robot" class={ctlPlain}>
						{robotBusy === 'identify' ? 'Blinking…' : 'Identify'}
					</button>
					<button type="button" onclick={toggleLights} disabled={!robotId || robotBusy !== null} title="Toggle the rail lights"
						class="{ctl} {lightsOn ? 'border-[var(--color-tron-cyan)]/60 bg-[var(--color-tron-cyan)]/10 text-[var(--color-tron-cyan)]' : 'border-[var(--color-tron-border)] text-[var(--color-tron-text-secondary)] hover:border-[var(--color-tron-cyan)] hover:text-[var(--color-tron-text)]'}">
						{lightsOn === null ? 'Lights' : lightsOn ? 'Lights on' : 'Lights off'}
					</button>
					<button type="button" onclick={homeGantry} disabled={!robotId || robotBusy !== null || loop?.status === 'running' || !!maintRunId}
						title={loop?.status === 'running' ? 'Not while a loop is running' : maintRunId ? 'Use Home in the teach panel while its maintenance run is open' : 'Home all axes'} class={ctlPlain}>
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
						<label class="block">
							<span style="color: var(--color-tron-text-secondary)">Cart rotation on the stage (°)</span>
							<input name="stageRotationDeg" type="number" step="0.5" min="-360" max="360" value={data.settings.stageRotationDeg}
								class="mt-1 w-full rounded border border-[var(--color-tron-border)] bg-black/30 px-2 py-1.5 font-mono" style="color: var(--color-tron-text)" />
							<span class="mt-1 block text-[10px]" style="color: var(--color-tron-text-secondary)">Counter-clockwise from above, about the first wax hole. 0 = as in a carriage slot (gates toward −x, rows toward −y); 180 = turned end for end.</span>
						</label>
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

	<!-- ── Calibration ───────────────────────────────────────────────── -->
	<section id="wax-fill-calibration" class="scroll-mt-4 rounded-lg border border-[var(--color-tron-border)] bg-[var(--color-tron-surface)] p-4 space-y-3">
		<div class="flex flex-wrap items-center justify-between gap-2">
			<div>
				<h3 class="text-sm font-bold uppercase tracking-wider" style="color: var(--color-tron-text-secondary)">Calibration{#if data.robotName} · {data.robotName}{/if}{#if data.protocol} · <span class="font-mono normal-case tracking-normal">{data.protocol.protocolName}</span>{/if}</h3>
				<p class="mt-1 text-[11px]" style="color: var(--color-tron-text-secondary)">
					Two taught points on this OT-2, from a maintenance run: the <span class="font-semibold">scan position</span> with no tip on (the sweep runs without one),
					and the <span class="font-semibold">cart location</span> with a probed tip on — it is saved tip-neutral (live − that tip's calibrator adjust), the Deck
					Calibration Studio's convention, so every fill lands with its own tip's adjust applied.
				</p>
			</div>
			<div class="flex items-center gap-2">
				{#if robotId}<TransportPill state={robotConn} onRetry={() => void robotSession?.retryDirect()} />{/if}
				<a href={studioCalibratorHref} class="rounded border border-[var(--color-tron-border)] px-3 py-1 text-xs hover:border-[var(--color-tron-cyan)]" style="color: var(--color-tron-text)"
					title="This robot's tip-calibrator point (approach XY, probe Z) in the Deck Calibration Studio — what the stage protocol's probe and the teach probe here both use">
					Tip calibrator (Studio)
				</a>
				<button type="button" onclick={() => (teaching = !teaching)} disabled={!robotId || loop?.status === 'running'}
					class="rounded border border-[var(--color-tron-border)] px-3 py-1 text-xs hover:border-[var(--color-tron-cyan)] disabled:opacity-40" style="color: var(--color-tron-text)">
					{teaching ? 'Close teach panel' : 'Teach'}
				</button>
			</div>
		</div>

		<div class="grid grid-cols-1 gap-3 md:grid-cols-2 text-xs">
			<div class="rounded border border-[var(--color-tron-border)] bg-black/30 p-3">
				<div class="font-semibold" style="color: var(--color-tron-text)">Scan position</div>
				<div class="mt-1 font-mono" style="color: var(--color-tron-cyan)">{fmt(calibration?.scanPosition ?? null)}</div>
				<div class="mt-1 text-[11px]" style="color: var(--color-tron-text-secondary)">
					Where the gantry scanner reads the cart the arm placed.
					{#if calibration?.scanPosition?.taughtAt}Taught {when(calibration.scanPosition.taughtAt)}{calibration.scanPosition.taughtBy ? ` by ${calibration.scanPosition.taughtBy}` : ''}.{/if}
					{#if calibration?.scanPosition?.testScanBarcode}Test read: <span class="font-mono">{calibration.scanPosition.testScanBarcode}</span>.{/if}
				</div>
			</div>
			<div class="rounded border border-[var(--color-tron-border)] bg-black/30 p-3">
				<div class="font-semibold" style="color: var(--color-tron-text)">Cart location</div>
				<div class="mt-1 font-mono" style="color: var(--color-tron-cyan)">{fmt(calibration?.cartLocation ?? null)}</div>
				<div class="mt-1 text-[11px]" style="color: var(--color-tron-text-secondary)">
					The rim of the cart's first wax hole (row 1, gate 4) on the stage, tip-neutral. Sent to the stage protocol as arm_cart_x/y/z.
					{#if calibration?.cartLocation?.taughtAt}Taught {when(calibration.cartLocation.taughtAt)}{calibration.cartLocation.taughtBy ? ` by ${calibration.cartLocation.taughtBy}` : ''}.{/if}
					{#if calibration?.cartLocation?.tipAdjust}
						Probe adjust at teach <span class="font-mono">{calibration.cartLocation.tipAdjust.x}, {calibration.cartLocation.tipAdjust.y}</span>{calibration.cartLocation.tipWell ? ` (tip ${calibration.cartLocation.tipWell})` : ''}.
					{:else if calibration?.cartLocation}
						<span class="text-amber-300">Taught without a probed tip — teach it again (pick up a tip, calibrate, save) before a stage fill.</span>
					{/if}
				</div>
			</div>
		</div>

		{#if teaching && robotId}
			<div class="rounded-lg border border-[var(--color-tron-cyan)]/30 bg-[var(--color-tron-surface)]/40 p-4 space-y-4">
				{#if teachError}<div class="rounded border border-red-500/40 bg-red-900/20 p-2 text-xs text-red-300">{teachError}</div>{/if}
				{#if teachInfo}<div class="rounded border border-green-500/30 bg-green-900/15 p-2 text-xs text-green-300">{teachInfo}</div>{/if}

				<div class="flex flex-wrap items-center justify-between gap-3">
					<div class="text-xs" style="color: var(--color-tron-text-secondary)">
						{#if maintRunId}
							Maintenance run <span class="font-mono">{maintRunId}</span>{#if pipetteName} · {pipetteName} ({pipetteMount}){/if}
							· <span class={hasTip ? 'text-green-300' : ''}>{hasTip ? (tipAdjust ? `tip on, probed (${tipAdjust.x}, ${tipAdjust.y})` : 'tip on, NOT probed') : 'no tip'}</span>
						{:else}No maintenance run open.{/if}
					</div>
					<div class="flex gap-2">
						{#if !maintRunId}
							<button type="button" onclick={openMaintenance} disabled={connecting}
								class="rounded border border-[var(--color-tron-cyan)] bg-[var(--color-tron-cyan)]/15 px-4 py-2 text-sm font-bold text-[var(--color-tron-cyan)] hover:bg-[var(--color-tron-cyan)]/25 disabled:opacity-40">
								{connecting ? 'Opening…' : 'Open maintenance run'}
							</button>
						{:else}
							<button type="button" onclick={home} disabled={teachBusy} class="rounded border border-[var(--color-tron-border)] px-4 py-2 text-sm hover:border-[var(--color-tron-cyan)] disabled:opacity-40" style="color: var(--color-tron-text)">Home</button>
							<button type="button" onclick={closeMaintenance} disabled={teachBusy} class="rounded border border-amber-500/40 bg-amber-900/15 px-4 py-2 text-sm text-amber-300 hover:bg-amber-900/25 disabled:opacity-40">Close run</button>
						{/if}
					</div>
				</div>

				<div class="grid grid-cols-1 gap-4 lg:grid-cols-3">
					<div class="space-y-3 lg:col-span-2">
						<div class="flex flex-wrap items-center gap-3 text-xs" style="color: var(--color-tron-text-secondary)">
							<label class="flex items-center gap-2">Step
								<select bind:value={stepSize} class="rounded border border-[var(--color-tron-border)] bg-black/30 px-2 py-1 font-mono" style="color: var(--color-tron-text)">
									<option value={0.1}>0.1 mm</option><option value={1}>1 mm</option><option value={5}>5 mm</option><option value={10}>10 mm</option><option value={25}>25 mm</option>
								</select>
							</label>
							<label class="flex items-center gap-2">Z axis
								<select bind:value={zAxis} class="rounded border border-[var(--color-tron-border)] bg-black/30 px-2 py-1 font-mono" style="color: var(--color-tron-text)">
									<option value="leftZ">leftZ</option><option value="rightZ">rightZ</option>
								</select>
							</label>
						</div>
						<div class="grid grid-cols-3 gap-2">
							<div></div>
							<button type="button" disabled={dis} onclick={() => jog('y', stepSize)} class={btn} style="color: var(--color-tron-text)">Y +</button>
							<div></div>
							<button type="button" disabled={dis} onclick={() => jog('x', -stepSize)} class={btn} style="color: var(--color-tron-text)">X −</button>
							<div class="flex items-center justify-center text-[10px]" style="color: var(--color-tron-text-secondary)">deck XY</div>
							<button type="button" disabled={dis} onclick={() => jog('x', stepSize)} class={btn} style="color: var(--color-tron-text)">X +</button>
							<div></div>
							<button type="button" disabled={dis} onclick={() => jog('y', -stepSize)} class={btn} style="color: var(--color-tron-text)">Y −</button>
							<div></div>
						</div>
						<div class="grid grid-cols-2 gap-2">
							<button type="button" disabled={dis} onclick={() => jog(zAxis, stepSize)} class={btn} style="color: var(--color-tron-text)">Z + (up)</button>
							<button type="button" disabled={dis} onclick={() => jog(zAxis, -stepSize)} class={btn} style="color: var(--color-tron-text)">Z − (down)</button>
						</div>
						<div class="rounded border border-[var(--color-tron-border)] bg-black/30 p-3">
							<div class="flex items-center justify-between">
								<span class="text-xs font-bold uppercase tracking-wider" style="color: var(--color-tron-text-secondary)">Live position</span>
								<button type="button" onclick={() => void teach(refreshPosition)} disabled={dis} class="text-[11px] underline disabled:opacity-40" style="color: var(--color-tron-cyan)">Refresh</button>
							</div>
							<div class="mt-2 grid grid-cols-3 gap-2 font-mono text-sm" style="color: var(--color-tron-text)">
								<span>x: {liveX !== null ? liveX.toFixed(2) : '—'}</span><span>y: {liveY !== null ? liveY.toFixed(2) : '—'}</span><span>z: {liveZ !== null ? liveZ.toFixed(2) : '—'}</span>
							</div>
						</div>
					</div>

					<div class="space-y-3">
						<div class="rounded border border-[var(--color-tron-cyan)]/40 bg-[var(--color-tron-cyan)]/5 p-3 space-y-2">
							<div class="flex items-center justify-between">
								<span class="text-xs font-bold uppercase tracking-wider" style="color: var(--color-tron-text-secondary)">Scan position</span>
								<button type="button" onclick={fireTestScan} disabled={testScanInFlight}
									class="rounded border border-[var(--color-tron-cyan)] px-2 py-1 text-[11px] font-bold text-[var(--color-tron-cyan)] disabled:opacity-40">{testScanInFlight ? 'Reading…' : 'Test scan'}</button>
							</div>
							{#if testScanLatest}<div class="break-all rounded bg-black/40 p-2 font-mono text-xs" style="color: var(--color-tron-cyan)">{testScanLatest}</div>
							{:else if testScanError}<p class="text-[11px] text-red-300">{testScanError}</p>
							{:else}<p class="text-[11px]" style="color: var(--color-tron-text-secondary)">Fires the gantry scanner where it is now ({data.scannerDeviceId}). Save with no tip on.</p>{/if}
							<div class="flex gap-2">
								<button type="button" onclick={() => void savePoint('saveScanPosition')} disabled={dis || hasTip} title={hasTip ? 'Drop the tip first — the sweep runs without one' : ''}
									class="flex-1 rounded bg-[var(--color-tron-cyan)] px-3 py-2 text-xs font-semibold text-white hover:bg-[var(--color-tron-cyan)]/80 disabled:opacity-40">Save here as scan position</button>
								{#if calibration?.scanPosition}
									<button type="button" onclick={() => void moveTo(calibration!.scanPosition!, 'scan position')} disabled={dis}
										class="rounded border border-[var(--color-tron-border)] px-3 py-2 text-xs disabled:opacity-40" style="color: var(--color-tron-text)">Move to</button>
								{/if}
							</div>
						</div>
						<div class="rounded border border-[var(--color-tron-cyan)]/40 bg-[var(--color-tron-cyan)]/5 p-3 space-y-2">
							<div class="flex items-center justify-between">
								<span class="text-xs font-bold uppercase tracking-wider" style="color: var(--color-tron-text-secondary)">Cart location</span>
								<span class="font-mono text-[10px] {hasTip && tipAdjust ? 'text-green-300' : ''}" style={hasTip && tipAdjust ? '' : 'color: var(--color-tron-text-secondary)'}>
									{hasTip ? (tipAdjust ? `probed ${tipAdjust.x}, ${tipAdjust.y}` : 'tip on · not probed') : 'no tip'}
								</span>
							</div>
							<p class="text-[11px]" style="color: var(--color-tron-text-secondary)">
								1. Pick up + calibrate a tip. 2. Jog the tip end onto the rim of the cart's <span class="font-semibold">first wax hole</span> (row 1, gate 4 — the hole a full deck
								calls X2; the other 11 follow from it, 6 mm per gate and 9 mm per row, turned by the cart rotation in Setup). 3. Save — stored tip-neutral (live − adjust).
							</p>
							{#if data.teach?.calibrator}
								<p class="text-[10px]" style="color: var(--color-tron-text-secondary)">Calibrator ({data.teach.calibrator.source}): x {data.teach.calibrator.x} · y {data.teach.calibrator.y} · approach z {data.teach.calibrator.approachZ} · probe z {data.teach.calibrator.probeZ}. Next tip {tipWell} from {data.teach.tiprackLoadName} in slot 11.</p>
							{:else}
								<p class="text-[10px] text-amber-300">No tip-calibrator point for this robot — teach it in the Deck Calibration Studio before calibrating a tip here.</p>
							{/if}
							<div class="flex gap-2">
								<button type="button" onclick={() => void pickUpAndCalibrateTip()} disabled={dis || calibrating || !data.teach?.calibrator}
									class="flex-1 rounded border border-purple-400/50 bg-purple-900/20 px-3 py-2 text-xs font-bold text-purple-200 hover:bg-purple-900/30 disabled:opacity-40"
									title="Picks up a p20 tip from slot 11, travels to the tip calibrator and runs the slow limit-switch probe. Keeps the tip on.">
									{calibrating ? 'Calibrating…' : hasTip ? 'Re-probe this tip' : `Pick up tip (${tipWell}) + calibrate`}
								</button>
								<button type="button" onclick={() => void dropTip()} disabled={dis || !hasTip}
									class="rounded border border-amber-500/40 bg-amber-900/15 px-3 py-2 text-xs text-amber-300 hover:bg-amber-900/25 disabled:opacity-40">Drop tip</button>
							</div>
							<div class="flex gap-2">
								<button type="button" onclick={() => void savePoint('saveCartLocation')} disabled={dis || !hasTip || !tipAdjust}
									title={!hasTip || !tipAdjust ? 'Pick up and calibrate a tip first — the point is saved tip-neutral' : ''}
									class="flex-1 rounded bg-[var(--color-tron-cyan)] px-3 py-2 text-xs font-semibold text-white hover:bg-[var(--color-tron-cyan)]/80 disabled:opacity-40">Save here as cart location</button>
								{#if calibration?.cartLocation}
									<button type="button" onclick={() => void moveToCart()} disabled={dis || !hasTip}
										title={hasTip ? '2 mm above the taught rim, with this tip\'s adjust applied' : 'Pick up a tip first — the point is the tip end on the rim'}
										class="rounded border border-[var(--color-tron-border)] px-3 py-2 text-xs disabled:opacity-40" style="color: var(--color-tron-text)">Move to</button>
								{/if}
							</div>
						</div>
					</div>
				</div>
			</div>
		{/if}
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
