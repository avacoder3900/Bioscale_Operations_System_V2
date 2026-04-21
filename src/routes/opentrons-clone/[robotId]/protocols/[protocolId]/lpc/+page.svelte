<script lang="ts">
	import { onDestroy, onMount } from 'svelte';
	import { goto } from '$app/navigation';

	let { data } = $props();

	type WizardPhase =
		| 'idle'
		| 'initializing'
		| 'init-error'
		| 'attach-tip'
		| 'measure'
		| 'review'
		| 'ending'
		| 'ended';

	type AnalysisLabware = {
		id: string;
		loadName: string;
		displayName?: string | null;
		definitionUri: string;
		location?: { slotName?: string | null };
	};

	type Offset = {
		analysisLabwareId: string;
		definitionUri: string;
		slotName: string;
		loadName: string;
		displayName: string;
		vector: { x: number; y: number; z: number };
	};

	const a = data.latestAnalysis;
	const requiredPipettes = ((a?.pipettes ?? []) as Array<{
		id?: string;
		mount?: string;
		pipetteName?: string;
	}>).filter(
		(p) => (p.mount === 'left' || p.mount === 'right') && typeof p.pipetteName === 'string'
	) as Array<{ id?: string; mount: 'left' | 'right'; pipetteName: string }>;

	const slotLabware: AnalysisLabware[] = ((a?.labware ?? []) as AnalysisLabware[]).filter(
		(lw) => typeof lw.location?.slotName === 'string' && (lw.location!.slotName as string).length > 0
	);

	// Tip racks vs everything else. LPC picks up a tip from one tiprack and then
	// measures every non-tiprack labware. Tip racks themselves are not measured
	// (can't moveToWell A1 of a tiprack while holding a tip without crashing).
	function isTipRack(lw: AnalysisLabware): boolean {
		return /tiprack/i.test(lw.loadName);
	}
	const tipRacks = slotLabware.filter(isTipRack);
	const measureTargets = slotLabware.filter((lw) => !isTipRack(lw));

	const analysisPending = a ? a.status === 'pending' : false;
	const analysisHasErrors = (a?.errors?.length ?? 0) > 0;
	const analysisReady = !!a && !analysisPending && !analysisHasErrors;
	const canStart =
		data.online &&
		analysisReady &&
		data.instrumentsReachable &&
		requiredPipettes.length > 0 &&
		tipRacks.length > 0 &&
		measureTargets.length > 0;

	// --------------------------------------------------------------------------
	// Wizard state
	// --------------------------------------------------------------------------
	let phase = $state<WizardPhase>('idle');
	let mrId = $state<string | null>(null);
	let runtimePipetteId = $state<string | null>(null);
	/** analysis labware id → runtime labware id (as the maintenance run sees it). */
	let runtimeLabwareIds = $state<Record<string, string>>({});
	let lpcPipette = $state<{ mount: 'left' | 'right'; pipetteName: string } | null>(null);
	let selectedTipRackId = $state<string>('');
	let measureIdx = $state(0);
	let initialPos = $state<{ x: number; y: number; z: number } | null>(null);
	// Jog step size in mm. Presets (0.1 / 1) are the common case; the
	// operator can also type an exact amount. Safety-capped in the input.
	const JOG_MIN_MM = 0.01;
	const JOG_MAX_MM = 5;
	let jogStep = $state<number>(1);
	let offsets = $state<Record<string, Offset>>({});
	let busy = $state(false);
	let errorMsg = $state<string | null>(null);
	let busyLabel = $state<string>('');

	// --------------------------------------------------------------------------
	// Server command helpers
	// --------------------------------------------------------------------------
	const robotId = data.robot._id;

	async function createSession(): Promise<string> {
		const res = await fetch(`/api/opentrons-clone/robots/${robotId}/maintenance`, {
			method: 'POST'
		});
		if (!res.ok) {
			const body = await res.json().catch(() => ({}));
			throw new Error(body?.error || `Failed to create maintenance run (${res.status})`);
		}
		const body = await res.json();
		const id = body?.data?.id;
		if (!id) throw new Error('Maintenance run response missing id');
		return id;
	}

	async function endSession(id: string): Promise<void> {
		try {
			await fetch(
				`/api/opentrons-clone/robots/${robotId}/maintenance?id=${encodeURIComponent(id)}`,
				{ method: 'DELETE' }
			);
		} catch {
			// swallow — tear-down is best-effort
		}
	}

	async function sendCommand(
		runId: string,
		payload: Record<string, unknown>,
		timeoutMs?: number
	): Promise<Record<string, unknown>> {
		const url = timeoutMs
			? `/api/opentrons-clone/robots/${robotId}/maintenance/${encodeURIComponent(runId)}/command?timeoutMs=${timeoutMs}`
			: `/api/opentrons-clone/robots/${robotId}/maintenance/${encodeURIComponent(runId)}/command`;
		const res = await fetch(url, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify(payload)
		});
		if (!res.ok) {
			const body = await res.json().catch(() => ({}));
			throw new Error(body?.error || `Command ${payload.commandType} failed (${res.status})`);
		}
		const body = await res.json();
		const result = (body?.data as { result?: Record<string, unknown> } | undefined)?.result ?? {};
		return result;
	}

	function parseDefinitionUri(uri: string): { namespace: string; loadName: string; version: number } {
		const parts = uri.split('/');
		if (parts.length !== 3) throw new Error(`Unexpected definitionUri: ${uri}`);
		const version = parseInt(parts[2], 10);
		if (!Number.isFinite(version)) throw new Error(`Unexpected version in definitionUri: ${uri}`);
		return { namespace: parts[0], loadName: parts[1], version };
	}

	async function registerLabwareDef(runId: string, definition: unknown): Promise<void> {
		const res = await fetch(
			`/api/opentrons-clone/robots/${robotId}/maintenance/${encodeURIComponent(runId)}/labware-definitions`,
			{
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify(definition)
			}
		);
		if (!res.ok) {
			const body = await res.json().catch(() => ({}));
			throw new Error(body?.error || `Failed to register labware definition (${res.status})`);
		}
	}

	// --------------------------------------------------------------------------
	// Wizard actions
	// --------------------------------------------------------------------------
	async function startWizard() {
		if (!canStart) return;
		errorMsg = null;
		phase = 'initializing';
		busy = true;
		busyLabel = 'Creating maintenance run';
		let createdId: string | null = null;
		try {
			createdId = await createSession();
			mrId = createdId;

			// Home every axis before any coordinated motion. The OT-2 refuses
			// savePosition / moveToWell if ANY axis is in an unknown position,
			// including axes of the pipette we're not measuring with. Without
			// this, the wizard errors on the very first savePosition with
			// MustHomeError for the unused mount's plunger.
			busyLabel = 'Homing robot';
			await sendCommand(createdId, { commandType: 'home', params: {} }, 60_000);

			// Load the first protocol pipette — LPC uses one "measuring" pipette.
			// Multi-pipette protocols still get offsets from one pass; operators can
			// rerun LPC after swapping the primary.
			const pip = requiredPipettes[0];
			lpcPipette = { mount: pip.mount, pipetteName: pip.pipetteName };
			busyLabel = `Loading ${pip.pipetteName} on ${pip.mount}`;
			const pipRes = await sendCommand(createdId, {
				commandType: 'loadPipette',
				params: { mount: pip.mount, pipetteName: pip.pipetteName }
			});
			const pipId = (pipRes as { pipetteId?: string }).pipetteId;
			if (!pipId) throw new Error('loadPipette did not return a pipetteId');
			runtimePipetteId = pipId;

			// Register any custom (non-standard) labware definitions onto the
			// maintenance session first. Without this, loadLabware for a
			// Brevitest cartridge / wax tray etc. will fail — the session
			// only knows standard Opentrons labware out of the box.
			const customDefs = (data as { customLabwareDefs?: Record<string, unknown> }).customLabwareDefs ?? {};
			for (const lw of slotLabware) {
				const def = customDefs[lw.definitionUri];
				if (!def) continue;
				busyLabel = `Registering labware ${lw.loadName}`;
				await registerLabwareDef(createdId, def);
			}

			// Load every slot-based labware the protocol uses so we can moveToWell.
			for (const lw of slotLabware) {
				busyLabel = `Loading ${lw.loadName} in slot ${lw.location?.slotName}`;
				const { namespace, loadName, version } = parseDefinitionUri(lw.definitionUri);
				const lwRes = await sendCommand(createdId, {
					commandType: 'loadLabware',
					params: {
						location: { slotName: lw.location!.slotName },
						loadName,
						namespace,
						version,
						displayName: lw.displayName ?? undefined
					}
				});
				const lwId = (lwRes as { labwareId?: string }).labwareId;
				if (!lwId) throw new Error(`loadLabware did not return a labwareId for ${lw.loadName}`);
				runtimeLabwareIds[lw.id] = lwId;
			}

			selectedTipRackId = tipRacks[0]?.id ?? '';
			phase = 'attach-tip';
		} catch (e) {
			errorMsg = (e as Error).message;
			phase = 'init-error';
			if (createdId) {
				await endSession(createdId);
				mrId = null;
			}
		} finally {
			busy = false;
			busyLabel = '';
		}
	}

	async function attachTip() {
		if (!mrId || !runtimePipetteId || !selectedTipRackId) return;
		const tiprackRuntime = runtimeLabwareIds[selectedTipRackId];
		if (!tiprackRuntime) {
			errorMsg = 'Selected tip rack not loaded in maintenance session';
			return;
		}
		errorMsg = null;
		busy = true;
		busyLabel = 'Picking up tip';
		try {
			await sendCommand(mrId, {
				commandType: 'pickUpTip',
				params: {
					pipetteId: runtimePipetteId,
					labwareId: tiprackRuntime,
					wellName: 'A1'
				}
			});
			await enterMeasure(0);
		} catch (e) {
			errorMsg = (e as Error).message;
		} finally {
			busy = false;
			busyLabel = '';
		}
	}

	async function enterMeasure(idx: number) {
		if (!mrId || !runtimePipetteId) return;
		const target = measureTargets[idx];
		if (!target) return;
		const runtimeId = runtimeLabwareIds[target.id];
		if (!runtimeId) throw new Error(`Runtime labware id missing for ${target.loadName}`);
		busy = true;
		busyLabel = `Moving to slot ${target.location?.slotName} (${target.loadName})`;
		try {
			await sendCommand(mrId, {
				commandType: 'moveToWell',
				params: {
					pipetteId: runtimePipetteId,
					labwareId: runtimeId,
					wellName: 'A1',
					wellLocation: { origin: 'top', offset: { x: 0, y: 0, z: 0 } },
					forceDirect: false
				}
			});
			const savedRaw = await sendCommand(mrId, {
				commandType: 'savePosition',
				params: { pipetteId: runtimePipetteId }
			});
			const position = (savedRaw as { position?: { x: number; y: number; z: number } }).position;
			if (!position) throw new Error('savePosition did not return a position');
			initialPos = { ...position };
			measureIdx = idx;
			phase = 'measure';
		} catch (e) {
			errorMsg = (e as Error).message;
		} finally {
			busy = false;
			busyLabel = '';
		}
	}

	async function jog(axis: 'x' | 'y' | 'z', sign: 1 | -1) {
		if (!mrId || !runtimePipetteId || busy) return;
		errorMsg = null;
		// Runtime-clamp in case the input bypassed the min/max attributes
		// (pasted number, programmatic change, whatever). Belt-and-suspenders
		// on top of the input's min/max=0.01..5.
		const step = Math.max(JOG_MIN_MM, Math.min(JOG_MAX_MM, Number(jogStep) || 0));
		if (step === 0) return;
		busy = true;
		busyLabel = `Jog ${axis.toUpperCase()}${sign > 0 ? '+' : '-'}${step} mm`;
		try {
			await sendCommand(mrId, {
				commandType: 'moveRelative',
				params: { pipetteId: runtimePipetteId, axis, distance: sign * step }
			});
		} catch (e) {
			errorMsg = (e as Error).message;
		} finally {
			busy = false;
			busyLabel = '';
		}
	}

	async function safeLiftZ() {
		if (!mrId || !lpcPipette || busy) return;
		errorMsg = null;
		busy = true;
		busyLabel = 'Homing Z axis';
		try {
			const motorAxis = lpcPipette.mount === 'left' ? 'leftZ' : 'rightZ';
			await sendCommand(mrId, {
				commandType: 'home',
				params: { axes: [motorAxis] }
			});
		} catch (e) {
			errorMsg = (e as Error).message;
		} finally {
			busy = false;
			busyLabel = '';
		}
	}

	async function abortCurrentMeasure() {
		// AC #5: Home Z discards the in-progress uncommitted position; operator
		// re-approaches from scratch by re-entering the same index.
		if (!mrId || phase !== 'measure') return;
		await safeLiftZ();
		await enterMeasure(measureIdx);
	}

	async function saveAndContinue() {
		if (!mrId || !runtimePipetteId || !initialPos) return;
		const target = measureTargets[measureIdx];
		if (!target) return;
		errorMsg = null;
		busy = true;
		busyLabel = 'Saving position';
		try {
			const savedRaw = await sendCommand(mrId, {
				commandType: 'savePosition',
				params: { pipetteId: runtimePipetteId }
			});
			const finalPos = (savedRaw as { position?: { x: number; y: number; z: number } }).position;
			if (!finalPos) throw new Error('savePosition did not return a position');
			const vector = {
				x: +(finalPos.x - initialPos.x).toFixed(3),
				y: +(finalPos.y - initialPos.y).toFixed(3),
				z: +(finalPos.z - initialPos.z).toFixed(3)
			};
			offsets[target.id] = {
				analysisLabwareId: target.id,
				definitionUri: target.definitionUri,
				slotName: target.location!.slotName as string,
				loadName: target.loadName,
				displayName: target.displayName ?? target.loadName,
				vector
			};

			// Safe-lift Z before arc-move to next labware so a wrong XY doesn't
			// drag the tip across the deck surface.
			const motorAxis = lpcPipette?.mount === 'left' ? 'leftZ' : 'rightZ';
			await sendCommand(mrId, {
				commandType: 'home',
				params: { axes: [motorAxis] }
			});

			const nextIdx = measureIdx + 1;
			if (nextIdx >= measureTargets.length) {
				await finishAndReview();
			} else {
				await enterMeasure(nextIdx);
			}
		} catch (e) {
			errorMsg = (e as Error).message;
		} finally {
			busy = false;
			busyLabel = '';
		}
	}

	async function finishAndReview() {
		if (!mrId || !runtimePipetteId || !selectedTipRackId) {
			phase = 'review';
			return;
		}
		const tiprackRuntime = runtimeLabwareIds[selectedTipRackId];
		busy = true;
		busyLabel = 'Returning tip';
		try {
			if (tiprackRuntime) {
				// Best-effort: drop tip back to the source tip rack's A1 so the
				// operator can re-pick it on a subsequent rerun. Failures here are
				// non-fatal — we still want to advance to review.
				try {
					await sendCommand(mrId, {
						commandType: 'dropTip',
						params: {
							pipetteId: runtimePipetteId,
							labwareId: tiprackRuntime,
							wellName: 'A1'
						}
					});
				} catch {
					// ignore — tip is still attached, operator will notice
				}
			}
		} finally {
			busy = false;
			busyLabel = '';
		}
		phase = 'ending';
		busy = true;
		busyLabel = 'Ending maintenance run';
		try {
			await endSession(mrId);
		} finally {
			mrId = null;
			busy = false;
			busyLabel = '';
		}
		phase = 'review';
	}

	function back() {
		if (phase !== 'measure' || measureIdx === 0) return;
		const prev = measureIdx - 1;
		// Discard any previously recorded offset for the prior labware so it is
		// re-measured on save.
		const prevTarget = measureTargets[prev];
		if (prevTarget) delete offsets[prevTarget.id];
		enterMeasure(prev);
	}

	async function cancelWizard(opts: { silent?: boolean } = {}) {
		if (!opts.silent && !confirm('Discard LPC in progress?')) return;
		if (mrId) {
			busy = true;
			busyLabel = 'Ending maintenance run';
			try {
				await endSession(mrId);
			} finally {
				mrId = null;
				busy = false;
				busyLabel = '';
			}
		}
		if (!opts.silent) {
			goto(`/opentrons-clone/${robotId}/protocols/${data.protocolId}`);
		}
	}

	function applyOffsetsAndReturn() {
		const collected = Object.values(offsets);
		if (collected.length === 0) {
			// Nothing to apply — just return.
			goto(`/opentrons-clone/${robotId}/protocols/${data.protocolId}`);
			return;
		}
		// LegacyLabwareOffsetCreate shape — slotName-only location.
		const payload = collected.map((o) => ({
			definitionUri: o.definitionUri,
			location: { slotName: o.slotName },
			vector: o.vector
		}));
		try {
			sessionStorage.setItem(
				`ot_lpc_offsets:${data.protocolId}`,
				JSON.stringify(payload)
			);
		} catch {
			// If sessionStorage is unavailable (incognito quirks) the handoff
			// just doesn't happen; the operator can re-run LPC.
		}
		goto(`/opentrons-clone/${robotId}/protocols/${data.protocolId}?lpc=applied`);
	}

	// --------------------------------------------------------------------------
	// Tear-down safety net — beforeunload / component unmount
	// --------------------------------------------------------------------------
	function beforeUnloadTearDown() {
		if (!mrId) return;
		const url = `/api/opentrons-clone/robots/${robotId}/maintenance?id=${encodeURIComponent(mrId)}`;
		try {
			fetch(url, { method: 'DELETE', keepalive: true });
		} catch {
			// ignore
		}
	}

	onMount(() => {
		window.addEventListener('beforeunload', beforeUnloadTearDown);
		// Per PRD §7.5 AC #1: auto-create the maintenance run on page load
		// when prerequisites are met. If prereqs aren't met (offline robot,
		// pending analysis, analysis errors), stay in 'idle' so the gating
		// message renders — operator fixes the upstream problem first.
		if (canStart && phase === 'idle') {
			void startWizard();
		}
	});
	onDestroy(() => {
		if (typeof window !== 'undefined') {
			window.removeEventListener('beforeunload', beforeUnloadTearDown);
		}
		// If the component unmounts mid-wizard (e.g. user navigates via the back
		// button before hitting Cancel), tear the session down too.
		if (mrId) {
			void cancelWizard({ silent: true });
		}
	});

	const currentTarget = $derived(measureTargets[measureIdx]);
	const completedCount = $derived(Object.keys(offsets).length);
	const mainFile = data.protocol?.files?.find((f: any) => f.role === 'main')?.name ?? 'Protocol';
</script>

<div class="mb-4 flex items-center justify-between">
	<div>
		<a
			href={`/opentrons-clone/${robotId}/protocols/${data.protocolId}`}
			class="text-sm text-blue-600 hover:underline"
		>
			← Back to protocol
		</a>
		<h2 class="text-xl font-semibold mt-1">Labware Position Check</h2>
		<p class="text-xs text-gray-400 break-all">{mainFile}</p>
	</div>
	<span class="text-xs {data.online ? 'text-green-600' : 'text-red-600'}">
		{data.online ? 'Live' : 'Robot offline'}
	</span>
</div>

{#if errorMsg}
	<div class="bg-red-50 border border-red-300 text-red-900 rounded p-2 mb-3 text-sm whitespace-pre-wrap">
		{errorMsg}
	</div>
{/if}

{#if busy}
	<div class="bg-blue-50 border border-blue-200 text-blue-900 rounded p-2 mb-3 text-sm">
		⏳ {busyLabel || 'Working…'}
	</div>
{/if}

{#if phase === 'idle' || phase === 'init-error'}
	<section class="bg-white border rounded-lg p-4 mb-4">
		<h3 class="font-semibold mb-2">Pre-flight</h3>
		{#if !a}
			<p class="text-sm text-red-700">No analysis available — upload or re-analyze the protocol first.</p>
		{:else if analysisPending}
			<p class="text-sm text-gray-500">Analysis is still pending. Refresh shortly.</p>
		{:else if analysisHasErrors}
			<p class="text-sm text-red-700">Analysis has errors; LPC cannot be run.</p>
		{:else if !data.online}
			<p class="text-sm text-red-700">Robot is offline.</p>
		{:else if !data.instrumentsReachable}
			<p class="text-sm text-red-700">/instruments is unreachable — cannot verify pipette.</p>
		{:else if requiredPipettes.length === 0}
			<p class="text-sm text-red-700">Protocol requires no pipettes — nothing for LPC to measure with.</p>
		{:else if tipRacks.length === 0}
			<p class="text-sm text-red-700">Protocol declares no tip rack — LPC needs one to pick up a tip.</p>
		{:else if measureTargets.length === 0}
			<p class="text-sm text-red-700">Protocol declares no non-tiprack labware — nothing to measure.</p>
		{:else}
			<ul class="text-xs space-y-1 mb-3">
				<li>Pipette used for LPC: <span class="font-mono">{requiredPipettes[0].pipetteName}</span> on <span class="font-mono">{requiredPipettes[0].mount}</span></li>
				<li>Tip racks available: {tipRacks.length}</li>
				<li>Labware to measure: {measureTargets.length}</li>
			</ul>
			<p class="text-xs text-gray-500 mb-3">
				The wizard will create a maintenance run on the robot, load each labware,
				and walk you through jogging the pipette tip to the reference well of
				each labware one by one. You can cancel at any time.
			</p>
		{/if}
		<button
			type="button"
			disabled={!canStart || busy}
			onclick={startWizard}
			class="px-3 py-1.5 bg-blue-600 text-white text-sm rounded hover:bg-blue-700 disabled:opacity-50"
		>
			Start Labware Position Check
		</button>
	</section>
{/if}

{#if phase === 'initializing'}
	<section class="bg-white border rounded-lg p-4 mb-4">
		<p class="text-sm">Initializing maintenance run and loading protocol labware onto the robot…</p>
	</section>
{/if}

{#if phase === 'attach-tip'}
	<section class="bg-white border rounded-lg p-4 mb-4">
		<h3 class="font-semibold mb-2">Attach tip</h3>
		<p class="text-xs text-gray-500 mb-3">
			Pick a tip rack. The pipette will pick up well A1 from it. Make sure the
			tip rack is physically in the chosen slot with tips available in A1.
		</p>
		<label class="block text-xs mb-2">
			<span class="text-gray-700">Tip rack</span>
			<select
				bind:value={selectedTipRackId}
				class="mt-0.5 text-sm border rounded px-2 py-1 w-full"
			>
				{#each tipRacks as lw (lw.id)}
					<option value={lw.id}>
						Slot {lw.location?.slotName} — {lw.displayName ?? lw.loadName}
					</option>
				{/each}
			</select>
		</label>
		<div class="flex gap-2">
			<button
				type="button"
				disabled={busy || !selectedTipRackId}
				onclick={attachTip}
				class="px-3 py-1.5 bg-blue-600 text-white text-sm rounded hover:bg-blue-700 disabled:opacity-50"
			>
				Attach tip
			</button>
			<button
				type="button"
				disabled={busy}
				onclick={() => cancelWizard()}
				class="px-3 py-1.5 border text-sm rounded hover:bg-gray-100"
			>
				Cancel
			</button>
		</div>
	</section>
{/if}

{#if phase === 'measure' && currentTarget}
	<section class="bg-white border rounded-lg p-4 mb-4">
		<div class="flex items-start justify-between mb-3">
			<div>
				<h3 class="font-semibold">
					Labware {measureIdx + 1} of {measureTargets.length}
				</h3>
				<p class="text-sm">
					Slot <span class="font-mono">{currentTarget.location?.slotName}</span>
					— {currentTarget.displayName ?? currentTarget.loadName}
				</p>
				<p class="text-xs font-mono text-gray-400">{currentTarget.loadName}</p>
			</div>
			<div class="text-xs text-right text-gray-500">
				{completedCount} / {measureTargets.length} saved
			</div>
		</div>
		<p class="text-xs text-gray-500 mb-3">
			The pipette is over well A1 at the nominal top. Use the jog buttons below
			to position the tip exactly at the well center. When it looks right, press
			<b>Save and continue</b>.
		</p>

		<div class="flex flex-wrap items-center gap-2 mb-3">
			<span class="text-xs text-gray-700">Step size:</span>
			{#each [0.1, 1] as s (s)}
				<button
					type="button"
					class="px-2 py-1 text-xs border rounded {jogStep === s ? 'bg-blue-600 text-white' : 'hover:bg-gray-100'}"
					disabled={busy}
					onclick={() => (jogStep = s)}
				>
					{s} mm
				</button>
			{/each}
			<label class="flex items-center gap-1 text-xs text-gray-700 ml-2">
				or exact:
				<input
					type="number"
					min={JOG_MIN_MM}
					max={JOG_MAX_MM}
					step="0.01"
					bind:value={jogStep}
					disabled={busy}
					class="w-20 px-2 py-1 text-xs border rounded"
					aria-label="Custom jog step in mm"
				/>
				<span>mm</span>
			</label>
			{#if jogStep > 1}
				<span class="text-xs text-yellow-600" title="Step sizes above 1mm can crash into labware if misdirected">
					⚠ step &gt; 1 mm — jog cautiously
				</span>
			{/if}
		</div>

		<div class="flex items-start gap-6 mb-3">
			<!-- X / Y cross. Z is in a separate column to the right. -->
			<div class="inline-grid gap-2" style="grid-template-columns: repeat(3, 64px); grid-template-rows: repeat(3, 64px);">
				<span></span>
				<button type="button" class="jog-btn" disabled={busy} onclick={() => jog('y', 1)} aria-label="Y plus">Y+</button>
				<span></span>

				<button type="button" class="jog-btn" disabled={busy} onclick={() => jog('x', -1)} aria-label="X minus">X-</button>
				<span></span>
				<button type="button" class="jog-btn" disabled={busy} onclick={() => jog('x', 1)} aria-label="X plus">X+</button>

				<span></span>
				<button type="button" class="jog-btn" disabled={busy} onclick={() => jog('y', -1)} aria-label="Y minus">Y-</button>
				<span></span>
			</div>

			<!-- Z column, separate from X/Y. -->
			<div class="inline-grid gap-2" style="grid-template-columns: 64px; grid-template-rows: repeat(3, 64px);">
				<button type="button" class="jog-btn" disabled={busy} onclick={() => jog('z', 1)} aria-label="Z plus">Z+</button>
				<span></span>
				<button type="button" class="jog-btn" disabled={busy} onclick={() => jog('z', -1)} aria-label="Z minus">Z-</button>
			</div>
		</div>

		<div class="flex flex-wrap gap-2">
			<button
				type="button"
				disabled={busy}
				onclick={saveAndContinue}
				class="px-3 py-1.5 bg-blue-600 text-white text-sm rounded hover:bg-blue-700 disabled:opacity-50"
			>
				Save and continue
			</button>
			<button
				type="button"
				disabled={busy || measureIdx === 0}
				onclick={back}
				class="px-3 py-1.5 border text-sm rounded hover:bg-gray-100 disabled:opacity-50"
			>
				Back (re-measure previous)
			</button>
			<button
				type="button"
				disabled={busy}
				onclick={safeLiftZ}
				class="px-3 py-1.5 border text-sm rounded hover:bg-gray-100 disabled:opacity-50"
				title="Lift the pipette Z to a safe height immediately — does not discard collected offsets"
			>
				Home Z (safe lift)
			</button>
			<button
				type="button"
				disabled={busy}
				onclick={abortCurrentMeasure}
				class="px-3 py-1.5 border text-sm rounded hover:bg-gray-100 disabled:opacity-50"
				title="Home Z and re-approach this labware from scratch"
			>
				Restart this labware
			</button>
			<button
				type="button"
				disabled={busy}
				onclick={() => cancelWizard()}
				class="px-3 py-1.5 border border-red-300 text-red-700 text-sm rounded hover:bg-red-50 disabled:opacity-50"
			>
				Cancel LPC
			</button>
		</div>
	</section>
{/if}

{#if phase === 'review' || phase === 'ending'}
	<section class="bg-white border rounded-lg p-4 mb-4">
		<h3 class="font-semibold mb-2">Review</h3>
		{#if phase === 'ending'}
			<p class="text-sm text-gray-500 mb-2">Ending maintenance run…</p>
		{/if}
		{#if Object.keys(offsets).length === 0}
			<p class="text-sm text-gray-500">No offsets were collected.</p>
		{:else}
			<table class="text-xs w-full">
				<thead>
					<tr class="text-left text-gray-500">
						<th class="py-1">Slot</th>
						<th class="py-1">Labware</th>
						<th class="py-1">X (mm)</th>
						<th class="py-1">Y (mm)</th>
						<th class="py-1">Z (mm)</th>
					</tr>
				</thead>
				<tbody>
					{#each measureTargets as target (target.id)}
						{@const o = offsets[target.id]}
						{#if o}
							<tr class="border-t">
								<td class="py-1 font-mono">{o.slotName}</td>
								<td class="py-1">{o.displayName}</td>
								<td class="py-1 font-mono">{o.vector.x.toFixed(2)}</td>
								<td class="py-1 font-mono">{o.vector.y.toFixed(2)}</td>
								<td class="py-1 font-mono">{o.vector.z.toFixed(2)}</td>
							</tr>
						{/if}
					{/each}
				</tbody>
			</table>
		{/if}
		<div class="flex flex-wrap gap-2 mt-4">
			<button
				type="button"
				disabled={phase !== 'review' || busy}
				onclick={applyOffsetsAndReturn}
				class="px-3 py-1.5 bg-blue-600 text-white text-sm rounded hover:bg-blue-700 disabled:opacity-50"
			>
				Apply and create run
			</button>
			<a
				href={`/opentrons-clone/${robotId}/protocols/${data.protocolId}`}
				class="px-3 py-1.5 border text-sm rounded hover:bg-gray-100"
			>
				Discard and return
			</a>
		</div>
	</section>
{/if}

<style>
	.jog-btn {
		min-width: 44px;
		min-height: 44px;
		border: 1px solid #cbd5e1;
		border-radius: 0.375rem;
		background: #f8fafc;
		font-size: 0.9rem;
		font-weight: 500;
		cursor: pointer;
	}
	.jog-btn:hover:not(:disabled) {
		background: #e2e8f0;
	}
	.jog-btn:disabled {
		opacity: 0.5;
		cursor: not-allowed;
	}
	:global(.ot-dark) .jog-btn {
		background: #0f172a;
		border-color: #334155;
		color: #e2e8f0;
	}
	:global(.ot-dark) .jog-btn:hover:not(:disabled) {
		background: #1e293b;
	}
</style>
