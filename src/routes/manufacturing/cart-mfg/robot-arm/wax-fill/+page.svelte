<script lang="ts">
	/**
	 * Robot Arm — Wax fill (ARM-WAX-LOOP-B). ONE OT-2 run serves the loop: the
	 * protocol homes, takes ONE tip, probes it once, aspirates and parks the tip
	 * in the wax tube (the wax stays warm), pausing `ARM PARKED <i>`. Per cart:
	 * grab (arm, while the OT-2 is parked) → scan (the run goes to the scan
	 * position, the daemon reads the scanner) → decide (cart on the wax run, or
	 * the fail route) → fill (the protocol, back to the tube, re-aspirate, park)
	 * → withdraw (arm, while parked; on the last cart the run trashes its tip
	 * and homes meanwhile). This page is the driver: each step is a page action
	 * whose result lands on the ArmWaxFillRun before the next one starts, so a
	 * reload shows where the cycle is and Resume carries on. The waits are
	 * bounded server actions called until they report done.
	 *
	 * The rule (2026-10-29): the OT-2 and the arm may move at the same time as
	 * long as the OT-2 is not at the calibrator and not over the stage. The arm
	 * plays only while the robot reports the PARKED pause; the run leaves the
	 * tube only after the arm's play has settled.
	 *
	 * The fail route: a scan that fails (nothing read, or the cart is not a
	 * backed cart) sends `skip` (the gantry back to the tube), the arm plays the
	 * FAIL animation once the run is parked, and the loop ends failed.
	 */
	import { onDestroy, onMount } from 'svelte';
	import { enhance, deserialize } from '$app/forms';
	import { invalidateAll } from '$app/navigation';
	import { Playback } from '$lib/robot-arm/playback.svelte';
	import { ReturnHome, savedVisionCamera } from '$lib/robot-arm/return-home.svelte';
	import { HOME_LOOP_MS } from '$lib/robot-arm/home-calibration';
	import { openRobotSession } from '$lib/opentrons/direct-client';
	import { restartServerOverBridge } from '$lib/opentrons/fill-bridge-jobs';
	import type { RobotHealth } from '$lib/server/opentrons/health';
	import EmbeddedRunController from '$lib/components/manufacturing/EmbeddedRunController.svelte';
	import type { LoopView, LoopCycleView, CalibrationView } from '$lib/server/arm-wax-fill';

	let { data, form } = $props();

	const STEP_LABEL: Record<string, string> = {
		grab: 'Grab',
		scan: 'Scan',
		decide: 'Check',
		fill: 'Fill',
		withdraw: 'Withdraw',
		done: 'Done',
		fail: 'Fail animation',
		failed: 'Failed',
		stopped: 'Stopped'
	};
	const STEPS = ['grab', 'scan', 'decide', 'fill', 'withdraw'] as const;

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
	let changingAnimations = $state(false);

	const currentCycle = $derived<LoopCycleView | null>(loop ? (loop.cycles[loop.cycles.length - 1] ?? null) : null);
	const robotId = $derived(data.settings.robotId);
	const anim = $derived(data.settings);
	// The robot runs the stage protocol (Wax_Filling_GEN7_ArmStage.py: fills the taught,
	// tip-neutral cart location, loads no deck) rather than the legacy carriage protocol.
	const stage = $derived(!!data.protocol?.declaresCartLocation);
	// The p300 / air REHEARSAL of the stage fill is on the robot: every station, nothing dispensed.
	const rehearsal = $derived(!!data.protocol?.rehearsal);

	// ── Protocol on the robot (Setup): the production stage fill or the rehearsal, from the library ──
	let deployLibraryId = $state('');
	let deploying = $state(false);
	let deployMsg = $state<{ text: string; ok: boolean } | null>(null);
	// Add a stage .py to the protocol LIBRARY (the /opentrons page uploads straight to a
	// robot and never files the .py; the picker and the run-start re-sync read the library).
	let libraryFile = $state<File | null>(null);
	let addingToLibrary = $state(false);
	async function addToLibrary() {
		if (!libraryFile || addingToLibrary) return;
		addingToLibrary = true;
		deployMsg = null;
		try {
			// The page's own action: files the .py as THE library row for that file name
			// and archives older copies, so the picker never offers a stale twin.
			const fd = new FormData();
			fd.set('file', libraryFile);
			const res = await fetch('?/addToLibrary', { method: 'POST', body: fd, headers: { 'x-sveltekit-action': 'true' } });
			const r = deserialize(await res.text());
			if (r.type === 'success') {
				deployMsg = { text: String((r.data as any)?.success ?? 'Added to the library.'), ok: true };
				deployLibraryId = String((r.data as any)?.libraryId ?? '');
				note(deployMsg.text);
			} else if (r.type === 'failure') {
				deployMsg = { text: `Could not add ${libraryFile.name} to the library: ${String((r.data as any)?.error ?? 'failed')}`, ok: false };
			} else {
				deployMsg = { text: `Could not add ${libraryFile.name} to the library: ${r.type === 'error' ? (r.error?.message ?? 'error') : 'unexpected response'}`, ok: false };
			}
			libraryFile = null;
			await invalidateAll();
		} catch (e) {
			deployMsg = { text: e instanceof Error ? e.message : String(e), ok: false };
		} finally {
			addingToLibrary = false;
		}
	}

	async function deployProtocol() {
		if (!deployLibraryId || deploying) return;
		deploying = true;
		deployMsg = null;
		const r = await post('deployProtocol', { libraryId: deployLibraryId });
		deploying = false;
		if (r.ok) {
			deployMsg = { text: String(r.data.success ?? 'Deployed.'), ok: true };
			note(deployMsg.text);
			deployLibraryId = '';
			await invalidateAll();
		} else {
			deployMsg = { text: r.error, ok: false };
			note(`Deploy failed: ${r.error}`, 'error');
		}
	}
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
	function playStep(action: 'cycleGrab' | 'cycleWithdraw' | 'cycleFail', title: string): Promise<{ ok: boolean; error?: string }> {
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

	// ── the OT-2 run (one per loop; EmbeddedRunController only watches it) ─
	/** The robot's own run status, for the log; the server-side waits decide what it means. */
	function onRunStatus(status: string) {
		if (status === 'succeeded' || status === 'failed' || status === 'stopped') note(`OT-2 run ended ${status}.`, status === 'succeeded' ? 'info' : 'warn');
	}

	/**
	 * After `end` (the loop completed, stopped or failed): the server waits
	 * (bounded) for the run to finish — tip to the trash, home — and records its
	 * end on the wax run. Called until it reports done.
	 */
	async function finishRun() {
		for (let i = 0; i < 40; i++) {
			if (!loop || loop.runFinished || !loop.ending) return;
			const r = await post('loopFinish', { loopId: loop._id });
			if (!r.ok) {
				note(`Recording the OT-2 run's end: ${r.error}`, 'error');
				return;
			}
			loop = r.data.loop;
			if (r.data.done) {
				note(`OT-2 run finished ${r.data.status ?? ''}${loop!.error ? ` — ${loop!.error}` : ''}.`, r.data.status === 'succeeded' ? 'info' : 'warn');
				return;
			}
			note('Waiting for the OT-2 to trash its tip and home…');
		}
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
				const loopId = loop._id;
				const tag = `Cycle ${cycle.index}/${loop.requestedRuns}`;
				if (cycle.step === 'grab') {
					if (stopAsked) break;
					// The run must be parked (tip in the wax tube) for this cart before the arm swings in;
					// the server refuses cycleGrab otherwise.
					note(cycle.index === 1 ? `${tag}: waiting for the OT-2 to home, take its tip and calibrate it — the grab starts the moment it announces ARM CALIBRATED, while it aspirates and parks.` : `${tag}: the OT-2 is clear of the stage — grab.`);
					let parked = false;
					let broke = false;
					while (!parked) {
						const w = await post('awaitParked', { loopId: loopId });
						if (stopAsked) {
							await refreshLoop();
							broke = true;
							break;
						}
						if (!w.ok) {
							await fail('grab', `the OT-2 did not report parked: ${w.error}`);
							broke = true;
							break;
						}
						loop = w.data.loop;
						if (loop!.status !== 'running') {
							broke = true;
							break;
						}
						parked = !!w.data.done;
						if (!parked) note(`${tag}: still waiting for the OT-2 to park…`);
					}
					if (broke) break;
					note(`${tag}: OT-2 parked — grab — playing "${loop?.grabAnimation?.name ?? ''}".`);
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
					const r = await post('cycleGrabDone', { loopId: loopId });
					if (!r.ok) {
						await fail('grab', r.error);
						break;
					}
					loop = r.data.loop;
				} else if (cycle.step === 'scan') {
					if (stopAsked) break;
					if (!cycle.scanSeq) {
						// The scan sends the gantry over the stage: the run must be parked first
						// (on cycle 1 its start-up may still be finishing under the grab).
						let parkedForScan = false;
						let scanBroke = false;
						while (!parkedForScan) {
							const w = await post('awaitParked', { loopId: loopId });
							if (stopAsked) {
								await refreshLoop();
								scanBroke = true;
								break;
							}
							if (!w.ok) {
								await fail('scan', `the OT-2 did not report parked: ${w.error}`);
								scanBroke = true;
								break;
							}
							loop = w.data.loop;
							if (loop!.status !== 'running') {
								scanBroke = true;
								break;
							}
							parkedForScan = !!w.data.done;
							if (!parkedForScan) note(`${tag}: waiting for the OT-2 to finish its start-up and park before the scan…`);
						}
						if (scanBroke) break;
						note(`${tag}: sending the OT-2 to the scan position.`);
						const s = await post('cycleScanStart', { loopId: loopId });
						if (!s.ok) {
							await fail('scan', s.error);
							break;
						}
						loop = s.data.loop;
					}
					let pending = true;
					let broke = false;
					while (pending) {
						const r = await post('cycleScanRead', { loopId: loopId });
						if (!r.ok) {
							await fail('scan', r.error);
							broke = true;
							break;
						}
						loop = r.data.loop;
						pending = !!r.data.pending;
						if (pending) note(`${tag}: waiting for the OT-2 to reach the scan position…`);
					}
					if (broke || loop!.status !== 'running') break;
					const after = loop!.cycles[loop!.cycles.length - 1];
					if (after?.step === 'fail') note(`${tag}: ${after.error ?? 'the scan failed.'} Taking the fail route.`, 'warn');
					else if (after?.barcode) note(`${tag}: read ${after.barcode}.`);
				} else if (cycle.step === 'decide') {
					note(`${tag}: ${rehearsal ? 'cart checked' : `cart ${cycle.barcode} goes on the wax run`} — telling the OT-2 to fill.`);
					const r = await post('cycleDecide', { loopId: loopId });
					if (!r.ok) {
						await fail('decide', r.error);
						break;
					}
					loop = r.data.loop;
					const after = loop!.cycles[loop!.cycles.length - 1];
					if (after?.step === 'fail') note(`${tag}: ${after.error ?? 'the cart cannot be filled.'} Taking the fail route.`, 'warn');
				} else if (cycle.step === 'fill') {
					note(`${tag}: the OT-2 is filling ${cycle.barcode ?? 'the cart'}${rehearsal ? ' (rehearsal: air)' : ''} — waiting for it to park in the wax again.`);
					let pending = true;
					let broke = false;
					while (pending) {
						const r = await post('cycleFillWait', { loopId: loopId });
						if (!r.ok) {
							await fail('fill', r.error);
							broke = true;
							break;
						}
						loop = r.data.loop;
						pending = !!r.data.pending;
					}
					if (broke || loop!.status !== 'running') break;
					note(`${tag}: filled — the OT-2 is parked in the wax.`);
				} else if (cycle.step === 'withdraw') {
					const last = loop.completedRuns + 1 >= loop.requestedRuns || loop.stopRequested;
					note(`${tag}: withdraw — playing "${loop.withdrawAnimation?.name ?? ''}"${last ? ' (last cart: the OT-2 trashes its tip and homes meanwhile)' : ''}.`);
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
					const r = await post('cycleWithdrawDone', { loopId: loopId });
					if (!r.ok) {
						await fail('withdraw', r.error);
						break;
					}
					loop = r.data.loop;
					note(r.data.next ? `${tag} done — ${loop!.completedRuns} of ${loop!.requestedRuns} filled.` : `Loop ${loop!.status}: ${loop!.completedRuns} of ${loop!.requestedRuns} filled.`);
				} else if (cycle.step === 'fail') {
					// The fail route: skip (the gantry back to the tube), the fail animation once parked, the loop ends failed.
					if (!cycle.skipSeq) note(`${tag}: fail route — sending the OT-2 back to the wax tube first.`);
					let pending = true;
					let broke = false;
					while (pending) {
						const r = await post('cycleFailPrepare', { loopId: loopId });
						if (!r.ok) {
							await fail('fail', `${r.error} — the cart is still on the stage`);
							broke = true;
							break;
						}
						loop = r.data.loop;
						pending = !!r.data.pending;
						if (pending) note(`${tag}: waiting for the OT-2 to park…`);
					}
					if (broke || loop!.status !== 'running') break;
					note(`${tag}: OT-2 parked — fail animation — playing "${loop?.failAnimation?.name ?? ''}".`);
					const p = await playStep('cycleFail', `Fail animation (cycle ${cycle.index})`);
					if (stopAsked) {
						await refreshLoop();
						if (loop?.status !== 'running') break;
					}
					if (!p.ok) {
						await fail('fail', `${p.error ?? 'play failed'} — the cart may still be on the stage`);
						break;
					}
					const r = await post('cycleFailDone', { loopId: loopId });
					if (!r.ok) {
						await fail('fail', r.error);
						break;
					}
					loop = r.data.loop;
					note(`Loop stopped: ${STEP_LABEL[cycle.failedStep ?? 'scan']?.toLowerCase() ?? cycle.failedStep} failed on cycle ${cycle.index}, the fail animation played — ${loop!.completedRuns} of ${loop!.requestedRuns} filled.`, 'error');
				} else {
					await refreshLoop();
					break;
				}
			}
			// However the loop ended, `end` went out (or could not): record the run's end.
			if (loop && loop.ending && !loop.runFinished) await finishRun();
			else if (loop && loop.status !== 'running' && loop.opentronsRunId && !loop.runFinished && !loop.ending) {
				note('The OT-2 run is still on the robot (parked or at the scan position) — press STOP RUN, or Reset, to end it.', 'warn');
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
			if (r.data.endSent) note('The OT-2 was told to end: it trashes its tip and homes.', 'warn');
			if (r.data.note) note(String(r.data.note), 'error');
			if (loop!.status !== 'running' && !driving) void finishRun();
		} finally {
			busy = false;
		}
	}

	// ── STOP RUN: halt now, then everything home ─────────────────────────
	// Unlike Stop (which lets the fill and withdraw finish), Stop run halts
	// where things stand: the arm's play is stopped, the OT-2 run (fill or
	// scan sweep) is stopped and the loop ends. Then, in this order — the arm
	// never moves until the OT-2 confirms it is home — the OT-2 homes every
	// axis and the arm runs the same Return to home the ARM CONNECTION card
	// drives (open the mouth, servo 2 home, every joint home, close the claw).
	type HaltPhase = 'halting' | 'letting_go' | 'ot2' | 'arm' | 'done' | 'error';
	let halt = $state<{ phase: HaltPhase; error: string | null; ot2Homed: boolean } | null>(null);
	const returnHome = new ReturnHome();
	let haltCamera: string | null = null;

	const STOP_RUN_CONFIRM =
		'STOP RUN — halt everything now and return to home?\n\n' +
		'• The arm stops where it is (torque stays on, it holds).\n' +
		'• The OT-2 run is stopped: a cart being filled is left part-filled and goes back to backed; a scan in progress is cancelled. The pipette keeps its tip.\n' +
		'• Then the OT-2 homes every axis, and only after it confirms home the arm runs Return to home — it OPENS THE MOUTH first, so a cart in the claw is released where the arm stands, then every joint goes home and the claw closes.\n\n' +
		'The loop ends stopped. Is the path clear?';

	const sleepMs = (ms: number) => new Promise((r) => setTimeout(r, ms));

	async function stopRun() {
		if (!loop || busy || halt?.phase === 'halting' || halt?.phase === 'ot2' || halt?.phase === 'arm') return;
		if (!confirm(STOP_RUN_CONFIRM)) return;
		halt = { phase: 'halting', error: null, ot2Homed: false };
		returnHome.reset();
		busy = true;
		stopAsked = true;
		try {
			const r = await post('haltLoop', { loopId: loop._id });
			if (!r.ok) {
				halt = { phase: 'error', error: `Stop run failed: ${r.error}`, ot2Homed: false };
				note(`Stop run failed: ${r.error}`, 'error');
				if (!driving) stopAsked = false;
				return;
			}
			loop = r.data.loop;
			if (r.data.stoppedArm) note(r.data.torqueOn ? 'STOP RUN — the arm was stopped and is holding its position.' : 'STOP RUN — the arm was stopped, but torque could NOT be re-enabled; it may be limp.', r.data.torqueOn ? 'warn' : 'error');
			else note('STOP RUN — the loop ended where it stood.', 'warn');
			for (const n of r.data.robotNotes ?? []) note(`OT-2: ${n}.`, 'warn');
		} finally {
			busy = false;
		}
		// Let the step in progress see the stopped loop and let go (the fill's
		// controller reports the stopped run; the scan poll and the play poll end
		// within a second); carry on regardless after a while.
		halt = { phase: 'letting_go', error: null, ot2Homed: false };
		for (let i = 0; i < 40 && driving; i++) await sleepMs(500);
		await homeAfterHalt();
	}

	/** The home half of Stop run: OT-2 first, then the arm. Retryable on its own after a refusal. */
	async function homeAfterHalt() {
		if (!loop || returnHome.running) return;
		halt = { phase: 'ot2', error: null, ot2Homed: false };
		note('Homing the OT-2 (every axis) — the arm waits for the robot to confirm.');
		const h = await post('haltHomeGantry', { loopId: loop._id });
		if (!h.ok) {
			halt = { phase: 'error', error: `${h.error} The arm was NOT moved.`, ot2Homed: false };
			note(`OT-2 home refused: ${h.error} The arm was NOT moved — fix the robot, then "Try again", or use Return to home on the ARM CONNECTION card once the OT-2 is home.`, 'error');
			return;
		}
		for (const n of h.data?.notes ?? []) note(`OT-2: ${n}.`, 'warn');
		note(`OT-2 home confirmed${h.data?.waitedMs > 2000 ? ` (waited ${Math.round(h.data.waitedMs / 1000)} s for its run to stop)` : ''} — the arm returns home.`);
		halt = { phase: 'arm', error: null, ot2Homed: true };
		haltCamera = savedVisionCamera();
		await returnHome.run(haltCamera);
		const l = returnHome.loop;
		if (l?.error) {
			halt = { phase: 'error', error: l.error, ot2Homed: true };
			note(`Arm Return to home: ${l.error}`, 'error');
		} else {
			halt = { phase: 'done', error: null, ot2Homed: true };
			note(`Arm Return to home finished after ${l?.attempt ?? 0} attempt(s): ${l?.outcome ?? 'done'}. ${l?.clawClosed ? 'Claw closed.' : `Claw NOT confirmed closed${l?.clawError ? `: ${l.clawError}` : '.'}`}`, l?.clawClosed ? 'warn' : 'error');
		}
	}

	const haltStatus = $derived.by(() => {
		if (!halt) return null;
		const rl = returnHome.loop;
		switch (halt.phase) {
			case 'halting':
				return 'Stop run: stopping the arm and the OT-2…';
			case 'letting_go':
				return 'Stop run: waiting for the step in progress to let go…';
			case 'ot2':
				return 'Stop run: homing the OT-2 (every axis) — the arm waits for the robot to confirm…';
			case 'arm':
				if (rl?.closing) return 'Stop run: arm home — closing the claw (final step)…';
				return `Stop run: arm returning home — attempt ${rl?.attempt ?? 0} · ${Math.round(((returnHome.now - (rl?.startedAt ?? returnHome.now)) / 1000))} s of ${HOME_LOOP_MS / 1000} s${rl?.stopping ? ' · stopping after this jog, then closing the mouth…' : ''}`;
			case 'done':
				return `Stop run complete: OT-2 home, arm home (${rl?.outcome ?? 'done'}), ${rl?.clawClosed ? 'claw closed' : 'claw NOT confirmed closed'}.`;
			case 'error':
				return halt.error ?? 'Stop run failed.';
		}
	});
	const haltBusy = $derived(halt?.phase === 'halting' || halt?.phase === 'letting_go' || halt?.phase === 'ot2' || halt?.phase === 'arm');

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
	const TILE_NEUTRAL = 'border-[var(--color-tron-border)] text-[var(--color-tron-text-secondary)]';
	const TILE_DONE = 'border-green-500/40 bg-green-900/15 text-green-300';
	const TILE_CURRENT = 'border-[var(--color-tron-cyan)] bg-[var(--color-tron-cyan)]/15 text-[var(--color-tron-cyan)]';
	const TILE_FAILED = 'border-red-500/50 bg-red-900/20 text-red-300';
	/** The cycle took (or is on) the fail route: a fifth tile shows the fail animation. */
	const onFailRoute = (cycle: LoopCycleView | null) => !!cycle && (cycle.step === 'fail' || !!cycle.failedStep);
	const stepClass = (cycle: LoopCycleView | null, step: string) => {
		if (!cycle) return TILE_NEUTRAL;
		const i = STEPS.indexOf(step as (typeof STEPS)[number]);
		if (onFailRoute(cycle)) {
			// Steps before the one that failed went fine; that one is red; the rest never ran.
			const f = STEPS.indexOf((cycle.failedStep ?? '') as (typeof STEPS)[number]);
			if (f >= 0 && i < f) return TILE_DONE;
			if (i === f) return TILE_FAILED;
			return TILE_NEUTRAL;
		}
		const cur = STEPS.indexOf(cycle.step as (typeof STEPS)[number]);
		if (cycle.step === 'done' || (cur > i && cur >= 0)) return TILE_DONE;
		if (cur === i) return TILE_CURRENT;
		if (cycle.step === 'failed' || cycle.step === 'stopped') return 'border-red-500/30 text-red-300/70';
		return TILE_NEUTRAL;
	};
	/** The fail-animation tile: playing (cyan), played (amber), or the route itself failed before it played (red). */
	const failTileClass = (cycle: LoopCycleView | null) => {
		if (cycle?.step === 'fail') return TILE_CURRENT;
		if (cycle?.failArmRunId) return 'border-amber-500/50 bg-amber-900/15 text-amber-300';
		if (cycle?.step === 'failed') return TILE_FAILED;
		return TILE_NEUTRAL;
	};
</script>

<div class="space-y-4">
	<div>
		<h2 class="text-lg font-bold" style="color: var(--color-tron-cyan)">Wax fill</h2>
		<p class="mt-1 text-xs" style="color: var(--color-tron-text-secondary)">
			One OT-2 run and one tip serve the whole loop: the robot homes, takes its tip, probes it once, aspirates and parks the tip in the wax (it stays warm) between carts.
			Per cart: <span class="font-semibold">grab</span> (arm, while the OT-2 is parked) → <span class="font-semibold">scan</span> (the run goes to the taught scan position, the scanner is read) →
			<span class="font-semibold">check</span> → <span class="font-semibold">fill</span>
			{#if stage}at the taught cart location{:else}with the robot's carriage protocol{/if}{#if rehearsal}
			<span class="font-semibold text-amber-300">— REHEARSAL: the p300 walks it with 200 µL tips and air, nothing is dispensed</span>{/if}
			→ <span class="font-semibold">withdraw</span> (arm, while parked), for as many carts as you ask; on the last cart the OT-2 trashes its tip and homes while the arm withdraws.
			If the scan fails — nothing read, or the cart is not a backed cart — the OT-2 goes back to the tube and the <span class="font-semibold">fail animation</span> plays instead of the fill; the loop stops.
			The arm moves only while the robot reports it is parked in the wax; it never moves while the OT-2 is at the calibrator or over the stage.
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
					<button type="button" onclick={stop} disabled={busy || haltBusy || loop.stopRequested}
						title="Lets the cart being filled finish and the arm withdraw it, then ends the loop"
						class="rounded border border-red-500/50 bg-red-900/15 px-4 py-2 text-sm font-bold text-red-300 hover:bg-red-900/25 disabled:opacity-40">
						{loop.stopRequested ? 'Stopping after this cart…' : 'Stop after this cart'}
					</button>
					<button type="button" onclick={stopRun} disabled={busy || haltBusy}
						title="Halts NOW: stops the arm and the OT-2 run where they are, then homes the OT-2 and runs the arm's Return to home"
						class="rounded border border-red-500 bg-red-600 px-4 py-2 text-sm font-bold text-white hover:bg-red-500 disabled:opacity-40">
						{haltBusy ? 'Stopping…' : 'STOP RUN'}
					</button>
				</div>
			{:else if haltBusy}
				<span class="text-xs font-semibold text-amber-300">Stop run in progress…</span>
			{:else}
				<form class="flex items-center gap-2" onsubmit={(e) => { e.preventDefault(); void start(); }}>
					<label class="flex items-center gap-2 text-xs" style="color: var(--color-tron-text-secondary)">
						Runs
						<input type="number" min="1" max="500" bind:value={runs}
							class="w-20 rounded border border-[var(--color-tron-border)] bg-black/30 px-2 py-1.5 font-mono text-sm" style="color: var(--color-tron-text)" />
					</label>
					<button type="submit" disabled={busy || haltBusy || data.readiness.blocking.length > 0}
						class="rounded-lg bg-[var(--color-tron-cyan)] px-5 py-2 text-sm font-semibold text-white hover:bg-[var(--color-tron-cyan)]/80 disabled:opacity-40">
						{busy ? 'Starting…' : `Start ${runs} ${rehearsal ? 'rehearsal ' : ''}run${runs === 1 ? '' : 's'}`}
					</button>
				</form>
			{/if}
		</div>

		{#if haltStatus}
			<div class="flex flex-wrap items-center gap-2 rounded border p-2 text-xs
				{halt?.phase === 'error' ? 'border-red-500/60 bg-red-900/20 text-red-200' : halt?.phase === 'done' ? 'border-green-500/40 bg-green-900/15 text-green-200' : 'border-amber-500/50 bg-amber-900/15 text-amber-200'}">
				<span class="grow">{haltStatus}</span>
				{#if halt?.phase === 'arm' && returnHome.loop?.running}
					<button type="button" onclick={() => returnHome.stop(haltCamera)} disabled={returnHome.loop.stopping}
						title="Stops the arm within one jog, then closes the mouth"
						class="rounded border border-red-500 bg-red-900/30 px-2 py-0.5 font-semibold text-red-200 disabled:opacity-40">
						Stop returning
					</button>
				{:else if halt?.phase === 'error' && loop && loop.status !== 'running'}
					<button type="button" onclick={() => void homeAfterHalt()}
						title={halt.ot2Homed ? 'Run the arm’s Return to home again (the OT-2 homes again first)' : 'Home the OT-2 again, then the arm'}
						class="rounded border border-amber-500 bg-amber-900/30 px-2 py-0.5 font-semibold text-amber-100">
						Try again
					</button>
				{/if}
				{#if returnHome.result?.frozen}
					<span class="basis-full rounded border border-red-500/60 bg-red-900/20 p-2 text-red-200">FROZEN — return the arm to home by hand. {returnHome.result.message}</span>
				{:else if halt && (halt.phase === 'done' || halt.phase === 'error') && returnHome.result}
					<span class="basis-full">{returnHome.result.message}</span>
				{/if}
			</div>
		{/if}

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
				<div class="grid gap-2 {onFailRoute(currentCycle) ? 'grid-cols-6' : 'grid-cols-5'}">
					{#each STEPS as s (s)}
						<div class="rounded border px-2 py-2 text-center text-xs font-semibold {stepClass(currentCycle, s)}">{STEP_LABEL[s]}</div>
					{/each}
					{#if onFailRoute(currentCycle)}
						<div class="rounded border px-2 py-2 text-center text-xs font-semibold {failTileClass(currentCycle)}" title={currentCycle?.error ?? ''}>{STEP_LABEL.fail}</div>
					{/if}
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

				{#if loop.opentronsRunId && !loop.runFinished}
					<!-- The loop's one run, for the whole loop. Watch only: its ARM pauses are the loop's to resume, never the controller's auto-resume. -->
					<EmbeddedRunController robotId={loop.robot._id} robotName={loop.robot.name} opentronsRunId={loop.opentronsRunId} autoResumeInitial={false} onStatusChange={onRunStatus} />
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
										<td class="pr-2">{STEP_LABEL[c.step] ?? c.step}{#if c.failedStep} <span class="opacity-60">(fail route after {STEP_LABEL[c.failedStep]?.toLowerCase() ?? c.failedStep}{c.failArmRunId ? ', fail animation played' : ''})</span>{/if}</td>
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
							{#if data.protocol.rehearsal}<span class="font-bold text-amber-300">· REHEARSAL</span>{/if}
						{:else if data.settings.robotId}
							<span class="text-amber-300">No wax-filling protocol on this robot.</span>
						{/if}
					</span>
					<button type="submit" class="rounded border border-[var(--color-tron-cyan)] bg-[var(--color-tron-cyan)]/15 px-4 py-1.5 text-xs font-bold text-[var(--color-tron-cyan)] hover:bg-[var(--color-tron-cyan)]/25">Save setup</button>
				</div>
			</form>

			<!-- Protocol on the robot: the production stage fill or the p300 rehearsal, from the library -->
			{#if data.settings.robotId}
				<div class="mt-4 border-t border-[var(--color-tron-border)] pt-3 text-xs">
					<div class="flex items-center justify-between gap-2">
						<span class="font-bold uppercase tracking-wider" style="color: var(--color-tron-text-secondary)">Protocol on the robot</span>
						{#if data.protocol?.rehearsal}
							<span class="rounded border border-amber-500/50 bg-amber-900/20 px-2 py-0.5 text-[10px] font-bold uppercase text-amber-300">Rehearsal · p300 · air · no wax</span>
						{:else if data.protocol?.declaresCartLocation}
							<span class="rounded border border-green-500/40 bg-green-900/15 px-2 py-0.5 text-[10px] font-bold uppercase text-green-300">Production stage fill</span>
						{/if}
					</div>
					<p class="mt-1 text-[11px]" style="color: var(--color-tron-text-secondary)">
						{#if data.protocol}
							<span class="font-mono" style="color: var(--color-tron-text)">{data.protocol.protocolName}</span> —
							{#if data.protocol.rehearsal}the p300 walks every station of the stage fill with 200 µL tips and air; nothing is dispensed. Real carts and barcodes are fine: the scanned cart is only checked (a backed cart passes, anything else takes the fail route) and no cart record changes.
							{:else if data.protocol.declaresCartLocation}the stage protocol: fills the taught cart location (arm_cart_x/y/z).
							{:else}the carriage protocol: fills the deck position; arm_cart_x/y/z not declared.{/if}
						{:else}
							<span class="text-amber-300">No wax-filling protocol on this robot yet.</span>
						{/if}
					</p>
					<div class="mt-2 flex items-center gap-2">
						<select bind:value={deployLibraryId} disabled={deploying || loop?.status === 'running'}
							class="min-w-0 flex-1 rounded border border-[var(--color-tron-border)] bg-black/30 px-2 py-1.5 disabled:opacity-40" style="color: var(--color-tron-text)">
							<option value="">— choose a stage protocol from the library —</option>
							{#each data.protocolOptions as o (o.libraryId)}
								<option value={o.libraryId}>
									{o.protocolName}{o.rehearsal ? ' · REHEARSAL (p300, air)' : ' · production fill'} · file {o.fileHash8}{o.addedAt ? ` added ${new Date(o.addedAt).toLocaleString()}` : ''}{o.onRobot ? ' · on the robot now' : o.lastDeployedAt ? ` · last deployed ${new Date(o.lastDeployedAt).toLocaleDateString()}` : ' · never deployed here'}
								</option>
							{/each}
						</select>
						<button type="button" onclick={() => void deployProtocol()} disabled={!deployLibraryId || deploying || loop?.status === 'running'}
							class="rounded border border-[var(--color-tron-cyan)] bg-[var(--color-tron-cyan)]/15 px-4 py-1.5 text-xs font-bold text-[var(--color-tron-cyan)] hover:bg-[var(--color-tron-cyan)]/25 disabled:opacity-40">
							{deploying ? 'Deploying…' : 'Deploy to robot'}
						</button>
					</div>
					{#if data.protocolOptions.length === 0}
						<p class="mt-1 text-[11px] text-amber-300">No stage protocol in the library yet. The /opentrons page uploads straight to a robot and does not file the .py; add it here instead.</p>
					{/if}
					<div class="mt-2 flex flex-wrap items-center gap-2">
						<label class="flex min-w-0 flex-1 items-center gap-2 text-[11px]" style="color: var(--color-tron-text-secondary)">
							<span class="shrink-0">Add a stage .py to the library</span>
							<input type="file" accept=".py" disabled={addingToLibrary}
								onchange={(e) => (libraryFile = (e.currentTarget as HTMLInputElement).files?.[0] ?? null)}
								class="min-w-0 flex-1 text-[11px] file:mr-2 file:rounded file:border file:border-[var(--color-tron-border)] file:bg-black/30 file:px-2 file:py-1 file:text-[11px] file:text-[var(--color-tron-text)]" />
						</label>
						<button type="button" onclick={() => void addToLibrary()} disabled={!libraryFile || addingToLibrary}
							class="rounded border border-[var(--color-tron-border)] px-3 py-1 text-[11px] hover:border-[var(--color-tron-cyan)] disabled:opacity-40" style="color: var(--color-tron-text)">
							{addingToLibrary ? 'Adding…' : 'Add to library'}
						</button>
					</div>
					{#if deployMsg}
						<p class="mt-1 text-[11px] {deployMsg.ok ? 'text-green-300' : 'text-red-300'}">{deployMsg.text}</p>
					{/if}
					<p class="mt-1 text-[10px]" style="color: var(--color-tron-text-secondary)">
						Uploads the stored .py with the BIMS labware it loads, waits for the robot's analysis (up to about two minutes), then makes it this robot's wax-filling protocol. Not while a loop runs.
					</p>
				</div>
			{/if}
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
				The fail animation plays instead of the fill when the scan fails; it may be the withdraw animation or its own.
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
					<label class="block">
						<span style="color: var(--color-tron-text-secondary)">Fail — plays instead of the fill when the scan fails (nothing read, or the cart is not a backed cart); the run then stops</span>
						<select name="fail" required class="mt-1 w-full rounded border border-[var(--color-tron-border)] bg-black/30 px-2 py-1.5" style="color: var(--color-tron-text)">
							<option value="">— pick —</option>
							{#each animationOptions as o (o.value)}<option value={o.value} selected={o.value === animValue(anim.failAnimation)}>{o.label}</option>{/each}
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
					<dt style="color: var(--color-tron-text-secondary)">Fail</dt>
					<dd class="font-semibold" style="color: var(--color-tron-text)">{anim.failAnimation?.name ?? '— not chosen —'}{#if anim.failAnimation}<span class="ml-1 font-normal opacity-60">({anim.failAnimation.kind === 'sequence' ? 'sequence' : 'move set'}{anim.withdrawAnimation && animValue(anim.failAnimation) === animValue(anim.withdrawAnimation) ? ', same as withdraw' : ''})</span>{/if}</dd>
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
