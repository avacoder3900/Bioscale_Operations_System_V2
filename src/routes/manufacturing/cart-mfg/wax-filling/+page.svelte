<script lang="ts">
	import { enhance, deserialize } from '$app/forms';
	import { goto, invalidateAll } from '$app/navigation';
	import { page } from '$app/stores';
	import WaxPreparation from '$lib/components/manufacturing/wax-filling/WaxPreparation.svelte';
	import DeckLoadingGrid from '$lib/components/manufacturing/wax-filling/DeckLoadingGrid.svelte';
	import RunExecution from '$lib/components/manufacturing/wax-filling/RunExecution.svelte';
	import ProtocolStartPanel from '$lib/components/manufacturing/ProtocolStartPanel.svelte';
	import EmbeddedRunController from '$lib/components/manufacturing/EmbeddedRunController.svelte';
	import type { RejectionReasonCode } from '$lib/server/db/schema';

	interface Props {
		data: {
			robotId: string;
			robotName: string;
			loadError: string | null;
			robotBlocked: { process: 'reagent'; runId: string | null } | null;
			runState: {
				hasActiveRun: boolean;
				runId: string | null;
				stage: string | null;
				runStartTime: string | null;
				runEndTime: string | null;
				deckRemovedTime: string | null;
				deckId: string | null;
				waxSourceLot: string | null;
				coolingTrayId: string | null;
				plannedCartridgeCount: number | null;
				coolingConfirmedAt: string | null;
				existingWaxRunNote?: string;
				opentronsRunId?: string | null;
				opentronsRunFinalStatus?: string | null;
				protocolParameters?: Record<string, unknown> | null;
			};
			settings: {
				runDurationMin: number;
				removeDeckWarningMin: number;
				coolingWarningMin: number;
				deckLockoutMin: number;
				incubatorTempC: number;
				heaterTempC: number;
				minCoolingBeforeQcMin?: number;
				waxPerCartridgeUl: number;
				waxFillDeadVolumeUl: number;
			};
			tubeData: {
				tubeId: string;
				initialVolumeUl: number;
				remainingVolumeUl: number;
				status: string;
				totalCartridgesFilled: number;
				totalRunsUsed: number;
			} | null;
			waxLots: {
				barcode: string;
				label: string;
				remainingVolumeUl: number;
				source: string;
			}[];
			backedOvens: {
				ovenId: string;
				ovenName: string;
				total: number;
				ready: number;
			}[];
			backedReadyCount: number;
			backedTotalCount: number;
			rejectionCodes: RejectionReasonCode[];
			fridges: {
				id: string;
				displayName: string;
				barcode: string;
			}[];
			robotProtocols?: {
				opentronsProtocolId: string;
				protocolName: string;
				protocolType: string | null;
				analysisStatus: string | null;
				parametersSchema: unknown;
			}[];
			opentronsRobotId?: string;
			lastTipState?: {
				nextTipIndex: number | null;
				hostname: string | null;
				capturedAt: string | null;
			} | null;
		};
	}

	let { data }: Props = $props();

	let submitting = $state(false);
	let submittingTooLong = $state(false);

	/**
	 * Mid-run tip swap (2026-08-18). Sends a request to the on-robot bridge; the
	 * running wax protocol picks it up before its next dispense, swaps the tip
	 * (robot from the rack, or the operator by hand), re-probes it on the
	 * calibrator, and re-aspirates + continues at the very well it stopped at.
	 * Usable while the run is running or paused.
	 */
	let tipSwapStatus = $state<'' | 'sending' | 'rack' | 'hand' | 'cancelled' | 'error'>('');
	let tipSwapAt = $state<number>(0);
	async function requestTipSwap(mode: 'rack' | 'hand' | 'cancel') {
		if (!data.runState.runId) return;
		tipSwapStatus = 'sending';
		try {
			const fd = new FormData();
			fd.set('runId', data.runState.runId);
			fd.set('mode', mode === 'cancel' ? 'rack' : mode);
			fd.set('cancel', mode === 'cancel' ? 'true' : 'false');
			const res = await fetch('?/requestTipSwap', {
				method: 'POST',
				body: fd,
				headers: { 'x-sveltekit-action': 'true' },
				signal: AbortSignal.timeout(20000)
			});
			const text = await res.text();
			if (!res.ok || text.includes('"type":"failure"')) throw new Error(text.slice(0, 200));
			tipSwapStatus = mode === 'cancel' ? 'cancelled' : mode;
			tipSwapAt = Date.now();
		} catch (e) {
			console.error('[wax] tip swap request failed', e);
			tipSwapStatus = 'error';
		}
	}
	let errorMsg = $state('');
	// Post-action notice for carts the wax-flow guard (protectLockedCarts)
	// silently skipped during a write. Surfaced as an amber banner the operator
	// must dismiss so a "200 OK" no longer masks a partial write. Reset on the
	// next submitAction call.
	let skippedNotice = $state<{ count: number; carts: { cartridgeId: string; status: string }[]; action: string } | null>(null);
	let showCancelModal = $state(false);
	let cancelReason = $state('');

	// Test Mode removed from the UI — cartridges always come from real WI-01
	// backing now. Kept as a constant false so the loadDeck call sites compile
	// without synthesizing test cartridges.
	const testMode = false;

	// WAX-FLOW-STREAMLINE: the cartridge-layout grid (DeckLoadingGrid) is the single
	// deck-load surface — its on-robot deck scan + sweep fill the grid live, failed
	// slots show red and are click-to-rescan, then loadDeck advances to Start Run.
	// Flip to false to restore the old one-button orchestration checklist below.
	const USE_GRID_PRIMARY = true;

	// After a clean barcode scan (deck + all cartridges, no mismatch) loadDeck
	// advances to ready_to_run; this auto-fires the protocol Start Run there so
	// the operator goes straight into the run with no extra click.
	let autoStartPending = $state(false);

	// Protocol parameters are set in their OWN step BEFORE barcode scanning so the
	// operator configures the run, then walks away during the scan and it starts
	// automatically with those exact values (instead of the run-start params being
	// skipped by auto-start). The chosen protocol + param values are captured as
	// the FormData the panel would have submitted, then replayed to ?/startRun
	// after a clean scan. Client-only: a mid-flow page reload re-shows the step.
	let paramsReady = $state(false);
	let capturedParamsFd = $state<FormData | null>(null);

	/**
	 * Run-time parameters BIMS pre-selects for a wax run, overriding the .py's own
	 * defaults. These seed the form; the operator can still change any of them.
	 *
	 * Gate volumes: the .py defaults all four gates to 1.60, but the line has run
	 * gate 1 at 1.6 and gates 2-4 at 2.2 on every wax run since 2026-07-28 (16
	 * consecutive runs across R04 and B07), so the operator retyped three fields
	 * every time. These are the values already in use — this only stops the typing.
	 *
	 * Row alignment holds at these volumes. Per the .py's own arithmetic, a
	 * cartridge row is 4 wax wells (gates 4,3,2,1) = 8.2uL at 2.2/2.2/2.2/1.6,
	 * which fits the 20uL - aspirate_remainder budget as long as the remainder is
	 * <= 11.8; its default is 11.5. That matters because an aspiration batch that
	 * ends mid-row forces the next one to open by crossing a cartridge wall, which
	 * bends the tip — see the row_key batching guard in the protocol.
	 *
	 * Deliberately NOT in contextReadonly: gate volumes are the main tuning knob
	 * for fill quality, so they stay editable per run.
	 *
	 * dispense_depth is intentionally left alone — it is per-robot (B07 needed a
	 * different value to stop tips breaking on dispense) and has no single default.
	 *
	 * Frozen for a stable object identity: ProtocolStartPanel re-seeds the whole
	 * form when contextValues changes, which would wipe an operator's edits.
	 */
	const WAX_PARAM_DEFAULTS = Object.freeze({
		vol_gate1: 1.6,
		vol_gate2: 2.2,
		vol_gate3: 2.2,
		vol_gate4: 2.2,
		// Tip calibration ON by default (2026-08-18): decks are taught in the Studio
		// with "Calibrate tip" active (tip-neutral coordinates), so the fill must
		// apply the same probe adjust to land the wax hole — OFF parks the tip on
		// the reagent hole (confirmed on B07/deck-004). max_tip_adjust 4.0 rejects
		// only genuinely bad probes (B07's normal wax adjust is ~2.3mm).
		// Only posted when the protocol declares the RTP (server filters by schema).
		use_tip_calibration: true,
		max_tip_adjust: 4.0,
		run_calibration_check: false
	});

	// Orchestrated scan-and-start (deck_load substage): one Start Run press
	// drives deck-barcode scan → cartridge sweep → loadDeck → startRun. Each
	// step is rendered in a visible checklist; any failure aborts and opens
	// the manual scanning fallback (DeckLoadingGrid) below.
	type OrchStepStatus = 'pending' | 'active' | 'done' | 'failed';
	interface OrchStep {
		id: 'deck' | 'sweep' | 'load' | 'start';
		label: string;
		status: OrchStepStatus;
		detail: string;
	}
	let orchestrating = $state(false);
	let orchSteps = $state<OrchStep[]>([]);
	let manualFallbackOpen = $state(false);

	function setOrchStep(id: OrchStep['id'], status: OrchStepStatus, detail = '') {
		orchSteps = orchSteps.map((s) => (s.id === id ? { ...s, status, detail } : s));
	}

	function failOrchStep(id: OrchStep['id'], detail: string) {
		setOrchStep(id, 'failed', detail);
		manualFallbackOpen = true;
	}

	// SvelteKit error(status, msg) from +server routes returns { message }
	// JSON for fetch callers; plain json({ error }) bodies use { error }.
	async function apiErrorMessage(res: Response): Promise<string> {
		try {
			const body = await res.json();
			const msg = (body as any)?.message ?? (body as any)?.error;
			if (typeof msg === 'string' && msg.length > 0) return msg;
		} catch {
			// non-JSON body — fall through to the status code
		}
		return `Request failed (HTTP ${res.status})`;
	}

	// Compact SvelteKit action-response error extractor (same shapes as
	// submitAction's parser; used for the direct ?/startRun POST in step d).
	function parseActionError(text: string, status: number): string {
		let err = `Action failed (HTTP ${status})`;
		try {
			const json = JSON.parse(text);
			if (json.type === 'failure' && json.data != null) {
				const parsed = typeof json.data === 'string' ? JSON.parse(json.data) : json.data;
				if (Array.isArray(parsed)) {
					for (let i = 1; i < parsed.length; i++) {
						if (typeof parsed[i] === 'string' && parsed[i].length > 3) return parsed[i];
					}
				}
			} else if (json.type === 'error' && json.error) {
				const msg = (json.error as any)?.message;
				if (typeof msg === 'string' && msg.length > 0) return msg;
			} else if (typeof json.error === 'string' && json.error.length > 0) {
				return json.error;
			}
		} catch {
			// unparseable body — keep the HTTP-status fallback
		}
		return err;
	}

	async function handleScanAndStart(formData: FormData) {
		if (previewParam || submitting || orchestrating) return;
		const runId = data.runState.runId;
		if (!runId) return;
		errorMsg = '';
		manualFallbackOpen = false;
		orchSteps = [
			{ id: 'deck', label: 'Scan deck barcode', status: 'pending', detail: '' },
			{ id: 'sweep', label: 'Scan cartridges', status: 'pending', detail: '' },
			{ id: 'load', label: 'Load deck', status: 'pending', detail: '' },
			{ id: 'start', label: 'Start protocol', status: 'pending', detail: '' }
		];
		orchestrating = true;
		try {
			// (a) Deck barcode — synchronous gantry scan, up to ~45s server-side.
			setOrchStep('deck', 'active', 'Robot is scanning the deck barcode…');
			let deckBarcode = '';
			try {
				const res = await fetch('/api/scanner/deck-scan', {
					method: 'POST',
					headers: { 'content-type': 'application/json' },
					body: JSON.stringify({ robotId: data.robotId })
				});
				if (!res.ok) {
					failOrchStep('deck', await apiErrorMessage(res));
					return;
				}
				const body = await res.json();
				if (typeof body?.barcode === 'string') deckBarcode = body.barcode;
			} catch (e) {
				failOrchStep('deck', e instanceof Error ? e.message : 'Network error');
				return;
			}
			if (!deckBarcode) {
				failOrchStep('deck', 'Scanner completed but returned no deck barcode');
				return;
			}
			setOrchStep('deck', 'done', `Deck ${deckBarcode}`);

			// (b) Cartridge sweep — enqueue, then poll the snapshot every 1.5s
			// (cap 5 min). The daemon walks each taught slot with the gantry
			// scanner and streams per-slot progress back.
			const planned = data.runState.plannedCartridgeCount ?? 24;
			setOrchStep('sweep', 'active', 'Starting cartridge sweep…');
			let scans: { slotIndex: number; barcode: string }[] = [];
			try {
				const res = await fetch('/api/scanner/sweep', {
					method: 'POST',
					headers: { 'content-type': 'application/json' },
					body: JSON.stringify({
						robotId: data.robotId,
						source: 'wax_filling',
						contextRef: runId,
						maxSlots: planned
					})
				});
				if (!res.ok) {
					failOrchStep('sweep', await apiErrorMessage(res));
					return;
				}
				const { sweepRunId, slotsTotal } = await res.json();
				const deadline = Date.now() + 5 * 60 * 1000;
				let snap: any = null;
				while (Date.now() < deadline) {
					await new Promise((r) => setTimeout(r, 1500));
					const poll = await fetch(`/api/scanner/sweep/${sweepRunId}`);
					if (!poll.ok) {
						failOrchStep('sweep', await apiErrorMessage(poll));
						return;
					}
					snap = await poll.json();
					const total = snap.slotsTotal ?? slotsTotal ?? planned;
					setOrchStep('sweep', 'active', `Scanning… slot ${Math.min((snap.slotsDone ?? 0) + 1, total)}/${total}`);
					if (['completed', 'errored', 'cancelled'].includes(snap.status)) break;
				}
				if (!snap || !['completed', 'errored', 'cancelled'].includes(snap.status)) {
					failOrchStep('sweep', 'Timed out waiting for the cartridge sweep (5 min)');
					return;
				}
				if (snap.status !== 'completed') {
					failOrchStep('sweep', snap.abortReason || `Sweep ${snap.status}`);
					return;
				}
				scans = ((snap.scans ?? []) as { slotIndex: number; barcode: string }[])
					.filter((s) => typeof s?.barcode === 'string' && s.barcode.length > 0 && typeof s?.slotIndex === 'number')
					.sort((a, b) => a.slotIndex - b.slotIndex);
				const errCount = ((snap.errors ?? []) as unknown[]).length;
				if (errCount > 0 || scans.length < planned) {
					failOrchStep('sweep', `Robot scanned ${scans.length} of ${planned} cartridges (${errCount} failure${errCount === 1 ? '' : 's'}) — use manual scanning below to finish`);
					return;
				}
				const barcodes = scans.map((s) => s.barcode);
				if (new Set(barcodes).size !== barcodes.length) {
					failOrchStep('sweep', 'Duplicate cartridge barcodes scanned across slots — use manual scanning below');
					return;
				}
			} catch (e) {
				failOrchStep('sweep', e instanceof Error ? e.message : 'Network error');
				return;
			}
			setOrchStep('sweep', 'done', `${scans.length} cartridges scanned`);

			// (c) loadDeck via the existing submitAction — keeps the admin
			// cure-time override capture (pendingOverrideData) intact. On an
			// override resubmission via the modal the run lands in
			// ready_to_run; the operator presses Start Run there (we do NOT
			// auto-resume through the override).
			setOrchStep('load', 'active', 'Recording deck load…');
			const cartridgeScans = scans.map((s) => ({ cartridgeId: s.barcode, backedLotId: '' }));
			await submitAction('loadDeck', {
				runId,
				deckId: deckBarcode,
				cartridgeScans: JSON.stringify(cartridgeScans),
				...(testMode ? { testMode: 'true' } : {})
			});
			if (errorMsg) {
				failOrchStep('load', errorMsg);
				return;
			}
			setOrchStep('load', 'done', `Deck ${deckBarcode} · ${cartridgeScans.length} cartridges`);

			// (d) startRun — POST the panel's captured FormData (protocol +
			// params) the same way submitAction posts actions.
			setOrchStep('start', 'active', 'Starting protocol on the robot…');
			try {
				formData.set('runId', runId);
				const controller = new AbortController();
				const timeout = setTimeout(() => controller.abort(), 45000);
				const res = await fetch('?/startRun', {
					method: 'POST',
					body: formData,
					headers: { 'x-sveltekit-action': 'true' },
					signal: controller.signal
				});
				clearTimeout(timeout);
				const text = await res.text();
				if (!res.ok || text.includes('"type":"failure"')) {
					const err = parseActionError(text, res.status);
					errorMsg = err;
					setOrchStep('start', 'failed', err);
					return;
				}
			} catch (e) {
				const err =
					e instanceof DOMException && e.name === 'AbortError'
						? 'Request timed out — the server may be slow.'
						: e instanceof Error
							? e.message
							: 'Request failed';
				errorMsg = err;
				setOrchStep('start', 'failed', err);
				return;
			}
			setOrchStep('start', 'done', 'Protocol running');
			pendingStage = 'Running';
			await invalidateAll();
			if (data.runState.hasActiveRun) {
				pendingStage = null;
			}
			orchSteps = [];
		} finally {
			orchestrating = false;
		}
	}

	// Admin override state
	let showOverrideModal = $state(false);
	let overrideUser = $state('');
	let overridePass = $state('');
	let overrideError = $state('');
	let pendingOverrideAction = $state('');
	let pendingOverrideData = $state<Record<string, string>>({});

	// Deck-removal is the terminal commit (storeDeckAndComplete → wax_filled, run
	// completed → page idle), so this page owns only Loading → Running. Cooling/QC/
	// storage were removed (WAX-SIMPLIFY-1: deck-removed → fridge → wax_filled).
	const STAGES = ['Loading', 'Running'] as const;

	// Optimistic stage: prevents UI flash when invalidateAll() returns stale/failed data
	const ACTION_NEXT_STAGE: Record<string, string> = {
		recordWaxPrep: 'Loading',
		loadDeck: 'Loading',
		startRun: 'Running',
	};
	let pendingStage = $state<string | null>(null);
	let effectiveStage = $derived(pendingStage ?? (data.runState.hasActiveRun ? data.runState.stage : null));
	let effectiveHasActiveRun = $derived(!!pendingStage || data.runState.hasActiveRun);

	let currentStageIndex = $derived(
		effectiveHasActiveRun && effectiveStage
			? STAGES.indexOf(effectiveStage as (typeof STAGES)[number])
			: -1
	);

	// eslint-disable-next-line svelte/prefer-writable-derived -- viewStageIndex is user-writable via arrow buttons
	let viewStageIndex = $state(-1);

	// Reset viewStageIndex when currentStageIndex changes
	$effect(() => {
		viewStageIndex = currentStageIndex;
	});

	let viewStage = $derived(viewStageIndex >= 0 ? STAGES[viewStageIndex] : null);
	let isViewingPast = $derived(viewStageIndex >= 0 && viewStageIndex < currentStageIndex);

	function stageLabel(stage: string): string {
		switch (stage) {
			case 'Loading':
				return '1. Wax fill setup';
			case 'Running':
				return '2. Run';
			default:
				return stage;
		}
	}

	// Restore error message after hard reload
	$effect(() => {
		const stored = sessionStorage.getItem('wax-error');
		if (stored) {
			errorMsg = stored;
			sessionStorage.removeItem('wax-error');
		}
	});

	async function forceReload() {
		await invalidateAll();
		submitting = false;
		submittingTooLong = false;
	}

	async function submitAction(action: string, formData: Record<string, string>) {
		if (submitting) return;
		submitting = true;
		submittingTooLong = false;
		errorMsg = '';
		skippedNotice = null;
		pendingOverrideAction = '';
		pendingOverrideData = {};

		// Show escape button after 5 seconds
		const slowTimer = setTimeout(() => { submittingTooLong = true; }, 5000);

		try {
			const controller = new AbortController();
			const timeout = setTimeout(() => controller.abort(), 45000);

			const fd = new FormData();
			for (const [k, v] of Object.entries(formData)) {
				fd.set(k, v);
			}
			const res = await fetch(`?/${action}`, {
				method: 'POST',
				body: fd,
				headers: { 'x-sveltekit-action': 'true' },
				signal: controller.signal
			});
			clearTimeout(timeout);
			clearTimeout(slowTimer);
			const text = await res.text();
			if (!res.ok || text.includes('"type":"failure"')) {
				// Parse SvelteKit action response. Handles three shapes:
				//   fail(): {type: "failure", data: "[{\"error\":1},\"msg\"]"}
				//   error(): {type: "error", error: {message: "..."}}
				//   plain:  {error: "..."}
				// Always coerces to a string — otherwise a raw object assigned
				// to errorMsg renders as literal "[object Object]".
				let serverError: string = `Action failed (HTTP ${res.status})`;
				const toStr = (v: unknown): string | null => {
					if (typeof v === 'string' && v.length > 0) return v;
					if (v && typeof v === 'object') {
						const msg = (v as any).message ?? (v as any).error;
						if (typeof msg === 'string' && msg.length > 0) return msg;
						try { return JSON.stringify(v); } catch { return null; }
					}
					return null;
				};
				try {
					const json = JSON.parse(text);
					if (json.type === 'failure' && json.data != null) {
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
						} else {
							const s = toStr((json.data as any).error ?? json.data);
							if (s) serverError = s;
						}
					} else if (json.type === 'error' && json.error) {
						const s = toStr(json.error);
						if (s) serverError = s;
					} else if (json.error) {
						const s = toStr(json.error);
						if (s) serverError = s;
					}
				} catch {
					// Fallback: find the longest readable string in the body
					const strings = text.match(/"([^"\\]{10,})"/g);
					if (strings) {
						const msg = strings[strings.length - 1].slice(1, -1);
						if (msg && !msg.includes('{')) serverError = msg;
					}
				}
				// Store failed loadDeck action for admin override — the resubmit
				// must carry override=true so the server takes the admin re-auth
				// path for cartridges still under the minimum oven time.
				if (action === 'loadDeck') {
					pendingOverrideAction = action;
					pendingOverrideData = { ...formData, override: 'true' };
				}
				errorMsg = serverError;
				// Scroll the error banner into view — on the deck grid the
				// banner is above the fold and easy to miss otherwise.
				requestAnimationFrame(() => {
					document.querySelector('[data-error-banner]')?.scrollIntoView({ behavior: 'smooth', block: 'center' });
				});
				await invalidateAll();
				return;
			}
			// Surface any carts the server silently skipped because they're now
			// linked/underway/completed/voided/scrapped (LOCKED_STATUSES). The
			// action returns 200 with skippedLockedCount on the payload — without
			// this we'd assume success and the operator would never know.
			try {
				const result = deserialize(text);
				if (result.type === 'success' && result.data) {
					const d = result.data as {
						skippedLockedCount?: number;
						skippedCarts?: { cartridgeId: string; status: string }[];
					};
					if ((d.skippedLockedCount ?? 0) > 0 && d.skippedCarts?.length) {
						skippedNotice = {
							count: d.skippedLockedCount!,
							carts: d.skippedCarts,
							action
						};
					}
				}
			} catch {
				// Best-effort — if devalue parse fails we still proceed.
			}
			// Optimistic stage update — show the expected next stage immediately
			if (action in ACTION_NEXT_STAGE) {
				pendingStage = ACTION_NEXT_STAGE[action];
			}
			// Re-run all load functions to refresh data
			await invalidateAll();
			// Clear pending stage if server returned valid data, or if this was a terminal action
			if (data.runState.hasActiveRun || ['completeRun', 'cancelRun', 'abortRun'].includes(action)) {
				pendingStage = null;
			}
		} catch (e) {
			clearTimeout(slowTimer);
			if (e instanceof DOMException && e.name === 'AbortError') {
				errorMsg = 'Request timed out — the server may be slow.';
			} else {
				errorMsg = e instanceof Error ? e.message : 'Request failed';
			}
		} finally {
			submitting = false;
			submittingTooLong = false;
		}
	}

	function handleWaxPrepComplete(result: { sourceLot: string; plannedCartridgeCount: number }) {
		if (previewParam) return;
		// Run creation is deferred to here (WAX-FLOW): selecting a robot no longer
		// creates a run, so idle robots stay idle. recordWaxPrep creates the run
		// from robotId when none exists yet, then records the wax prep. If a run
		// already exists (legacy/manual start), it's reused via runId.
		submitAction('recordWaxPrep', {
			runId: data.runState.runId ?? '',
			robotId: data.robotId,
			waxSourceLot: result.sourceLot,
			plannedCartridgeCount: String(result.plannedCartridgeCount)
		});
	}

	// Capture the protocol + params chosen at the params step (before scanning).
	// The panel hands us the exact FormData it would have submitted to ?/startRun;
	// we replay it after a clean scan so the run starts with those values.
	/**
	 * Explicit escape hatch for calibration/tuning fills with nothing scanned:
	 * startRun now refuses a run with no deck/cartridges unless this is ticked
	 * (untracked fills were silently producing carts that could never be marked
	 * wax_filled). Posted as testFillNoCartridges on startRun.
	 */
	let testFillNoCarts = $state(false);

	function handleParamsConfirmed(fd: FormData) {
		if (testFillNoCarts) fd.set('testFillNoCartridges', 'true');
		capturedParamsFd = fd;
		paramsReady = true; // advances the substage to barcode scanning (deck_load)
	}

	// Start the run with the params captured before scanning. Hands-off path.
	async function startRunWithCapturedParams() {
		if (!capturedParamsFd || !data.runState.runId) return;
		capturedParamsFd.set('runId', data.runState.runId);
		submitting = true;
		pendingStage = 'Running';
		try {
			const res = await fetch('?/startRun', {
				method: 'POST',
				body: capturedParamsFd,
				headers: { 'x-sveltekit-action': 'true' }
			});
			const text = await res.text();
			if (!res.ok || text.includes('"type":"failure"')) {
				// Surface what the SERVER said (2026-08-28). The generic message hid
				// the actionable one — e.g. the untracked-fill guard's "this run has
				// no scanned deck/cartridges" — so the page just bounced back to
				// scanning and the operator had no idea why it kept looping.
				const detail = parseActionError(text, res.status);
				errorMsg = detail
					? `Auto-start failed: ${detail}`
					: 'Auto-start with your parameters failed — start the run manually below.';
				pendingStage = null;
				autoStartPending = false;
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

	async function handleDeckLoadComplete(result: {
		deckId: string;
		ovenId: string;
		cartridgeScans: { cartridgeId: string; backedLotId: string }[];
		countMismatchReason?: string;
	}) {
		if (previewParam) return;
		if (!data.runState.runId) return;
		const formData: Record<string, string> = {
			runId: data.runState.runId,
			deckId: result.deckId,
			ovenId: result.ovenId,
			cartridgeScans: JSON.stringify(result.cartridgeScans)
		};
		if (result.countMismatchReason) {
			formData.countMismatchReason = result.countMismatchReason;
		}
		const cleanScan = !result.countMismatchReason;
		if (cleanScan && capturedParamsFd) {
			// Hands-off: record the deck load, then start the run with the params
			// the operator set BEFORE scanning. No ready_to_run panel, no clicks.
			await submitAction('loadDeck', formData);
			// STOP if the deck load did not commit (2026-08-28). Charging into
			// startRun anyway used to produce a run with no deck/cartridges — the
			// robot filled carts no record pointed at. Since the untracked-fill
			// guard, the same bug just loops back to scanning with a generic
			// error. Either way the fix is the same: don't start what didn't load.
			if (errorMsg) return;
			await startRunWithCapturedParams();
		} else {
			// Fallback (mismatch, or params not captured e.g. mid-flow reload):
			// land on ready_to_run; auto-start there only on a clean scan.
			if (cleanScan) autoStartPending = true;
			submitAction('loadDeck', formData);
		}
	}

	function handleDeckRemoved(storageLocation: string) {
		// Deck-removed is now the single commit: write the waxFilling phase record,
		// store in the chosen fridge, land the whole deck at wax_filled, complete
		// the run. Replaces the old cooling → QC → storage chain.
		if (data.runState.runId) {
			submitAction('storeDeckAndComplete', {
				runId: data.runState.runId,
				storageLocation
			});
		}
	}

	function handleResetToLoading() {
		if (data.runState.runId) {
			submitAction('resetToLoading', { runId: data.runState.runId });
		}
	}

	function handleAborted(result: {
		usableCartridgeIds: string[];
		scrapCartridgeIds: string[];
		scrapReason: string;
		columnsCompleted: number;
	}) {
		if (data.runState.runId) {
			submitAction('abortRun', {
				runId: data.runState.runId,
				usableCartridgeIds: JSON.stringify(result.usableCartridgeIds),
				scrapCartridgeIds: JSON.stringify(result.scrapCartridgeIds),
				scrapReason: result.scrapReason,
				columnsCompleted: String(result.columnsCompleted)
			});
		}
	}

	async function handleCancelRun() {
		if (!data.runState.runId || !cancelReason.trim()) return;
		showCancelModal = false;
		await submitAction('cancelRun', {
			runId: data.runState.runId,
			reason: cancelReason.trim()
		});
		cancelReason = '';
	}


	// Loading stage has 3 sub-steps: wax prep -> deck loading -> ready to run
	let loadingSubStage = $derived.by(() => {
		if (!effectiveHasActiveRun || (viewStage !== 'Loading' && effectiveStage !== 'Loading')) return 'wax_prep';
		// Hold deck_load while the orchestrated scan-and-start is in flight —
		// its loadDeck step sets deckId mid-flight, which would otherwise flip
		// the UI to ready_to_run and unmount the step checklist.
		if (orchestrating) return 'deck_load';
		if (data.runState.deckId) return 'ready_to_run';
		// Protocol params come BEFORE barcode scanning now: once the wax lot is
		// recorded, set params, then advance to the scan.
		if (data.runState.waxSourceLot) return paramsReady ? 'deck_load' : 'params';
		return 'wax_prep';
	});

	// Preview mode
	type WaxStage = (typeof STAGES)[number];
	const previewParam = $derived($page.url.searchParams.has('preview'));
	let previewStage = $state<WaxStage>('Loading');
	let previewLoadingSub = $state<'wax_prep' | 'params' | 'deck_load' | 'ready_to_run'>('wax_prep');
	const displayStage = $derived(previewParam ? previewStage : viewStage);
	const displayLoadingSub = $derived(previewParam ? previewLoadingSub : loadingSubStage);

	// Timeline bubbles (3): the Loading stage is split into "Wax fill setup"
	// (wax_prep) and "Barcode scanning" (deck_load/ready_to_run); then Run. The
	// run ends at deck-removal (→ fridge, status wax_filled) inside the Run stage, so
	// there are no cooling/QC/storage bubbles.
	const TIMELINE = ['Wax fill setup', 'Barcode scanning', 'Run'] as const;
	const currentBubbleIndex = $derived.by(() => {
		const s = effectiveStage;
		if (s === 'Loading') return (loadingSubStage === 'wax_prep' || loadingSubStage === 'params') ? 0 : 1;
		if (s === 'Running') return 2;
		return 0;
	});
	const isPreviewOrPast = $derived(previewParam || isViewingPast);

	// Reset the params step whenever the active run changes (new run / switched
	// robot / run finished) so each run requires its own parameter confirmation.
	let lastParamsRunId = '';
	$effect(() => {
		const rid = data.runState.runId ?? '';
		if (rid !== lastParamsRunId) {
			lastParamsRunId = rid;
			paramsReady = false;
			capturedParamsFd = null;
		}
	});

	// Run finished = the OT-2 .py reached a terminal status. Sourced from the
	// EmbeddedRunController completion callback (live) OR the server stamp
	// (survives reload). Gates the deck-removal confirmation.
	// NOTE: wax "Run again" is intentionally NOT wired yet — wax cooling/QC/storage
	// are still owned by this page (status 'Awaiting Removal' stays active here, no
	// robotReleasedAt filter on the load), so creating a new run mid-cooling would
	// orphan the cooling batch. Wax Run-again needs the same off-page treatment the
	// reagent flow got (REAGENT-INSPECT-AFTER-TOPSEAL) before it's safe.
	let runFinishedLocal = $state(false);
	const runFinished = $derived(runFinishedLocal || !!data.runState.opentronsRunFinalStatus);

</script>

<div class="space-y-6">
	{#if previewParam}
		<!-- Preview mode stage picker -->
		<div class="rounded-lg border border-[var(--color-tron-orange)]/50 bg-[var(--color-tron-orange)]/10 p-3">
			<div class="mb-2 flex items-center justify-between">
				<span class="text-xs font-bold text-[var(--color-tron-orange)]">PREVIEW MODE</span>
				<a href="?" class="text-xs text-[var(--color-tron-text-secondary)] underline hover:text-[var(--color-tron-text)]">Exit Preview</a>
			</div>
			<div class="flex flex-wrap gap-2">
				<button type="button" onclick={() => { previewStage = 'Loading'; previewLoadingSub = 'wax_prep'; }}
					class="rounded px-3 py-1.5 text-xs font-medium transition-colors {previewStage === 'Loading' && previewLoadingSub === 'wax_prep' ? 'bg-[var(--color-tron-cyan)] text-white' : 'border border-[var(--color-tron-border)] text-[var(--color-tron-text-secondary)] hover:border-[var(--color-tron-cyan)] hover:text-[var(--color-tron-cyan)]'}">
					1a. Wax Prep
				</button>
				<button type="button" onclick={() => { previewStage = 'Loading'; previewLoadingSub = 'deck_load'; }}
					class="rounded px-3 py-1.5 text-xs font-medium transition-colors {previewStage === 'Loading' && previewLoadingSub === 'deck_load' ? 'bg-[var(--color-tron-cyan)] text-white' : 'border border-[var(--color-tron-border)] text-[var(--color-tron-text-secondary)] hover:border-[var(--color-tron-cyan)] hover:text-[var(--color-tron-cyan)]'}">
					1b. Deck Load
				</button>
				<button type="button" onclick={() => { previewStage = 'Loading'; previewLoadingSub = 'ready_to_run'; }}
					class="rounded px-3 py-1.5 text-xs font-medium transition-colors {previewStage === 'Loading' && previewLoadingSub === 'ready_to_run' ? 'bg-[var(--color-tron-cyan)] text-white' : 'border border-[var(--color-tron-border)] text-[var(--color-tron-text-secondary)] hover:border-[var(--color-tron-cyan)] hover:text-[var(--color-tron-cyan)]'}">
					1c. Ready
				</button>
				<button type="button" onclick={() => { previewStage = 'Running'; }}
					class="rounded px-3 py-1.5 text-xs font-medium transition-colors {previewStage === 'Running' ? 'bg-[var(--color-tron-cyan)] text-white' : 'border border-[var(--color-tron-border)] text-[var(--color-tron-text-secondary)] hover:border-[var(--color-tron-cyan)] hover:text-[var(--color-tron-cyan)]'}">
					2. Running
				</button>
			</div>
		</div>
	{/if}

	{#if data.loadError}
		<div class="rounded-lg border border-amber-500/50 bg-amber-900/20 px-4 py-3 text-sm text-amber-300">
			<p class="font-medium">Connection issue — data may be stale</p>
			<p class="mt-1 text-xs text-amber-400/70">{data.loadError}</p>
			<button type="button" onclick={() => window.location.reload()}
				class="mt-2 rounded border border-amber-500/50 px-3 py-1.5 text-xs font-medium text-amber-300 hover:bg-amber-900/30">
				Retry
			</button>
		</div>
	{/if}

	{#if skippedNotice}
		<div class="rounded border border-amber-500/40 bg-amber-900/20 px-4 py-3 text-sm text-amber-200">
			<div class="flex items-start justify-between gap-3">
				<div class="min-w-0 flex-1">
					<p class="font-semibold text-amber-200">
						{skippedNotice.count} cartridge{skippedNotice.count === 1 ? ' was' : 's were'} skipped on "{skippedNotice.action}"
					</p>
					<p class="mt-1 text-xs text-amber-200/80">
						These carts are linked to an SPU run (or are otherwise terminal). The other carts in this batch were written normally — you can still Complete Run for them.
					</p>
					<div class="mt-2 grid grid-cols-1 gap-1 sm:grid-cols-2 lg:grid-cols-3">
						{#each skippedNotice.carts as sc (sc.cartridgeId)}
							<div class="rounded bg-amber-900/30 px-2 py-1 text-[11px]">
								<span class="font-mono">{sc.cartridgeId.slice(-12)}</span>
								<span class="ml-2 text-amber-200/70">{sc.status}</span>
							</div>
						{/each}
					</div>
				</div>
				<button type="button" class="shrink-0 text-amber-300 underline" onclick={() => { skippedNotice = null; }}>
					Dismiss
				</button>
			</div>
		</div>
	{/if}

	{#if errorMsg}
		<div data-error-banner class="rounded border border-red-500/30 bg-red-900/30 px-4 py-3 text-sm text-red-300">
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
					<button
						type="button"
						class="text-red-400 underline"
						onclick={() => { errorMsg = ''; pendingOverrideAction = ''; pendingOverrideData = {}; }}
					>
						Dismiss
					</button>
				</div>
			</div>
		</div>
	{/if}

	{#if !previewParam && !effectiveHasActiveRun && data.robotBlocked}
		<!-- Robot blocked by other process -->
		<div class="space-y-6 py-8">
			<div class="rounded-lg border border-amber-500/50 bg-amber-900/20 p-6 text-center">
				<p class="text-base font-semibold text-amber-300">Robot Busy</p>
				<p class="mt-2 text-sm text-amber-300/80">
					This robot is currently running reagent filling{data.robotBlocked.runId ? ` (${data.robotBlocked.runId})` : ''}.
					Complete or cancel the reagent run before starting wax filling.
				</p>
				<!-- eslint-disable svelte/no-navigation-without-resolve -->
				<a href="/manufacturing/cart-mfg/reagent-filling?robot={data.robotId}" class="mt-3 inline-block rounded border border-amber-500/50 px-4 py-2 text-sm text-amber-300 hover:bg-amber-900/30">
					Go to Reagent Filling
				</a>
				<!-- eslint-enable svelte/no-navigation-without-resolve -->
			</div>
		</div>
	{:else if !previewParam && !effectiveHasActiveRun}
		<!-- No active run yet: show the wax setup directly. Completing it creates
		     the run (deferred from robot-select so idle robots stay idle). -->
		<div class="space-y-6 py-8">
			<div class="text-center">
				<h2 class="text-xl font-semibold text-[var(--color-tron-text)]">
					{data.robotName} — Wax Filling
				</h2>
				<p class="mt-1 text-sm text-[var(--color-tron-text-secondary)]">
					Robot idle — complete wax setup to start a run.
				</p>
			</div>

			<div class="mx-auto max-w-2xl">
				<WaxPreparation
					waxLots={data.waxLots}
					waxPerCartridgeUl={data.settings.waxPerCartridgeUl}
					deadVolumeUl={data.settings.waxFillDeadVolumeUl}
					onComplete={handleWaxPrepComplete}
					readonly={false}
				/>
			</div>

			<div class="text-center">
				<a href="?preview" class="rounded border border-[var(--color-tron-orange)]/50 px-4 py-2 text-sm text-[var(--color-tron-orange)] hover:bg-[var(--color-tron-orange)]/10">
					Preview All Stages
				</a>
			</div>
		</div>
	{:else if !previewParam}
		<!-- Active run: show stage wizard -->
		<div class="space-y-6">
			<!-- Stage progress indicator with navigation arrows -->
			<div class="rounded-lg border border-[var(--color-tron-border)] bg-[var(--color-tron-surface)] p-4">
				<div class="mb-2 flex items-center justify-between">
					<span class="text-xs font-medium text-[var(--color-tron-text-secondary)]">
						Run {data.runState.runId}
					</span>
					<div class="flex items-center gap-3">
					<a href="/manufacturing/cart-mfg/reagent-filling?robot={data.robotId}" class="rounded border border-[var(--color-tron-cyan)]/40 bg-[var(--color-tron-cyan)]/10 px-2 py-0.5 text-xs font-medium text-[var(--color-tron-cyan)] hover:bg-[var(--color-tron-cyan)]/20">Move to Reagent Run →</a>
					<span class="text-xs text-[var(--color-tron-text-secondary)]">
						Stage {currentBubbleIndex + 1} of {TIMELINE.length}
					</span>
					<a href="?preview" class="rounded border border-[var(--color-tron-orange)]/40 px-2 py-0.5 text-xs text-[var(--color-tron-orange)] hover:bg-[var(--color-tron-orange)]/10">Preview</a>
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
					<!-- Left arrow -->
					<button
						type="button"
						disabled={viewStageIndex <= 0}
						onclick={() => { viewStageIndex = Math.max(0, viewStageIndex - 1); }}
						class="flex h-8 w-8 shrink-0 items-center justify-center rounded-full border border-[var(--color-tron-border)] text-[var(--color-tron-text-secondary)] transition-colors hover:border-[var(--color-tron-cyan)] hover:text-[var(--color-tron-cyan)] disabled:opacity-30 disabled:hover:border-[var(--color-tron-border)] disabled:hover:text-[var(--color-tron-text-secondary)]"
					>
						<svg class="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2">
							<path stroke-linecap="round" stroke-linejoin="round" d="M15 19l-7-7 7-7" />
						</svg>
					</button>

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

					<!-- Right arrow -->
					<button
						type="button"
						disabled={viewStageIndex >= currentStageIndex}
						onclick={() => { viewStageIndex = Math.min(currentStageIndex, viewStageIndex + 1); }}
						class="flex h-8 w-8 shrink-0 items-center justify-center rounded-full border border-[var(--color-tron-border)] text-[var(--color-tron-text-secondary)] transition-colors hover:border-[var(--color-tron-cyan)] hover:text-[var(--color-tron-cyan)] disabled:opacity-30 disabled:hover:border-[var(--color-tron-border)] disabled:hover:text-[var(--color-tron-text-secondary)]"
					>
						<svg class="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2">
							<path stroke-linecap="round" stroke-linejoin="round" d="M9 5l7 7-7 7" />
						</svg>
					</button>
				</div>
			</div>

			<!-- Back to Current Stage banner -->
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
			{/if}

			<!-- Incubator Tube Info (visible during Loading through QC) -->
			{#if data.tubeData && data.runState.stage && ['Loading', 'Running', 'Awaiting Removal', 'Cooling', 'QC', 'Storage'].includes(data.runState.stage)}
				{@const pct = data.tubeData.initialVolumeUl > 0 ? (data.tubeData.remainingVolumeUl / data.tubeData.initialVolumeUl) * 100 : 0}
				{@const barColor = pct > 50 ? 'bg-green-500' : pct > 25 ? 'bg-amber-500' : 'bg-red-500'}
				{@const maxCartridges = Math.floor(data.tubeData.remainingVolumeUl / 50)}
				<div class="rounded-lg border border-[var(--color-tron-border)] bg-[var(--color-tron-surface)] p-4">
					<div class="mb-2 flex items-center justify-between">
						<h3 class="text-sm font-semibold text-[var(--color-tron-cyan)]">Incubator Tube</h3>
						<span class="font-mono text-xs text-[var(--color-tron-text)]">{data.tubeData.tubeId}</span>
					</div>
					<div class="mb-3 grid grid-cols-4 gap-3 text-center">
						<div>
							<p class="text-[10px] text-[var(--color-tron-text-secondary)]">Remaining</p>
							<p class="text-sm font-bold text-[var(--color-tron-text)]">{data.tubeData.remainingVolumeUl}µL</p>
						</div>
						<div>
							<p class="text-[10px] text-[var(--color-tron-text-secondary)]">Initial</p>
							<p class="text-sm text-[var(--color-tron-text-secondary)]">{data.tubeData.initialVolumeUl}µL</p>
						</div>
						<div>
							<p class="text-[10px] text-[var(--color-tron-text-secondary)]">Cartridges Filled</p>
							<p class="text-sm font-bold text-[var(--color-tron-text)]">{data.tubeData.totalCartridgesFilled}</p>
						</div>
						<div>
							<p class="text-[10px] text-[var(--color-tron-text-secondary)]">Runs Used</p>
							<p class="text-sm font-bold text-[var(--color-tron-text)]">{data.tubeData.totalRunsUsed}</p>
						</div>
					</div>
					<!-- Volume bar -->
					<div class="h-3 w-full overflow-hidden rounded-full bg-[var(--color-tron-border)]">
						<div class="h-full rounded-full transition-all {barColor}" style="width: {pct}%"></div>
					</div>
					<div class="mt-1 flex justify-between text-[10px] text-[var(--color-tron-text-secondary)]">
						<span>{pct.toFixed(0)}% remaining</span>
						<span class="tron-badge text-[10px] {data.tubeData.status === 'Active' ? 'tron-badge-success' : data.tubeData.status === 'Depleted' ? 'tron-badge-error' : 'tron-badge-neutral'}">{data.tubeData.status}</span>
					</div>
					{#if maxCartridges < 48}
						<div class="mt-2 rounded border border-amber-500/30 bg-amber-900/20 px-3 py-1.5 text-xs text-amber-300">
							Tube running low — ~{maxCartridges} cartridges remaining
						</div>
					{/if}
				</div>
			{/if}

			</div>
	{/if}

	<!-- Stage content: always rendered (not destroyed during submission) -->
	{#if displayStage}
	<div class="relative">
		{#if submitting && !previewParam}
			<div class="absolute inset-0 z-10 flex items-center justify-center rounded-lg bg-black/30">
				<div class="rounded-lg bg-[var(--color-tron-surface)] p-4 text-center shadow-lg">
					<div class="mx-auto mb-3 h-8 w-8 animate-spin rounded-full border-2 border-[var(--color-tron-cyan)] border-t-transparent"></div>
					<p class="text-sm text-[var(--color-tron-text-secondary)]">Processing...</p>
					{#if submittingTooLong}
						<button
							type="button"
							onclick={forceReload}
							class="mt-4 rounded-lg border border-[var(--color-tron-orange)]/50 bg-[var(--color-tron-orange)]/10 px-4 py-2 text-sm font-medium text-[var(--color-tron-orange)] transition-colors hover:bg-[var(--color-tron-orange)]/20"
						>
							Taking too long? Force Reload
						</button>
					{/if}
				</div>
			</div>
		{/if}
		{#if displayStage === 'Loading' && displayLoadingSub === 'wax_prep'}
			<WaxPreparation
				waxLots={data.waxLots}
				waxPerCartridgeUl={data.settings.waxPerCartridgeUl}
				deadVolumeUl={data.settings.waxFillDeadVolumeUl}
				onComplete={handleWaxPrepComplete}
				readonly={isPreviewOrPast}
			/>
		{:else if displayStage === 'Loading' && displayLoadingSub === 'ready_to_run'}
			<!-- Deck loaded, ready to start run -->
			<div class="space-y-4">
				<div class="flex items-center gap-3 rounded-lg border border-green-500/40 bg-green-900/10 p-4">
					<div class="flex h-10 w-10 flex-shrink-0 items-center justify-center rounded-full bg-green-900/30 text-green-400">
						<svg class="h-6 w-6" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2">
							<path stroke-linecap="round" stroke-linejoin="round" d="M5 13l4 4L19 7" />
						</svg>
					</div>
					<div>
						<h3 class="text-sm font-semibold text-[var(--color-tron-text)]">
							Deck Loaded
						</h3>
						<p class="text-xs text-[var(--color-tron-text-secondary)]">
							Deck {previewParam ? 'DECK-PREVIEW' : data.runState.deckId} ·
							{data.runState.plannedCartridgeCount ?? '?'} cartridges
						</p>
					</div>
				</div>

				{#if !isPreviewOrPast && data.opentronsRobotId && data.robotProtocols}
									<label class="mb-2 flex items-center gap-2 text-xs text-[var(--color-tron-text-secondary)]">
					<input type="checkbox" bind:checked={testFillNoCarts} class="accent-amber-400" />
					Test fill — no cartridges tracked (calibration/tuning only; nothing will be marked wax filled)
				</label>
				<ProtocolStartPanel
						robot={{ _id: data.opentronsRobotId, name: data.robotName }}
						protocols={data.robotProtocols}
						contextValues={{ ...WAX_PARAM_DEFAULTS, cartridges: data.runState.plannedCartridgeCount ?? 24 }}
						contextReadonly={['cartridges']}
						lastTipState={data.lastTipState}
						submitting={submitting}
						formAction="?/startRun"
						extraHidden={{ runId: data.runState.runId ?? '', ...(testFillNoCarts ? { testFillNoCartridges: 'true' } : {}) }}
						autoStart={autoStartPending}
						onAutoStarted={() => (autoStartPending = false)}
					/>

					<div class="flex justify-center">
						<button
							type="button"
							onclick={handleResetToLoading}
							disabled={submitting}
							class="rounded border border-amber-500/40 px-4 py-2 text-xs text-amber-400 transition-colors hover:border-amber-500 hover:bg-amber-900/20 disabled:opacity-50"
						>
							↩ Reset to Deck Loading
						</button>
					</div>
				{/if}
			</div>
		{:else if displayStage === 'Loading' && displayLoadingSub === 'params'}
			<!-- Protocol parameters BEFORE barcode scanning: configure the run now,
			     then walk away during the scan — it starts automatically with these
			     values (instead of run-start params getting skipped by auto-start). -->
			{#if !isPreviewOrPast && data.opentronsRobotId && data.robotProtocols}
				<div class="space-y-4">
					<div class="rounded-lg border border-[var(--color-tron-border)] bg-[var(--color-tron-surface)] p-4">
						<h3 class="text-sm font-semibold text-[var(--color-tron-text)]">Set protocol parameters</h3>
						<p class="mt-1 text-xs text-[var(--color-tron-text-secondary)]">
							Configure the run now. After you continue, scanning the deck + cartridges starts the run automatically with these values — you can walk away.
						</p>
					</div>
									<label class="mb-2 flex items-center gap-2 text-xs text-[var(--color-tron-text-secondary)]">
					<input type="checkbox" bind:checked={testFillNoCarts} class="accent-amber-400" />
					Test fill — no cartridges tracked (calibration/tuning only; nothing will be marked wax filled)
				</label>
				<ProtocolStartPanel
						robot={{ _id: data.opentronsRobotId, name: data.robotName }}
						protocols={data.robotProtocols}
						contextValues={{ ...WAX_PARAM_DEFAULTS, cartridges: data.runState.plannedCartridgeCount ?? 24 }}
						contextReadonly={['cartridges']}
						lastTipState={data.lastTipState}
						submitting={submitting}
						formAction="?/startRun"
						extraHidden={{ runId: data.runState.runId ?? '', ...(testFillNoCarts ? { testFillNoCartridges: 'true' } : {}) }}
						submitLabel="Save & continue to barcode scan →"
						onSubmitIntercept={handleParamsConfirmed}
					/>
				</div>
			{:else}
				<div class="rounded-lg border border-amber-500/40 bg-amber-900/10 p-4 text-sm text-amber-300">
					No protocol parameters to set for this robot.
					<button type="button" class="ml-2 underline" onclick={() => (paramsReady = true)}>Continue to scan →</button>
				</div>
			{/if}
		{:else if displayStage === 'Loading' && displayLoadingSub === 'deck_load'}

			{#if !USE_GRID_PRIMARY && !isPreviewOrPast && data.opentronsRobotId && data.robotProtocols}
				<!-- Legacy one-button orchestration (hidden — USE_GRID_PRIMARY).
				     The grid-primary else branch below is the live deck-load flow. -->
				<div class="mb-4 space-y-4">
					<div class="rounded-lg border border-[var(--color-tron-border)] bg-[var(--color-tron-surface)] p-4">
						<h3 class="text-sm font-semibold text-[var(--color-tron-text)]">
							Start Run — the robot will scan the deck and cartridges first
						</h3>
						<p class="mt-1 text-xs text-[var(--color-tron-text-secondary)]">
							Press Start Run below. The gantry scanner reads the deck barcode, sweeps every cartridge slot, records the deck load, then starts the protocol.
						</p>
					</div>

					{#if orchSteps.length > 0}
						<div class="space-y-3 rounded-lg border border-[var(--color-tron-border)] bg-[var(--color-tron-surface)] p-4">
							{#each orchSteps as step (step.id)}
								<div class="flex items-start gap-3">
									<div class="mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center">
										{#if step.status === 'done'}
											<span class="text-sm font-bold text-green-400">✓</span>
										{:else if step.status === 'failed'}
											<span class="text-sm font-bold text-red-400">✗</span>
										{:else if step.status === 'active'}
											<div class="h-4 w-4 animate-spin rounded-full border-2 border-[var(--color-tron-cyan)] border-t-transparent"></div>
										{:else}
											<span class="h-2.5 w-2.5 rounded-full border border-[var(--color-tron-border)]"></span>
										{/if}
									</div>
									<div class="min-w-0 flex-1">
										<p class="text-sm font-medium {step.status === 'failed'
											? 'text-red-300'
											: step.status === 'done'
												? 'text-green-400'
												: step.status === 'active'
													? 'text-[var(--color-tron-cyan)]'
													: 'text-[var(--color-tron-text-secondary)]'}">
											{step.label}
										</p>
										{#if step.detail}
											<p class="text-xs {step.status === 'failed' ? 'text-red-400/80' : 'text-[var(--color-tron-text-secondary)]'}">
												{step.detail}
											</p>
										{/if}
									</div>
								</div>
							{/each}
						</div>
					{/if}

									<label class="mb-2 flex items-center gap-2 text-xs text-[var(--color-tron-text-secondary)]">
					<input type="checkbox" bind:checked={testFillNoCarts} class="accent-amber-400" />
					Test fill — no cartridges tracked (calibration/tuning only; nothing will be marked wax filled)
				</label>
				<ProtocolStartPanel
						robot={{ _id: data.opentronsRobotId, name: data.robotName }}
						protocols={data.robotProtocols}
						contextValues={{ ...WAX_PARAM_DEFAULTS, cartridges: data.runState.plannedCartridgeCount ?? 24 }}
						contextReadonly={['cartridges']}
						lastTipState={data.lastTipState}
						submitting={submitting || orchestrating}
						formAction="?/startRun"
						extraHidden={{ runId: data.runState.runId ?? '', ...(testFillNoCarts ? { testFillNoCartridges: 'true' } : {}) }}
						onSubmitIntercept={handleScanAndStart}
					/>
				</div>

				<details bind:open={manualFallbackOpen} class="rounded-lg border border-[var(--color-tron-border)] bg-[var(--color-tron-surface)]">
					<summary class="cursor-pointer px-4 py-3 text-sm font-medium text-[var(--color-tron-text-secondary)] transition-colors hover:text-[var(--color-tron-text)]">
						Manual scanning (fallback)
					</summary>
					<div class="border-t border-[var(--color-tron-border)] p-4">
						<DeckLoadingGrid
							availableLots={[{ lotId: 'backed-cartridges', ready: true, cartridgeCount: 24 }]}
							plannedCartridgeCount={data.runState.plannedCartridgeCount}
							onComplete={handleDeckLoadComplete}
							readonly={isPreviewOrPast}
							suppressFocus={showCancelModal || showOverrideModal || !manualFallbackOpen}
							robotId={data.robotId}
							runId={data.runState.runId ?? null}
						/>
					</div>
				</details>
			{:else}
				<!-- Preview/past view, or robot has no OT-2 protocols mapped —
				     the manual grid stays the primary flow. -->
				<DeckLoadingGrid
					availableLots={[{ lotId: previewParam ? 'LOT-PREVIEW' : 'backed-cartridges', ready: true, cartridgeCount: 24 }]}
					plannedCartridgeCount={previewParam ? 24 : data.runState.plannedCartridgeCount}
					onComplete={handleDeckLoadComplete}
					readonly={isPreviewOrPast}
					suppressFocus={showCancelModal || showOverrideModal}
					robotId={data.robotId}
					runId={data.runState.runId ?? null}
				/>
			{/if}
		{:else if displayStage === 'Running'}
			{#if !isPreviewOrPast && data.runState.opentronsRunId && data.opentronsRobotId}
				<EmbeddedRunController
					robotId={data.opentronsRobotId}
					robotName={data.robotName}
					opentronsRunId={data.runState.opentronsRunId}
					onComplete={async (status) => {
						// Stamp pipetteTipState.after + consumed. A clean completion
						// ALSO auto-advances every cart to wax_filled and completes
						// the run server-side (2026-08-28) — no deck-removed step.
						runFinishedLocal = true;
						await submitAction('recordRunFinished', {
							runId: data.runState.runId ?? '',
							finalStatus: status
						});
						if (status === 'succeeded') await invalidateAll();
					}}
				/>
				{#if !runFinishedLocal}
					<div class="mt-3 rounded-lg border border-amber-500/40 bg-amber-900/10 p-4">
						<div class="flex flex-wrap items-center justify-between gap-3">
							<div>
								<h3 class="text-sm font-semibold text-amber-200">Tip problem? Swap the tip without losing your place</h3>
								<p class="mt-1 text-xs text-amber-200/80">
									The robot finishes nothing further with the current tip: it empties it back into the wax tube, swaps the tip,
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
							<p class="mt-2 text-xs text-emerald-300">Requested. The robot will stop before its next well, drop the tip, pick a fresh one from the rack, calibrate it and continue. If the run is paused, press Resume.</p>
						{:else if tipSwapStatus === 'hand'}
							<p class="mt-2 text-xs text-emerald-300">Requested. The robot will stop before its next well, raise the pipette over the calibrator and pause — pull the old tip off, push a new one on, then press Resume. It calibrates the new tip and continues. If the run is paused now, press Resume first so it can reach that point.</p>
						{:else if tipSwapStatus === 'cancelled'}
							<p class="mt-2 text-xs text-[var(--color-tron-text-secondary)]">Request cancelled (only if the robot hadn't acted on it yet).</p>
						{:else if tipSwapStatus === 'error'}
							<p class="mt-2 text-xs text-red-300">Could not send the request to the robot bridge — try again, or Pause and swap the tip when the run reaches its next tip change.</p>
						{/if}
					</div>
				{/if}
			{/if}
			<RunExecution
				runId={previewParam ? 'WXR-PREVIEW' : (data.runState.runId ?? '')}
				serverRunStartTime={previewParam ? new Date() : (data.runState.runStartTime ? new Date(data.runState.runStartTime) : null)}
				runFinished={previewParam ? true : runFinished}
				fridges={data.fridges}
				onDeckRemoved={handleDeckRemoved}
				onAborted={handleAborted}
				readonly={isPreviewOrPast}
			/>
		{/if}
	</div>
	{/if}

	<!-- Cancel Run Modal -->
	{#if showCancelModal}
		<div class="fixed inset-0 z-50 flex items-center justify-center bg-black/60">
			<div class="mx-4 w-full max-w-md rounded-lg border border-[var(--color-tron-border)] bg-[var(--color-tron-surface)] p-6 shadow-xl">
				<h3 class="text-lg font-semibold text-[var(--color-tron-text)]">Cancel Run</h3>
				<p class="mt-2 text-sm text-[var(--color-tron-text-secondary)]">
					Are you sure you want to cancel run {data.runState.runId}? This action cannot be undone.
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
						onclick={handleCancelRun}
						disabled={!cancelReason.trim() || submitting}
						class="rounded-lg bg-red-600 px-4 py-2 text-sm font-semibold text-white transition-colors hover:bg-red-700 disabled:opacity-50"
					>
						{submitting ? 'Cancelling...' : 'Confirm Cancel'}
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
							submitAction(pendingOverrideAction, {
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
</div>
