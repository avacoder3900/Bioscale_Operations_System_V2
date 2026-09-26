<script lang="ts">
	import { page } from '$app/stores';
	import { invalidateAll } from '$app/navigation';
	import SetupConfirmation from '$lib/components/manufacturing/reagent-filling/SetupConfirmation.svelte';
	import ReagentPreparation from '$lib/components/manufacturing/reagent-filling/ReagentPreparation.svelte';
	import ReagentBatchScan from '$lib/components/manufacturing/reagent-filling/ReagentBatchScan.svelte';
	// ⚠️ MERGE NOTE: Jacob's branch builds the full Reagent Batch system (models, API routes, schema).
	// The ReagentBatchScan component and reagentBatchBarcode param passed to startRun are stubs.
	// When merging Jacob's branch, wire ReagentBatchScan to his API and update startRun to use his batch linkage.
	// DO NOT overwrite Jacob's reagent batch models or routes — this page is the UI consumer only.
	import DeckLoadingGrid from '$lib/components/manufacturing/reagent-filling/DeckLoadingGrid.svelte';
	import RunExecution from '$lib/components/manufacturing/reagent-filling/RunExecution.svelte';
	import ProtocolStartPanel from '$lib/components/manufacturing/ProtocolStartPanel.svelte';
	import EmbeddedRunController from '$lib/components/manufacturing/EmbeddedRunController.svelte';
	import { deserialize } from '$app/forms';
	import { RobotSession, type RobotSessionState } from '$lib/opentrons/direct-client';
	import {
		startRunTwoPhase,
		finishRunTwoPhase,
		stopRunTwoPhase,
		type ActionPoster,
		type StartStepId,
		type StartStepStatus
	} from '$lib/opentrons/ot2-protocol';
	// REAGENT-TOPSEAL-IMPLICIT: there is no post-OT-2 queue. Run completion ends
	// the run; top sealing is implicit; the next touch is the Reagent Inspect photo.

	let { data } = $props();

	let selectedAssayTypeId = $state('');
	let isResearchRun = $state(false);
	let errorMsg = $state('');
	let submitting = $state(false);
	let showCancelModal = $state(false);
	let cancelReason = $state('');
	let showResetModal = $state(false);

	// Inspection (and its holding-tray scan) moved off this page — see
	// REAGENT-INSPECT-AFTER-TOPSEAL. The run now ends at Run; top sealing is
	// implicit (REAGENT-TOPSEAL-IMPLICIT) and inspection happens on Reagent Inspect.

	// Admin override state
	let showOverrideModal = $state(false);
	let overrideUser = $state('');
	let overridePass = $state('');
	let overrideError = $state('');
	let pendingOverrideAction = $state('');
	let pendingOverrideData = $state<Record<string, string>>({});

	// Restore error message after hard reload
	$effect(() => {
		const stored = sessionStorage.getItem('reagent-error');
		if (stored) {
			errorMsg = stored;
			sessionStorage.removeItem('reagent-error');
		}
	});

	// Reagent-filling page owns Setup → Load → Run (3 stages). Completing the
	// run here finishes it (status Completed, carts reagent_filled); the carts
	// are top-sealed off-page and photographed on the Reagent Inspect page.
	const STAGES = ['Setup', 'Loading', 'Running'] as const;
	type Stage = (typeof STAGES)[number];

	// Optimistic stage: prevents UI flash when invalidateAll() returns stale/failed data
	const ACTION_NEXT_STAGE: Record<string, string> = {
		createRun: 'Loading',
		confirmSetup: 'Loading',
		recordReagentPrep: 'Loading',
		loadDeck: 'Loading',
		startRun: 'Running',
	};
	let pendingStage = $state<string | null>(null);

	// Reagent batch scan state. The batch is now selected BEFORE the deck scan, and
	// the deck scan reloads the page — so derive "confirmed" from the server (the
	// run's persisted tubeRecords) with a client override for the optimistic moment
	// right after scanning the batch but before the reload lands.
	let reagentBatchConfirmedLocal = $state(false);
	let reagentBatchBarcodeLocal = $state<string | null>(null);
	const reagentBatchConfirmed = $derived(reagentBatchConfirmedLocal || (data.reagentPrepDone ?? false));
	const reagentBatchBarcode = $derived(reagentBatchBarcodeLocal ?? data.reagentBatchBarcode ?? null);

	// Protocol params captured BEFORE barcode scanning (mirror wax). Set on the
	// setup/params step, then replayed to ?/startRun after reagent prep so the run
	// starts hands-off with those values. Client-only — a reload re-shows the step.
	let paramsReady = $state(false);
	let capturedParamsFd = $state<FormData | null>(null);
	/**
	 * Cartridge count from the captured protocol params (set BEFORE scanning).
	 * Passed to DeckLoadingGrid so the auto-sweep only walks that many
	 * positions on a partial fill — previously the sweep always walked all 24
	 * and spent a full scan-timeout on every empty slot. (After the scan,
	 * startRunWithCapturedParams still overwrites param_cartridges with the
	 * real scanned count, so the run itself is driven by what was scanned.)
	 */
	const plannedScanCount = $derived.by(() => {
		const raw = capturedParamsFd?.get('param_cartridges')?.toString();
		const n = raw ? Math.floor(Number(raw)) : NaN;
		return Number.isFinite(n) && n >= 1 && n <= 24 ? n : null;
	});
	// "Run again" stashes the prior run's params here so the fresh run skips the
	// param step and lands straight on barcode scanning (the per-run reset below
	// reapplies it instead of clearing).
	let lastParamsRunId = '';
	let runAgainParamsFd: FormData | null = null;
	$effect(() => {
		const rid = data.activeRunId ?? '';
		if (rid !== lastParamsRunId) {
			lastParamsRunId = rid;
			// New run → clear the optimistic batch overrides (server state drives it).
			reagentBatchConfirmedLocal = false;
			reagentBatchBarcodeLocal = null;
			if (runAgainParamsFd && rid) {
				capturedParamsFd = runAgainParamsFd;
				paramsReady = true;
				// Run-again skips the params panel, so persist the carried-over
				// count for the NEW run here (activeRunId is the new run now).
				persistPlannedCount(runAgainParamsFd);
				runAgainParamsFd = null;
			} else {
				paramsReady = false;
				capturedParamsFd = null;
			}
		}
	});

	// Run finished = the OT-2 .py reached a terminal status. Sourced from the
	// EmbeddedRunController completion callback (live) OR the server stamp
	// (survives reload). Gates the Complete + Run-again controls on Running.
	let runFinishedLocal = $state(false);
	const runFinished = $derived(runFinishedLocal || !!data.runState.opentronsRunFinalStatus);
	/**
	 * Terminal but not successful. The finish controls used to present a failed
	 * run exactly like a good one — green "batch completed", Done front and
	 * centre — and Done stamps every cartridge reagent_filled (2026-08-31).
	 */
	const runFailed = $derived(
		!!data.runState.opentronsRunFinalStatus &&
			!['succeeded', 'completed'].includes(String(data.runState.opentronsRunFinalStatus).toLowerCase())
	);

	// The robot's own status, reported by EmbeddedRunController. Used to hold the
	// run clock while the robot is paused — paused time isn't fill time.
	let robotStatus = $state<string | null>(null);

	/**
	 * Mid-run tip swap (2026-09-18, mirrors wax-filling). Sends a request to the
	 * on-robot bridge; the running reagent protocol picks it up before its next
	 * aspiration batch, swaps the tip (from the rack, or by hand), re-probes it and
	 * continues with that batch.
	 */
	let tipSwapStatus = $state<'' | 'sending' | 'rack' | 'hand' | 'cancelled' | 'error'>('');
	async function requestTipSwap(mode: 'rack' | 'hand' | 'cancel') {
		if (!data.activeRunId) return;
		tipSwapStatus = 'sending';
		try {
			const fd = new FormData();
			fd.set('runId', data.activeRunId);
			fd.set('mode', mode === 'cancel' ? 'rack' : mode);
			fd.set('cancel', mode === 'cancel' ? 'true' : 'false');
			const res = await fetch('?/requestTipSwap', {
				method: 'POST',
				body: fd,
				headers: { 'x-sveltekit-action': 'true' }
			});
			const json = await res.json();
			if (!res.ok || json?.type === 'failure') throw new Error(json?.data?.error ?? `HTTP ${res.status}`);
			tipSwapStatus = mode === 'cancel' ? 'cancelled' : mode;
		} catch (e) {
			console.error('[reagent] tip swap request failed', e);
			tipSwapStatus = 'error';
		}
	}

	/**
	 * Run-time parameters BIMS pre-selects for a reagent run, overriding the .py's
	 * own defaults. These seed the form; the operator can still change any of them.
	 *
	 * use_tip_calibration: the protocol declares it `default=False`, so operators
	 * were ticking it on before every single run — 59 of the last 60 reagent runs
	 * across all three robots had it on, the one exception being a cancelled run.
	 * Pre-selecting it matches what the line actually does. Deliberately NOT in
	 * contextReadonly: a flaky tip calibrator is a real failure mode, and turning
	 * this off is the documented workaround (it falls back to nominal well
	 * positions), so the operator has to keep that escape hatch.
	 *
	 * Kept as one frozen constant rather than an inline literal so the pre-scan
	 * panel gets a stable object identity: ProtocolStartPanel re-seeds the whole
	 * form whenever contextValues changes, which would wipe an operator's edits.
	 */
	const REAGENT_PARAM_DEFAULTS = Object.freeze({ use_tip_calibration: true });

	// "Run again": complete the just-finished run (→ Completed, robot freed),
	// then start a fresh run on the same robot reusing the same assay + protocol
	// params — landing on barcode scanning. Mirrors the wax flow.
	async function handleRunAgain() {
		if (previewParam || submitting || !data.activeRunId) return;
		const isResearch = data.runState.isResearch === true;
		const assayTypeId = data.runState.assayTypeId ?? '';
		// Preserve the params so the fresh run skips the param step (if captured).
		runAgainParamsFd = capturedParamsFd;
		runFinishedLocal = false;
		// 1) Complete the current run — robotReleasedAt frees the robot and the
		//    page load drops it as active (status → Completed).
		await submitForm('completeRunFilling');
		if (errorMsg) { runAgainParamsFd = null; return; }
		// 2) Create a fresh run on the same robot with the same assay.
		await submitForm('createRun', {
			assayTypeId: isResearch ? '' : assayTypeId,
			isResearch: isResearch ? 'true' : 'false'
		});
		// 3) The reset $effect picks up the new runId + runAgainParamsFd → sets
		//    paramsReady + capturedParamsFd → substage advances to barcode scan.
	}

	/**
	 * Persist the planned count server-side the moment params are confirmed, so
	 * the barcode sweep no longer depends on this tab keeping its state (a
	 * reload / second tab / fast Run-again lost capturedParamsFd and the sweep
	 * walked all 24 positions — seen 08-24 and again 08-27 on R04).
	 * Fire-and-forget: the client-side cap still works when this races.
	 */
	function persistPlannedCount(fd: FormData | null) {
		const raw = fd?.get('param_cartridges')?.toString();
		const n = raw ? Math.floor(Number(raw)) : NaN;
		if (!data.activeRunId || !Number.isFinite(n) || n < 1 || n > 24) return;
		const body = new FormData();
		body.set('runId', data.activeRunId);
		body.set('plannedCartridgeCount', String(n));
		fetch('?/savePlannedCount', {
			method: 'POST',
			body,
			headers: { 'x-sveltekit-action': 'true' }
		}).catch((e) => console.warn('[reagent] savePlannedCount failed', e));
	}

	function handleParamsConfirmed(fd: FormData) {
		capturedParamsFd = fd;
		paramsReady = true; // advance from params step to Barcode Scanning
		persistPlannedCount(fd);
	}

	async function startRunWithCapturedParams() {
		if (!capturedParamsFd || !data.activeRunId) return;
		capturedParamsFd.set('runId', data.activeRunId);
		capturedParamsFd.set('reagentBatchBarcode', reagentBatchBarcode ?? '');
		// Cartridge count is only known after the scan — inject the real count.
		capturedParamsFd.set('param_cartridges', String(data.cartridges.length));
		submitting = true;
		pendingStage = 'Running';
		if (lifecycleDirect) {
			try {
				const err = await startRunDirect(capturedParamsFd);
				if (err) {
					errorMsg = `Auto-start failed: ${err}`;
					pendingStage = null;
				}
				await invalidateAll();
				if (data.runState.hasActiveRun && data.runState.stage !== 'Loading') pendingStage = null;
			} catch (e) {
				errorMsg = e instanceof Error ? e.message : 'Run start failed';
				pendingStage = null;
			} finally {
				submitting = false;
			}
			return;
		}
		try {
			const res = await fetch('?/startRun', {
				method: 'POST',
				body: capturedParamsFd,
				headers: { 'x-sveltekit-action': 'true' }
			});
			const txt = await res.text();
			if (!res.ok || txt.includes('"type":"failure"')) {
				// Show the server's own reason (2026-08-28) — the generic message hid
				// actionable errors and made a failed auto-start look like a loop.
				let detail = '';
				try {
					const parsed = JSON.parse(txt);
					const raw = typeof parsed?.data === 'string' ? JSON.parse(parsed.data) : parsed?.data;
					const found = Array.isArray(raw) ? raw.find((v: unknown) => typeof v === 'string' && v.length > 3) : raw?.error;
					if (typeof found === 'string') detail = found;
				} catch { /* fall back to the generic message */ }
				errorMsg = detail
					? `Auto-start failed: ${detail}`
					: 'Auto-start with your parameters failed — start the run manually below.';
				pendingStage = null;
			}
			await invalidateAll();
			if (data.runState.hasActiveRun && data.runState.stage !== 'Loading') pendingStage = null;
		} catch (e) {
			errorMsg = e instanceof Error ? e.message : 'Run start failed';
			pendingStage = null;
		} finally {
			submitting = false;
		}
	}

	// Batch-note save — independent fetch (bypasses submitForm so the page doesn't
	// reload the stage on save). Writes the note to every cartridge on the run.
	// NOTE: only meaningful once cartridges are loaded; before the deck scan there
	// are none yet, so the note targets 0 cartridges (ReagentPreparation guards UX).
	async function handleSaveBatchNote(noteBody: string): Promise<{ ok: boolean; error?: string; cartridgeCount?: number }> {
		try {
			const formData = new FormData();
			formData.set('runId', data.activeRunId ?? '');
			formData.set('noteBody', noteBody);
			const res = await fetch('?/recordBatchNote', {
				method: 'POST',
				body: formData,
				headers: { 'x-sveltekit-action': 'true' }
			});
			const text = await res.text();
			if (!res.ok || text.includes('"type":"failure"')) {
				let err = `HTTP ${res.status}`;
				try {
					const json = JSON.parse(text);
					if (json.type === 'failure' && json.data) {
						const parsed = typeof json.data === 'string' ? JSON.parse(json.data) : json.data;
						if (Array.isArray(parsed)) {
							for (let i = 1; i < parsed.length; i++) {
								if (typeof parsed[i] === 'string' && parsed[i].length > 3) { err = parsed[i]; break; }
							}
						}
					}
				} catch { /* fallthrough with HTTP code */ }
				return { ok: false, error: err };
			}
			let cartridgeCount = data.cartridges.length;
			try {
				const json = JSON.parse(text);
				const parsed = typeof json.data === 'string' ? JSON.parse(json.data) : json.data;
				if (Array.isArray(parsed)) {
					const obj = parsed[0];
					if (obj && typeof obj === 'object' && 'cartridgeCount' in obj) {
						const idx = (obj as Record<string, number>).cartridgeCount;
						if (typeof idx === 'number' && parsed[idx] != null) cartridgeCount = Number(parsed[idx]);
					}
				}
			} catch { /* keep fallback count */ }
			return { ok: true, cartridgeCount };
		} catch (e) {
			return { ok: false, error: e instanceof Error ? e.message : 'Network error' };
		}
	}

	// Preview mode: ?preview shows all stages with clickable picker
	const previewParam = $derived($page.url.searchParams.has('preview'));
	let previewStage = $state<Stage>('Setup');

	const stage = $derived(pendingStage ?? (data.runState.hasActiveRun ? data.runState.stage : null));
	const currentStageIndex = $derived(
		stage ? STAGES.indexOf(stage as Stage) : -1
	);

	// eslint-disable-next-line svelte/prefer-writable-derived -- viewStageIndex is user-writable via arrow buttons
	let viewStageIndex = $state(-1);

	$effect(() => {
		viewStageIndex = currentStageIndex;
	});

	let viewStage = $derived(viewStageIndex >= 0 ? STAGES[viewStageIndex] : null);
	let isViewingPast = $derived(viewStageIndex >= 0 && viewStageIndex < currentStageIndex);
	let isViewingFuture = $derived(viewStageIndex >= 0 && viewStageIndex > currentStageIndex);

	// Skip-ahead override modal
	let showSkipModal = $state(false);
	let skipTargetIndex = $state(-1);

	// In preview mode, override the displayed stage
	const displayStage = $derived(previewParam ? previewStage : viewStage);
	const isPreviewOrPast = $derived(previewParam || isViewingPast);

	// Timeline bubbles (4): the Loading stage is split into "Barcode Scanning"
	// (deck + cartridge scan, cartridges===0) and "Reagent Prep" (cartridges>0).
	// Inspection moved off this page — the run ends at Run (then implicit top
	// seal → Reagent Inspect).
	const TIMELINE = ['Reagent Fill Setup', 'Barcode Scanning', 'Reagent Prep', 'Run'] as const;
	const currentBubbleIndex = $derived.by(() => {
		const s = stage;
		if (s === 'Loading') {
			// Before the deck scan: params step shows under "Reagent Fill Setup" (0),
			// then the deck+cart scan ("Barcode Scanning", 1); after scan = "Load" (2).
			if (data.cartridges.length === 0) return paramsReady ? 1 : 0;
			return 2;
		}
		if (s === 'Running') return 3;
		return 0; // Setup (or no run)
	});

	function stageLabel(s: string): string {
		switch (s) {
			case 'Setup': return '1. Setup';
			case 'Loading': return '2. Load';
			case 'Running': return '3. Run';
			case 'Inspection': return '4. Inspect';
			default: return s;
		}
	}

	function showError(msg: string) {
		errorMsg = msg;
		// Scroll error into view — it's at the top of the page
		requestAnimationFrame(() => {
			document.querySelector('[data-error-banner]')?.scrollIntoView({ behavior: 'smooth', block: 'center' });
		});
	}

	async function submitForm(action: string, extraData: Record<string, string> = {}) {
		if (submitting) return;
		if (previewParam) { showError('Actions disabled in preview mode'); return; }
		submitting = true;
		errorMsg = '';
		pendingOverrideAction = '';
		pendingOverrideData = {};
		try {
			const controller = new AbortController();
			const timeout = setTimeout(() => controller.abort(), 45000);

			const formData = new FormData();
			formData.set('runId', data.activeRunId ?? '');
			formData.set('robotId', data.robotId);
			for (const [key, value] of Object.entries(extraData)) {
				formData.set(key, value);
			}
			const res = await fetch(`?/${action}`, {
				method: 'POST',
				body: formData,
				headers: { 'x-sveltekit-action': 'true' },
				signal: controller.signal
			});
			clearTimeout(timeout);

			// Parse response — SvelteKit uses devalue serialization for action responses
			const text = await res.text();

			// Extract error from SvelteKit action response (handles both failure and HTTP errors)
			if (!res.ok || text.includes('"type":"failure"')) {
				let serverError = `Action failed (HTTP ${res.status})`;
				try {
					const json = JSON.parse(text);
					if (json.type === 'failure' && json.data != null) {
						// SvelteKit devalue format: data is [{"error":1},"actual error message"]
						if (typeof json.data === 'string') {
							const parsed = JSON.parse(json.data);
							if (Array.isArray(parsed)) {
								for (let i = 1; i < parsed.length; i++) {
									if (typeof parsed[i] === 'string' && parsed[i].length > 3) {
										serverError = parsed[i];
										break;
									}
								}
							}
						} else if (Array.isArray(json.data)) {
							for (let i = 1; i < json.data.length; i++) {
								if (typeof json.data[i] === 'string' && json.data[i].length > 3) {
									serverError = json.data[i];
									break;
								}
							}
						} else if (json.data?.error) {
							serverError = json.data.error;
						}
					}
				} catch {
					// Fallback: find readable strings in response
					const strings = text.match(/"([^"\\]{10,})"/g);
					if (strings) {
						const msg = strings[strings.length - 1].slice(1, -1);
						if (msg && !msg.includes('{')) serverError = msg;
					}
				}
				// Store failed loadDeck action for admin override
				if (action === 'loadDeck') {
					pendingOverrideAction = action;
					pendingOverrideData = extraData;
				}
				showError(serverError);
				submitting = false;
				return;
			}

			// recordRunFinished: the server finalizes the batch and frees the robot
			// the moment the .py succeeds. Skip the refresh — a reload here would
			// drop the (now Completed) run from page state and wipe the finished
			// panel before the operator sees it. Complete / Run again both remain
			// valid: they're idempotent against an already-Completed run.
			if (action === 'recordRunFinished') {
				submitting = false;
				return;
			}

			// Action succeeded — try client-side refresh first (fast on warm functions),
			// fall back to full page reload after 5s (handles cold starts).
			if (action in ACTION_NEXT_STAGE) {
				pendingStage = ACTION_NEXT_STAGE[action];
			}
			const reloadTimer = setTimeout(() => window.location.reload(), 5000);
			await invalidateAll();
			clearTimeout(reloadTimer);
			if (data.runState.hasActiveRun || ['completeRun', 'cancelRun', 'abortRun'].includes(action)) {
				pendingStage = null;
			}
		} catch (e) {
			if (e instanceof DOMException && e.name === 'AbortError') {
				showError('Request timed out — the server may be slow. Try again.');
			} else {
				showError(e instanceof Error ? e.message : 'Network error');
			}
		} finally {
			submitting = false;
		}
	}

	// ── OT2-TAILNET-5 §7.1: this page's robot line for the run lifecycle ──────
	// One RobotSession per page (shared with the embedded run controller). When
	// it is on the direct line, Start / Finish / Cancel / Abort run as server
	// prepare → the robot half over Tailscale → server confirm (the shared drivers
	// in $lib/opentrons/ot2-protocol). Otherwise the page calls the same single
	// ?/startRun, ?/recordRunFinished, ?/cancelRun, ?/abortRun actions as before.
	const lifecycleRobotId = $derived(previewParam ? '' : (data.opentronsRobotId ?? ''));
	let lifecycleSession = $state.raw<RobotSession | null>(null);
	let lifecycleConn = $state<RobotSessionState | null>(null);
	$effect(() => {
		const id = lifecycleRobotId;
		if (!id) return;
		const s = new RobotSession(id);
		lifecycleSession = s;
		const off = s.subscribe((st) => (lifecycleConn = st));
		void s.open();
		return () => {
			off();
			s.close();
			if (lifecycleSession === s) lifecycleSession = null;
		};
	});
	const lifecycleDirect = $derived(lifecycleConn?.transport === 'direct');

	/** A page form action as the drivers call it (fields in, data or error out). */
	const postLifecycleAction: ActionPoster = async (action, fields) => {
		const fd = new FormData();
		for (const [k, v] of Object.entries(fields)) fd.set(k, v);
		try {
			const res = await fetch(`?/${action}`, {
				method: 'POST',
				body: fd,
				headers: { 'x-sveltekit-action': 'true' },
				signal: AbortSignal.timeout(30_000)
			});
			const result = deserialize(await res.text());
			if (result.type === 'success') return { ok: true, data: result.data ?? {} };
			if (result.type === 'failure') return { ok: false, status: result.status, error: String((result.data as any)?.error ?? `Action failed (HTTP ${res.status})`) };
			if (result.type === 'error') return { ok: false, status: result.status ?? 500, error: result.error?.message ?? 'Action failed' };
			return { ok: false, status: res.status, error: `Action failed (HTTP ${res.status})` };
		} catch (e) {
			return { ok: false, status: 0, error: e instanceof Error ? e.message : 'Request failed' };
		}
	};

	/** The start checklist (PRD §8): each step says which line it ran on. */
	type StartUiStep = { id: 'checking' | 'uploading' | 'creating' | 'running'; label: string; status: 'pending' | 'active' | 'done' | 'failed' | 'skipped'; detail: string; line: string };
	let startSteps = $state<StartUiStep[]>([]);
	const lineLabel = () => (lifecycleSession?.state.transport === 'direct' ? 'via Tailscale' : 'via BIMS queue');
	function onStartStep(step: StartStepId, status: StartStepStatus, detail?: string) {
		// 'verifying' (the post-upload freshness proof) is part of the upload step.
		const id = step === 'verifying' ? 'uploading' : step;
		if (step === 'verifying' && status === 'skipped') return;
		startSteps = startSteps.map((s) =>
			s.id === id
				? { ...s, status, detail: detail ?? (step === 'verifying' && status === 'active' ? 'verifying the fresh upload…' : s.detail), line: lineLabel() }
				: s
		);
	}

	/** Start over the direct line. Resolves null on success, else the error to show. */
	async function startRunDirect(fd: FormData): Promise<string | null> {
		const session = lifecycleSession;
		if (!session) return 'Robot session is not open';
		startSteps = [
			{ id: 'checking', label: 'Checking protocol', status: 'pending', detail: '', line: '' },
			{ id: 'uploading', label: 'Uploading protocol (only if needed)', status: 'pending', detail: '', line: '' },
			{ id: 'creating', label: 'Creating run', status: 'pending', detail: '', line: '' },
			{ id: 'running', label: 'Running', status: 'pending', detail: '', line: '' }
		];
		const r = await startRunTwoPhase({ form: fd, post: postLifecycleAction, session, onStep: onStartStep });
		if (r.ok) {
			startSteps = [];
			return null;
		}
		return r.error;
	}

	/** Finish / cancel / abort over the direct line; same UI contract as submitForm. */
	async function lifecycleDirectAction(
		fn: () => Promise<{ ok: true; data: any } | { ok: false; error: string; status: number }>,
		refresh: boolean
	) {
		if (submitting) return;
		submitting = true;
		errorMsg = '';
		try {
			const r = await fn();
			if (!r.ok) showError(r.error);
			// (a stop `warning` is not surfaced — same as the queue line's submit)
			// Finish skips the refresh, exactly like submitForm('recordRunFinished').
			if (refresh && r.ok) {
				await invalidateAll();
				pendingStage = null;
			}
		} finally {
			submitting = false;
		}
	}

	function recordRunFinishedViaLine(status: string) {
		const rid = data.runState.opentronsRunId;
		const session = lifecycleSession;
		if (lifecycleDirect && session && rid && data.activeRunId) {
			const runId = data.activeRunId;
			return lifecycleDirectAction(() => finishRunTwoPhase({ runId, rid, finalStatus: status, post: postLifecycleAction, session }), false);
		}
		return submitForm('recordRunFinished', { runId: data.activeRunId ?? '', finalStatus: status });
	}

	function stopRunViaLine(action: 'cancel' | 'abort', fields: Record<string, string>) {
		const rid = data.runState.opentronsRunId ?? null;
		const session = lifecycleSession;
		if (lifecycleDirect && session && rid && data.activeRunId && !previewParam) {
			const runId = data.activeRunId;
			return lifecycleDirectAction(
				() => stopRunTwoPhase({ action, runId, rid, readFilledWells: false, fields: { ...fields, robotId: data.robotId }, post: postLifecycleAction, session }),
				true
			);
		}
		return submitForm(action === 'cancel' ? 'cancelRun' : 'abortRun', fields);
	}

	/** The ready-to-run panel's Start, on the direct line only (queue = its native form POST). */
	async function startFromPanelDirect(fd: FormData) {
		if (submitting || !data.activeRunId) return;
		fd.set('runId', data.activeRunId);
		submitting = true;
		errorMsg = '';
		pendingStage = 'Running';
		try {
			const err = await startRunDirect(fd);
			if (err) {
				showError(err);
				pendingStage = null;
			}
			await invalidateAll();
			if (data.runState.hasActiveRun && data.runState.stage !== 'Loading') pendingStage = null;
		} finally {
			submitting = false;
		}
	}

</script>

<div class="space-y-4">
	{#if previewParam}
		<!-- Preview mode stage picker -->
		<div class="rounded-lg border border-[var(--color-tron-orange)]/50 bg-[var(--color-tron-orange)]/10 p-3">
			<div class="mb-2 flex items-center justify-between">
				<span class="text-xs font-bold text-[var(--color-tron-orange)]">PREVIEW MODE</span>
				<a href="?" class="text-xs text-[var(--color-tron-text-secondary)] underline hover:text-[var(--color-tron-text)]">Exit Preview</a>
			</div>
			<div class="flex flex-wrap gap-2">
				<button type="button" onclick={() => { previewStage = 'Setup'; }}
					class="rounded px-3 py-1.5 text-xs font-medium transition-colors {previewStage === 'Setup' ? 'bg-[var(--color-tron-cyan)] text-white' : 'border border-[var(--color-tron-border)] text-[var(--color-tron-text-secondary)] hover:border-[var(--color-tron-cyan)] hover:text-[var(--color-tron-cyan)]'}">
					1. Setup
				</button>
				<button type="button" onclick={() => { previewStage = 'Loading'; }}
					class="rounded px-3 py-1.5 text-xs font-medium transition-colors {previewStage === 'Loading' ? 'bg-[var(--color-tron-cyan)] text-white' : 'border border-[var(--color-tron-border)] text-[var(--color-tron-text-secondary)] hover:border-[var(--color-tron-cyan)] hover:text-[var(--color-tron-cyan)]'}">
					2. Reagent Prep
				</button>
				<button type="button" onclick={() => { previewStage = 'Running'; }}
					class="rounded px-3 py-1.5 text-xs font-medium transition-colors {previewStage === 'Running' ? 'bg-[var(--color-tron-cyan)] text-white' : 'border border-[var(--color-tron-border)] text-[var(--color-tron-text-secondary)] hover:border-[var(--color-tron-cyan)] hover:text-[var(--color-tron-cyan)]'}">
					3. Running
				</button>
			</div>
		</div>
	{/if}

	{#if submitting}
		<div class="flex items-center gap-3 rounded border border-[var(--color-tron-cyan)]/50 bg-[var(--color-tron-cyan)]/10 px-4 py-3 text-sm text-[var(--color-tron-cyan)]">
			<svg class="h-4 w-4 animate-spin" viewBox="0 0 24 24" fill="none">
				<circle class="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" stroke-width="4"></circle>
				<path class="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z"></path>
			</svg>
			Processing...
		</div>
	{/if}

	{#if data.runState.startInterrupted}
		<div class="rounded border border-amber-500/40 bg-amber-900/20 px-4 py-3 text-sm text-amber-200">
			{data.runState.startInterrupted}
		</div>
	{/if}

	{#if startSteps.length > 0}
		<div class="space-y-2 rounded-lg border border-[var(--color-tron-border)] bg-[var(--color-tron-surface)] p-4">
			{#each startSteps as step (step.id)}
				<div class="flex items-start gap-3">
					<span class="mt-0.5 w-4 shrink-0 text-center text-sm font-bold {step.status === 'done' ? 'text-green-400' : step.status === 'failed' ? 'text-red-400' : step.status === 'active' ? 'text-[var(--color-tron-cyan)]' : 'text-[var(--color-tron-text-secondary)]'}">
						{step.status === 'done' ? '✓' : step.status === 'failed' ? '✗' : step.status === 'active' ? '…' : step.status === 'skipped' ? '–' : '·'}
					</span>
					<div class="min-w-0 flex-1 text-sm">
						<span class={step.status === 'failed' ? 'text-red-300' : 'text-[var(--color-tron-text)]'}>{step.label}</span>
						{#if step.status === 'skipped'}<span class="text-xs text-[var(--color-tron-text-secondary)]"> — not needed</span>{/if}
						{#if step.line}<span class="text-xs text-[var(--color-tron-text-secondary)]"> · {step.line}</span>{/if}
						{#if step.detail}<p class="text-xs {step.status === 'failed' ? 'text-red-400/80' : 'text-[var(--color-tron-text-secondary)]'}">{step.detail}</p>{/if}
					</div>
				</div>
			{/each}
		</div>
	{/if}

	{#if errorMsg}
		<div data-error-banner class="rounded border border-red-500/50 bg-red-900/20 px-4 py-3 text-sm text-red-300">
			<div class="flex items-center justify-between gap-2">
				<span>{errorMsg}</span>
				<div class="flex shrink-0 items-center gap-2">
					{#if pendingOverrideAction}
						<button
							type="button"
							onclick={() => { showOverrideModal = true; overrideError = ''; }}
							class="rounded border border-amber-500/50 bg-amber-900/20 px-3 py-1 text-xs font-medium text-amber-300 transition-colors hover:bg-amber-900/30"
						>
							Admin Override
						</button>
					{/if}
					<button type="button" onclick={() => { errorMsg = ''; pendingOverrideAction = ''; pendingOverrideData = {}; }} class="text-red-400 hover:text-red-200">&times;</button>
				</div>
			</div>
		</div>
	{/if}

	{#if !previewParam && data.robotBlocked}
		<!-- Robot blocked by other process -->
		<div class="rounded-lg border border-amber-500/50 bg-amber-900/20 p-6 text-center">
			<p class="text-base font-semibold text-amber-300">Robot Busy</p>
			<p class="mt-2 text-sm text-amber-300/80">
				This robot is currently running wax filling{data.robotBlocked.runId ? ` (${data.robotBlocked.runId})` : ''}.
				Complete or cancel the wax run before starting reagent filling.
			</p>
			<a href="/manufacturing/cart-mfg/wax-filling?robot={data.robotId}" class="mt-3 inline-block rounded border border-amber-500/50 px-4 py-2 text-sm text-amber-300 hover:bg-amber-900/30">
				Go to Wax Filling
			</a>
		</div>
	{:else if !previewParam && !stage}
		<!-- No active run — show create run UI -->
		<div class="space-y-4">
			<h2 class="text-lg font-semibold text-[var(--color-tron-text)]">New Reagent Filling Run</h2>
			<p class="text-sm text-[var(--color-tron-text-secondary)]">
				Select an assay type and confirm setup to begin.
			</p>
			<div class="flex items-center gap-2">
				<a href="?preview" class="rounded border border-[var(--color-tron-orange)]/50 px-3 py-1.5 text-xs text-[var(--color-tron-orange)] hover:bg-[var(--color-tron-orange)]/10">
					Preview All Stages
				</a>
			</div>
			<SetupConfirmation
				assayTypes={data.assayTypes}
				reagentNames={data.reagentDefinitions as any}
				{selectedAssayTypeId}
				onSelectAssayType={(id) => { selectedAssayTypeId = id; }}
				isResearch={isResearchRun}
				onSetResearch={(v) => {
					isResearchRun = v;
					if (v) selectedAssayTypeId = '';
				}}
				onComplete={() => submitForm('createRun', {
					assayTypeId: isResearchRun ? '' : selectedAssayTypeId,
					isResearch: isResearchRun ? 'true' : 'false'
				})}
			/>
		</div>

	{:else if !previewParam}
		<!-- Stage progress indicator with navigation arrows -->
		<div class="rounded-lg border border-[var(--color-tron-border)] bg-[var(--color-tron-surface)] p-4">
			<div class="mb-2 flex items-center justify-between">
				<span class="text-xs font-medium text-[var(--color-tron-text-secondary)]">
					Run {data.activeRunId}
				</span>
				<div class="flex items-center gap-3">
					<span class="text-xs text-[var(--color-tron-text-secondary)]">
						Stage {currentBubbleIndex + 1} of {TIMELINE.length}
					</span>
					<a href="?preview" class="rounded border border-[var(--color-tron-orange)]/40 px-2 py-0.5 text-xs text-[var(--color-tron-orange)] hover:bg-[var(--color-tron-orange)]/10">
						Preview
					</a>
					{#if stage === 'Loading' || stage === 'Running'}
						<button
							type="button"
							onclick={() => { showResetModal = true; }}
							class="rounded border border-amber-500/40 px-2 py-0.5 text-xs text-amber-400 transition-colors hover:border-amber-500 hover:bg-amber-900/20 hover:text-amber-300"
						>
							Reset to Deck Loading
						</button>
					{/if}
					<button
						type="button"
						onclick={() => { showCancelModal = true; }}
						class="rounded border border-red-500/40 px-2 py-0.5 text-xs text-red-400 transition-colors hover:border-red-500 hover:bg-red-900/20 hover:text-red-300"
					>
						Cancel Run
					</button>
				</div>
			</div>
			<div class="flex items-center gap-1">
				{#each TIMELINE as label, i (label)}
					{@const isCurrent = i === currentBubbleIndex}
					{@const isPast = i < currentBubbleIndex}
					<div class="flex flex-1 flex-col items-center gap-1">
						<div
							class="flex h-8 w-8 items-center justify-center rounded-full text-xs font-bold transition-colors {isCurrent
								? 'bg-[var(--color-tron-cyan)] text-white'
								: isPast
									? 'bg-green-600 text-white'
									: 'bg-[var(--color-tron-border)] text-[var(--color-tron-text-secondary)]'}"
						>
							{isPast ? '\u2713' : i + 1}
						</div>
						<span
							class="text-center text-[10px] font-medium {isCurrent
								? 'text-[var(--color-tron-cyan)]'
								: isPast
									? 'text-green-400'
									: 'text-[var(--color-tron-text-secondary)]'}"
						>
							{label}
						</span>
					</div>
					{#if i < TIMELINE.length - 1}
						<div
							class="mt-[-16px] h-0.5 flex-1 {isPast
								? 'bg-green-600'
								: 'bg-[var(--color-tron-border)]'}"
						></div>
					{/if}
				{/each}
			</div>
		</div>

		{#if isViewingPast}
			<button
				type="button"
				onclick={() => { viewStageIndex = currentStageIndex; }}
				class="flex w-full items-center justify-center gap-2 rounded-lg border border-[var(--color-tron-yellow)]/50 bg-[var(--color-tron-yellow)]/10 px-4 py-2 text-sm font-medium text-[var(--color-tron-yellow)] transition-colors hover:bg-[var(--color-tron-yellow)]/20"
			>
				<svg class="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2">
					<path stroke-linecap="round" stroke-linejoin="round" d="M13 9l3 3m0 0l-3 3m3-3H8m13 0a9 9 0 11-18 0 9 9 0 0118 0z" />
				</svg>
				Viewing past stage (read-only) — Click to return to current stage
			</button>
		{:else if isViewingFuture}
			<div class="flex w-full items-center justify-between gap-2 rounded-lg border border-amber-500/50 bg-amber-900/20 px-4 py-2">
				<span class="text-sm font-medium text-amber-300">
					Viewing future stage
				</span>
				<div class="flex items-center gap-2">
					<button
						type="button"
						onclick={() => { viewStageIndex = currentStageIndex; }}
						class="min-h-[36px] rounded border border-[var(--color-tron-border)] px-3 py-1.5 text-xs text-[var(--color-tron-text-secondary)] transition-colors hover:bg-[var(--color-tron-border)]/30"
					>
						Return
					</button>
					<button
						type="button"
						onclick={() => { skipTargetIndex = viewStageIndex; showSkipModal = true; }}
						disabled={submitting}
						class="min-h-[36px] rounded border border-amber-500/50 bg-amber-900/30 px-3 py-1.5 text-xs font-medium text-amber-300 transition-colors hover:bg-amber-900/40 disabled:opacity-50"
					>
						Skip to {stageLabel(STAGES[viewStageIndex])}
					</button>
				</div>
			</div>
		{/if}
	{/if}

	<!-- Stage content: works for both normal mode and preview mode -->
	{#if displayStage === 'Setup'}
		<SetupConfirmation
			assayTypes={data.assayTypes}
			reagentNames={data.reagentDefinitions as any}
			selectedAssayTypeId={previewParam ? 'preview' : (data.runState.assayTypeName ?? 'selected')}
			onSelectAssayType={previewParam ? () => {} : (id) => { selectedAssayTypeId = id; }}
			isResearch={previewParam ? false : (data.runState.isResearch || isResearchRun)}
			onSetResearch={previewParam ? () => {} : (v) => {
				isResearchRun = v;
				if (v) selectedAssayTypeId = '';
			}}
			onComplete={() => submitForm(stage ? 'confirmSetup' : 'createRun', stage
				? { isResearch: isResearchRun ? 'true' : 'false' }
				: { assayTypeId: isResearchRun ? '' : selectedAssayTypeId, isResearch: isResearchRun ? 'true' : 'false' })}
			readonly={isViewingPast}
		/>

	{:else if displayStage === 'Loading' && !previewParam && data.cartridges.length === 0 && !paramsReady && data.opentronsRobotId && data.robotProtocols}
		<!-- Protocol params BEFORE barcode scanning (mirror wax): configure the run
		     now; after you scan + prep reagents it starts automatically with these. -->
		<div class="space-y-4">
			<div class="rounded-lg border border-[var(--color-tron-border)] bg-[var(--color-tron-surface)] p-4">
				<h3 class="text-sm font-semibold text-[var(--color-tron-text)]">Set protocol parameters</h3>
				<p class="mt-1 text-xs text-[var(--color-tron-text-secondary)]">
					Configure the reagent run now. Next you'll scan the reagent batch, then the deck + cartridges — the run starts automatically once the deck is scanned.
				</p>
			</div>
			<ProtocolStartPanel
				robot={{ _id: data.opentronsRobotId, name: data.robotId }}
				protocols={data.robotProtocols}
				contextValues={REAGENT_PARAM_DEFAULTS}
				lastTipState={data.lastTipState}
				submitting={submitting}
				formAction="?/startRun"
				extraHidden={{ runId: data.activeRunId ?? '' }}
				submitLabel="Save & continue to reagent batch →"
				onSubmitIntercept={handleParamsConfirmed}
			/>
		</div>

	{:else if displayStage === 'Loading' && !previewParam && data.cartridges.length === 0 && !reagentBatchConfirmed}
		<!-- Step 2: Scan the reagent batch barcode BEFORE the deck scan (mirror wax).
		     Records the batch now; the run auto-starts once the deck is scanned, so
		     there are no more buttons after barcode scanning. -->
		<ReagentPreparation
			reagentDefinitions={data.reagentDefinitions as any}
			onComplete={async (tubes) => {
				reagentBatchBarcodeLocal = tubes[0]?.sourceLotId ?? '';
				reagentBatchConfirmedLocal = true;
				// Persist the batch (writes to the run record — no cartridge dependency).
				// Do NOT start the run yet: the deck hasn't been scanned. The deck-scan
				// step auto-starts once cartridges are on.
				await submitForm('recordReagentPrep', { tubes: JSON.stringify(tubes) });
			}}
			onSaveNote={handleSaveBatchNote}
			readonly={isViewingPast}
		/>

	{:else if displayStage === 'Loading' && (previewParam || data.cartridges.length === 0)}
		<!-- Step 3: Deck + cartridge scan. On complete, auto-start the run with the
		     params + batch captured before scanning — straight into filling, no button. -->
		<DeckLoadingGrid
			plannedCartridgeCount={plannedScanCount}
			onComplete={async ({ deckId, cartridgeScans }) => {
				await submitForm('loadDeck', { deckId, cartridgeScans: JSON.stringify(cartridgeScans) });
				// Hands-off auto-start (mirror wax): scan was the last manual step.
				// The !errorMsg guard is load-bearing — never start a run whose deck
				// load did not commit.
				if (!errorMsg && reagentBatchConfirmed && capturedParamsFd) {
					await startRunWithCapturedParams();
				}
			}}
			readonly={isViewingPast}
			focusPaused={showCancelModal}
			robotId={data.robotId}
			runId={data.activeRunId ?? null}
		/>

	{:else if displayStage === 'Loading' && data.cartridges.length > 0 && reagentBatchConfirmed}
		<!-- Step 3: Deck loaded AND batch confirmed — show summary and Start Run -->
		<div class="space-y-4">
			<div class="rounded-lg border border-green-500/30 bg-green-900/10 p-4">
				<div class="flex items-center gap-3">
					<svg class="h-6 w-6 text-green-400" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2">
						<path stroke-linecap="round" stroke-linejoin="round" d="M5 13l4 4L19 7" />
					</svg>
					<div>
						<p class="font-semibold text-green-400">Deck Loaded &amp; Reagent Batch Verified</p>
						<p class="text-sm text-green-300/70">{data.cartridges.length} cartridges ready · Batch {reagentBatchBarcode}</p>
					</div>
				</div>
			</div>
			{#if !isViewingPast && data.opentronsRobotId && data.robotProtocols}
				<ProtocolStartPanel
					robot={{ _id: data.opentronsRobotId, name: data.robotId }}
					protocols={data.robotProtocols}
					contextValues={{ ...REAGENT_PARAM_DEFAULTS, cartridges: data.cartridges.length }}
					contextReadonly={['cartridges']}
					lastTipState={data.lastTipState}
					submitting={submitting}
					formAction="?/startRun"
					extraHidden={{
						runId: data.activeRunId ?? '',
						reagentBatchBarcode: reagentBatchBarcode ?? ''
					}}
					onSubmitIntercept={lifecycleDirect ? startFromPanelDirect : undefined}
				/>
			{/if}
		</div>

	{:else if displayStage === 'Running'}
		{#if !isViewingPast && data.runState.opentronsRunId && data.opentronsRobotId}
			<EmbeddedRunController
				robotId={data.opentronsRobotId}
				robotName={data.runState.assayTypeName ?? 'Reagent Run'}
				opentronsRunId={data.runState.opentronsRunId}
				session={lifecycleSession}
				onStatusChange={(status) => { robotStatus = status; }}
				onComplete={(status) => {
					// The .py landed terminal — reveal the run-complete controls.
					// recordRunFinished auto-finalizes a succeeded run server-side
					// (carts stamped, robot freed); the panel below is confirmation.
					runFinishedLocal = true;
					recordRunFinishedViaLine(status);
				}}
			/>
			{#if !runFinished}
				<div class="mt-3 rounded-lg border border-amber-500/40 bg-amber-900/10 p-4">
					<div class="flex flex-wrap items-center justify-between gap-3">
						<div>
							<h3 class="text-sm font-semibold text-amber-200">Tip problem? Swap the tip without losing your place</h3>
							<p class="mt-1 text-xs text-amber-200/80">
								The robot stops before its next well, blows what is left in the tip back into the reagent tube, swaps the tip,
								re-calibrates it, then re-aspirates and continues at the exact well it stopped at. Works while running or paused.
							</p>
						</div>
						<div class="flex flex-wrap gap-2">
							<button type="button"
								class="rounded-md border border-amber-400/60 bg-amber-500/20 px-3 py-1.5 text-sm font-medium text-amber-100 hover:bg-amber-500/30 disabled:opacity-50"
								disabled={tipSwapStatus === 'sending'}
								onclick={() => requestTipSwap('rack')}>
								Swap tip — robot picks a new one
							</button>
							<button type="button"
								class="rounded-md border border-amber-400/60 bg-amber-500/20 px-3 py-1.5 text-sm font-medium text-amber-100 hover:bg-amber-500/30 disabled:opacity-50"
								disabled={tipSwapStatus === 'sending'}
								onclick={() => requestTipSwap('hand')}>
								Swap tip — I'll put one on by hand
							</button>
							{#if tipSwapStatus === 'rack' || tipSwapStatus === 'hand'}
								<button type="button"
									class="rounded-md border border-[var(--color-tron-border)] px-3 py-1.5 text-sm text-[var(--color-tron-text-secondary)] hover:text-[var(--color-tron-text)]"
									onclick={() => requestTipSwap('cancel')}>
									Cancel request
								</button>
							{/if}
						</div>
					</div>
					{#if tipSwapStatus === 'sending'}
						<p class="mt-2 text-xs text-amber-200/80">Sending to the robot…</p>
					{:else if tipSwapStatus === 'rack'}
						<p class="mt-2 text-xs text-emerald-300">Requested. The robot will stop before its next aspiration, drop the tip, pick a fresh one from the rack, calibrate it and continue. If the run is paused, press Resume.</p>
					{:else if tipSwapStatus === 'hand'}
						<p class="mt-2 text-xs text-emerald-300">Requested. The robot will stop before its next aspiration, raise the pipette over the calibrator and pause — pull the old tip off, push a new one on, then press Resume. It calibrates the new tip and continues. If the run is paused now, press Resume first so it can reach that point.</p>
					{:else if tipSwapStatus === 'cancelled'}
						<p class="mt-2 text-xs text-[var(--color-tron-text-secondary)]">Request cancelled (only if the robot hadn't acted on it yet).</p>
					{:else if tipSwapStatus === 'error'}
						<p class="mt-2 text-xs text-red-300">Could not send the request to the robot bridge — try again, or Pause and swap the tip when the run reaches its next tip change.</p>
					{/if}
				</div>
			{/if}
		{/if}
		{#if data.runState.runEndTime || previewParam}
			<RunExecution
				assayTypeName={previewParam
					? 'Preview Assay'
					: (data.runState.isResearch
						? 'Research Run'
						: (data.runState.assayTypeName ?? 'Unknown'))}
				cartridgeCount={previewParam ? 8 : (data.runState.cartridgeCount ?? 0)}
				runStartTime={new Date(data.runState.runStartTime ?? Date.now())}
				runEndTime={new Date(data.runState.runEndTime ?? (Date.now() + 600000))}
				protocolParameters={data.runState.protocolParameters}
				robotFinished={runFinished}
				finalStatus={data.runState.opentronsRunFinalStatus}
				paused={robotStatus === 'paused'}
				autoCompleteOnExpiry={!data.runState.opentronsRunId}
				onTimerComplete={() => { runFinishedLocal = true; }}
				onAbort={(reason, photoUrl) => stopRunViaLine('abort', { reason, photoUrl: photoUrl ?? '' })}
				readonly={isViewingPast}
			/>
		{:else}
			<!-- Run has been started but the server hasn't written runEndTime yet.
			     Show a brief "starting" state instead of a misleading flat-10-min
			     fallback estimate (see lib/manufacturing/reagent-run-estimate.ts). -->
			<div class="flex flex-col items-center gap-2 rounded-lg border border-[var(--color-tron-border)] bg-[var(--color-tron-surface)] p-6 text-center">
				<h2 class="text-lg font-semibold text-[var(--color-tron-text)]">Starting run…</h2>
				<p class="text-sm text-[var(--color-tron-text-secondary)]">Creating the protocol run on the robot — the countdown will appear once it begins.</p>
			</div>
		{/if}

		<!-- Run-complete controls: appear only once the .py finishes. A succeeded
		     run is already finalized server-side (carts → reagent_filled, robot
		     freed); Done just clears the page. Run again starts a fresh batch
		     with the same parameters. -->
		{#if !isViewingPast && (previewParam || runFinished)}
			<div class="mt-4 flex flex-col items-center gap-3 rounded-lg border border-[var(--color-tron-border)] bg-[var(--color-tron-surface)] p-4">
				{#if runFailed}
					<p class="text-sm text-red-300">
						The robot ended in "{data.runState.opentronsRunFinalStatus}" — these cartridges were NOT
						reagent-filled. Fix the cause shown above, then run them again. Only press Done if you
						have confirmed the reagent actually went in; it marks all
						{data.runState.cartridgeCount ?? 0} cartridges as reagent-filled.
					</p>
				{:else}
					<p class="text-sm text-[var(--color-tron-text-secondary)]">
						Run finished — batch completed and the robot is free. Top-seal the cartridges, then photograph on Reagent Inspect. Or run another batch with the same parameters.
					</p>
				{/if}
				<button
					type="button"
					onclick={() => submitForm('completeRunFilling', runFailed ? { confirmDespiteFailure: 'true' } : {})}
					disabled={submitting}
					class="min-h-[44px] w-full max-w-sm rounded-lg border border-green-500/50 bg-green-900/20 px-8 py-3 text-base font-bold text-green-400 transition-all hover:bg-green-900/30 disabled:opacity-50"
				>
					Done
				</button>
				<button
					type="button"
					onclick={handleRunAgain}
					disabled={submitting}
					class="min-h-[44px] w-full max-w-sm rounded-lg border border-[var(--color-tron-cyan)]/50 bg-[var(--color-tron-cyan)]/15 px-8 py-3 text-sm font-semibold text-[var(--color-tron-cyan)] transition-all hover:bg-[var(--color-tron-cyan)]/25 disabled:opacity-50"
				>
					Run again — same parameters, scan a fresh deck
				</button>
			</div>
		{/if}
	{/if}

	<!-- Cancel Run Modal -->
	{#if showCancelModal}
		<div class="fixed inset-0 z-50 flex items-center justify-center bg-black/60">
			<div class="mx-4 w-full max-w-md rounded-lg border border-[var(--color-tron-border)] bg-[var(--color-tron-surface)] p-6 shadow-xl">
				<h3 class="text-lg font-semibold text-[var(--color-tron-text)]">Cancel Run</h3>
				<p class="mt-2 text-sm text-[var(--color-tron-text-secondary)]">
					Are you sure you want to cancel run {data.activeRunId}? This action cannot be undone.
				</p>
				<label class="mt-4 block">
					<span class="text-sm font-medium text-[var(--color-tron-text-secondary)]">Reason</span>
					<textarea
						bind:value={cancelReason}
						rows="3"
						class="mt-1 w-full rounded border border-[var(--color-tron-border)] bg-[var(--color-tron-bg)] px-3 py-2 text-sm text-[var(--color-tron-text)] placeholder-[var(--color-tron-text-secondary)] focus:border-[var(--color-tron-cyan)] focus:outline-none"
						placeholder="Enter reason for cancellation..."
					></textarea>
				</label>
				<div class="mt-4 flex justify-end gap-3">
					<button
						type="button"
						onclick={() => { showCancelModal = false; cancelReason = ''; }}
						class="rounded-lg border border-[var(--color-tron-border)] px-4 py-2 text-sm text-[var(--color-tron-text-secondary)] transition-colors hover:bg-[var(--color-tron-border)]/30"
					>
						Go Back
					</button>
					<button
						type="button"
						onclick={() => { showCancelModal = false; stopRunViaLine('cancel', { reason: cancelReason.trim() }); cancelReason = ''; }}
						disabled={!cancelReason.trim() || submitting}
						class="rounded-lg bg-red-600 px-4 py-2 text-sm font-semibold text-white transition-colors hover:bg-red-700 disabled:opacity-50"
					>
						{submitting ? 'Cancelling...' : 'Confirm Cancel'}
					</button>
				</div>
			</div>
		</div>
	{/if}

	<!-- Reset to Deck Loading Modal -->
	{#if showResetModal}
		<div class="fixed inset-0 z-50 flex items-center justify-center bg-black/60">
			<div class="mx-4 w-full max-w-md rounded-lg border border-amber-500/30 bg-[var(--color-tron-surface)] p-6 shadow-xl">
				<h3 class="text-lg font-semibold text-amber-300">Reset to Deck Loading</h3>
				<p class="mt-2 text-sm text-[var(--color-tron-text-secondary)]">
					This will delete all cartridge records and seal batches for this run, release the deck,
					and return to the deck loading step. Reagent tube entries will be preserved.
				</p>
				<p class="mt-2 text-sm font-medium text-amber-300/80">
					This cannot be undone. Are you sure?
				</p>
				<div class="mt-4 flex justify-end gap-3">
					<button
						type="button"
						onclick={() => { showResetModal = false; }}
						class="rounded-lg border border-[var(--color-tron-border)] px-4 py-2 text-sm text-[var(--color-tron-text-secondary)] transition-colors hover:bg-[var(--color-tron-border)]/30"
					>
						Go Back
					</button>
					<button
						type="button"
						onclick={() => { showResetModal = false; submitForm('resetToLoading'); }}
						disabled={submitting}
						class="rounded-lg bg-amber-600 px-4 py-2 text-sm font-semibold text-white transition-colors hover:bg-amber-700 disabled:opacity-50"
					>
						{submitting ? 'Resetting...' : 'Confirm Reset'}
					</button>
				</div>
			</div>
		</div>
	{/if}

	<!-- Admin Override Modal -->
	{#if showOverrideModal}
		<div class="fixed inset-0 z-50 flex items-center justify-center bg-black/60">
			<div class="mx-4 w-full max-w-md rounded-lg border border-amber-500/30 bg-[var(--color-tron-surface)] p-6 shadow-xl">
				<h3 class="text-lg font-semibold text-amber-300">Admin Override</h3>
				<p class="mt-2 text-sm text-[var(--color-tron-text-secondary)]">
					Enter admin credentials to bypass validation and force this action through.
				</p>
				{#if overrideError}
					<div class="mt-3 rounded border border-red-500/30 bg-red-900/20 px-3 py-2 text-xs text-red-300">
						{overrideError}
					</div>
				{/if}
				<label class="mt-4 block">
					<span class="text-sm font-medium text-[var(--color-tron-text-secondary)]">Username</span>
					<input
						type="text"
						bind:value={overrideUser}
						autocomplete="username"
						class="mt-1 w-full rounded border border-[var(--color-tron-border)] bg-[var(--color-tron-bg)] px-3 py-2 text-sm text-[var(--color-tron-text)] placeholder-[var(--color-tron-text-secondary)] focus:border-amber-500 focus:outline-none"
						placeholder="Admin username"
					/>
				</label>
				<label class="mt-3 block">
					<span class="text-sm font-medium text-[var(--color-tron-text-secondary)]">Password</span>
					<input
						type="password"
						bind:value={overridePass}
						autocomplete="current-password"
						class="mt-1 w-full rounded border border-[var(--color-tron-border)] bg-[var(--color-tron-bg)] px-3 py-2 text-sm text-[var(--color-tron-text)] placeholder-[var(--color-tron-text-secondary)] focus:border-amber-500 focus:outline-none"
						placeholder="Admin password"
					/>
				</label>
				<div class="mt-4 flex justify-end gap-3">
					<button
						type="button"
						onclick={() => { showOverrideModal = false; overrideUser = ''; overridePass = ''; overrideError = ''; }}
						class="rounded-lg border border-[var(--color-tron-border)] px-4 py-2 text-sm text-[var(--color-tron-text-secondary)] transition-colors hover:bg-[var(--color-tron-border)]/30"
					>
						Cancel
					</button>
					<button
						type="button"
						disabled={!overrideUser.trim() || !overridePass || submitting}
						onclick={() => {
							showOverrideModal = false;
							errorMsg = '';
							submitForm(pendingOverrideAction, {
								...pendingOverrideData,
								adminUser: overrideUser.trim(),
								adminPass: overridePass
							});
							overrideUser = '';
							overridePass = '';
							overrideError = '';
							pendingOverrideAction = '';
							pendingOverrideData = {};
						}}
						class="rounded-lg bg-amber-600 px-4 py-2 text-sm font-semibold text-white transition-colors hover:bg-amber-700 disabled:opacity-50"
					>
						{submitting ? 'Verifying...' : 'Override'}
					</button>
				</div>
			</div>
		</div>
	{/if}

	<!-- Skip Stage Confirmation Modal -->
	{#if showSkipModal && skipTargetIndex >= 0}
		<div class="fixed inset-0 z-50 flex items-center justify-center bg-black/60">
			<div class="mx-4 w-full max-w-md rounded-lg border border-amber-500/30 bg-[var(--color-tron-surface)] p-6 shadow-xl">
				<h3 class="text-lg font-semibold text-amber-300">Skip to {stageLabel(STAGES[skipTargetIndex])}</h3>
				<p class="mt-2 text-sm text-[var(--color-tron-text-secondary)]">
					This will advance the run directly from
					<span class="font-medium text-[var(--color-tron-cyan)]">{stageLabel(STAGES[currentStageIndex])}</span>
					to
					<span class="font-medium text-amber-300">{stageLabel(STAGES[skipTargetIndex])}</span>,
					skipping intermediate steps.
				</p>
				<p class="mt-2 text-sm font-medium text-amber-300/80">
					This action is logged and may affect data integrity. Continue?
				</p>
				<div class="mt-4 flex justify-end gap-3">
					<button
						type="button"
						onclick={() => { showSkipModal = false; skipTargetIndex = -1; }}
						class="rounded-lg border border-[var(--color-tron-border)] px-4 py-2 text-sm text-[var(--color-tron-text-secondary)] transition-colors hover:bg-[var(--color-tron-border)]/30"
					>
						Go Back
					</button>
					<button
						type="button"
						disabled={submitting}
						onclick={() => {
							showSkipModal = false;
							const target = STAGES[skipTargetIndex];
							skipTargetIndex = -1;
							submitForm('forceAdvanceStage', { targetStage: target });
						}}
						class="rounded-lg bg-amber-600 px-4 py-2 text-sm font-semibold text-white transition-colors hover:bg-amber-700 disabled:opacity-50"
					>
						{submitting ? 'Advancing...' : 'Confirm Skip'}
					</button>
				</div>
			</div>
		</div>
	{/if}
</div>
