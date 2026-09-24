<script lang="ts">
	import { enhance } from '$app/forms';
	import TronCard from '$lib/components/ui/TronCard.svelte';
	import TronButton from '$lib/components/ui/TronButton.svelte';

	interface Props {
		data: {
			spus: {
				id: string;
				udi: string;
				particleDeviceId: string | null;
				status: string;
				magStatus: string;
				magCompletedAt: string | null;
			}[];
			exportableSpus: {
				id: string;
				udi: string;
				status: string;
				runCount: number;
				lastRunAt: string | null;
			}[];
			criteria: { minZ: number; maxZ: number };
		};
		form: any;
	}

	let { data, form }: Props = $props();

	let selectedSpuId = $state('');
	let fetching = $state(false);
	let editingCriteria = $state(false);
	let savingCriteria = $state(false);

	const selectedSpu = $derived(data.spus.find(s => s.id === selectedSpuId));

	// --- Stage sweep ---
	let sweeping = $state(false);

	// A sweep is only meaningful once the unit has a regular magnetometer run to
	// characterise against. 'pending' (or a missing field on older SPUs) means none.
	const selectedSpuHasMagRun = $derived(
		selectedSpu?.magStatus === 'passed' || selectedSpu?.magStatus === 'failed'
	);

	// --- Sweep progress poll ---
	// Deliberately slow: the run is ~19 minutes and every poll can reach the
	// Particle API, so there is nothing to gain from a tight loop.
	const SWEEP_POLL_MS = 18000;

	type SweepStatus = {
		status: 'running' | 'uploading' | 'complete' | 'stale' | 'unknown';
		elapsedMs?: number | null;
		deviceOnline?: boolean;
		deviceMode?: number | null;
		note?: string;
		reason?: string;
		sessionId?: string;
		completedAt?: string | null;
		wells?: number[];
		rows?: number | null;
	};

	// The SPU is captured at queue time, not read live: the operator is free to
	// change the picker afterwards and that must not repoint the poll.
	let sweepWatch = $state<{ spuId: string; udi: string; since: string } | null>(null);
	let sweepStatus = $state<SweepStatus | null>(null);
	let sweepElapsedMs = $state(0);

	// A derived boolean, not a read of sweepStatus directly, so the polling effect
	// re-runs only when the watch actually ends — reading sweepStatus would restart
	// the interval on every poll.
	const sweepFinished = $derived(
		sweepStatus?.status === 'complete' || sweepStatus?.status === 'stale'
	);

	// Slow network poll.
	$effect(() => {
		const watch = sweepWatch;
		if (!watch || sweepFinished) return;

		const interval = setInterval(async () => {
			try {
				const res = await fetch(
					`/api/validation/magnetometer/sweep-status?spuId=${encodeURIComponent(watch.spuId)}&since=${encodeURIComponent(watch.since)}`
				);
				if (res.ok) sweepStatus = await res.json();
			} catch {
				// Silent on purpose. The device is offline and the network unreliable
				// for most of the run, so a failed poll is expected — keep polling.
			}
		}, SWEEP_POLL_MS);

		return () => clearInterval(interval);
	});

	// Fast local clock, separate from the network poll so elapsed time keeps
	// ticking between polls and through failed ones.
	$effect(() => {
		const watch = sweepWatch;
		if (!watch || sweepFinished) return;

		const start = new Date(watch.since).getTime();
		const timer = setInterval(() => {
			sweepElapsedMs = Date.now() - start;
		}, 1000);

		return () => clearInterval(timer);
	});

	function formatElapsed(ms: number): string {
		const total = Math.max(0, Math.floor(ms / 1000));
		const m = Math.floor(total / 60);
		const sec = total % 60;
		return `${m}:${String(sec).padStart(2, '0')}`;
	}

	// --- Multi-SPU export ---
	let exportIds = $state<string[]>([]);
	let exportFilter = $state('');

	const exportable = $derived(data.exportableSpus ?? []);

	const visibleExportable = $derived(
		exportFilter.trim()
			? exportable.filter((s) =>
					s.udi.toLowerCase().includes(exportFilter.trim().toLowerCase())
				)
			: exportable
	);

	// Selecting then filtering must not silently drop hidden picks, so the count
	// reflects everything selected, not just what is on screen.
	const selectedCount = $derived(exportIds.length);

	const allVisibleSelected = $derived(
		visibleExportable.length > 0 && visibleExportable.every((s) => exportIds.includes(s.id))
	);

	function toggleExport(id: string) {
		exportIds = exportIds.includes(id)
			? exportIds.filter((x) => x !== id)
			: [...exportIds, id];
	}

	function toggleAllVisible() {
		if (allVisibleSelected) {
			const visible = new Set(visibleExportable.map((s) => s.id));
			exportIds = exportIds.filter((id) => !visible.has(id));
		} else {
			exportIds = [...new Set([...exportIds, ...visibleExportable.map((s) => s.id)])];
		}
	}

	const exportHref = $derived(
		`/spu/validation/magnetometer/export?spuIds=${encodeURIComponent(exportIds.join(','))}`
	);

	function formatLastRun(iso: string | null): string {
		if (!iso) return 'never';
		const d = new Date(iso);
		return Number.isNaN(d.getTime()) ? 'never' : d.toLocaleDateString();
	}
</script>

<div class="space-y-6">
	<h2 class="tron-text-primary text-2xl font-bold">Magnetometer Validation</h2>

	{#if form?.error}
		<div class="rounded border border-[var(--color-tron-red)] bg-[rgba(255,0,0,0.1)] p-3">
			<p class="text-sm text-[var(--color-tron-red)]">{form.error}</p>
		</div>
	{/if}

	<TronCard>
		<div class="p-4 space-y-4">
			<h3 class="tron-text-primary text-lg font-bold">Run Magnetometer Test</h3>
			<p class="tron-text-muted text-sm">Select an SPU and run the test on the device first, then click to fetch the results.</p>

			<div>
				<label for="spu-select" class="tron-label">Select SPU</label>
				<select id="spu-select" class="tron-select w-full" style="min-height: 48px;" bind:value={selectedSpuId}>
					<option value="">Choose an SPU…</option>
					{#each data.spus as spu (spu.id)}
						<option value={spu.id}>{spu.udi} — Status: {spu.status}</option>
					{/each}
				</select>
			</div>

			{#if selectedSpu && !selectedSpu.particleDeviceId}
				<div class="text-sm" style="color: var(--color-tron-orange);">
					⚠️ This SPU has no Particle device linked.
				</div>
			{/if}

			<form method="POST" action="?/readFromDevice" use:enhance={() => {
				fetching = true;
				return async ({ update }) => {
					fetching = false;
					await update();
				};
			}}>
				<input type="hidden" name="spuId" value={selectedSpuId} />
				<button
					type="submit"
					disabled={!selectedSpu?.particleDeviceId || fetching}
					class="w-full rounded-lg p-4 text-center font-bold text-lg transition-all cursor-pointer hover:opacity-90 active:scale-[0.98] disabled:opacity-30 disabled:cursor-not-allowed"
					style="background: linear-gradient(135deg, var(--color-tron-cyan), var(--color-tron-green)); color: var(--color-tron-bg-primary); min-height: 56px;"
				>
					{fetching ? '⏳ Fetching…' : '🧲 Run Test'}
				</button>
			</form>
		</div>
	</TronCard>

	<!-- Run Magnetometer Sweep -->
	<TronCard>
		<div class="p-4 space-y-4">
			<h3 class="tron-text-primary text-lg font-bold">Run Magnetometer Sweep</h3>
			<p class="tron-text-muted text-sm">
				Walks the stage through its full travel and samples the field continuously, to
				characterise where the peaks actually sit. This is a characterisation run only —
				it records no pass/fail and does not change the SPU's validation status.
			</p>

			<div
				class="rounded border p-3 text-sm"
				style="border-color: var(--color-tron-orange); color: var(--color-tron-orange);"
			>
				<strong>Insert a cartridge or jig before starting</strong> — the device refuses
				the sweep without one.
				<br /><br />
				Starting <strong>queues</strong> the sweep; it begins on the device's next idle
				pass, normally within moments, not the instant you click. Once under way it
				<strong>takes about 19 minutes</strong>, and the device goes <strong>OFFLINE</strong>
				for the whole run — it will stop responding to the cloud and drop off the device
				list until it finishes. That is normal. Do not power-cycle it, and do not start a
				sweep on a unit someone else needs.
			</div>

			{#if selectedSpu && !selectedSpuHasMagRun}
				<div class="text-sm" style="color: var(--color-tron-orange);">
					⚠️ Run the regular magnetometer test on this SPU first. A sweep characterises a
					unit against its recorded run, so there is nothing to compare against yet.
				</div>
			{/if}

			<form method="POST" action="?/runSweep" use:enhance={() => {
				sweeping = true;
				// Captured before the await: the picker may move while the call is in flight.
				const queuedSpuId = selectedSpuId;
				return async ({ result, update }) => {
					sweeping = false;
					await update();
					if (result.type === 'success' && (result.data as any)?.sweepStarted) {
						const d = result.data as any;
						sweepStatus = null;
						sweepElapsedMs = 0;
						sweepWatch = {
							spuId: queuedSpuId,
							udi: d.sweepUdi,
							// Prefer a server-stamped queue time when one is returned; the
							// client clock is only a fallback and can skew against the
							// session createdAt the endpoint compares `since` against.
							since: d.sweepQueuedAt ?? new Date().toISOString()
						};
					}
				};
			}}>
				<input type="hidden" name="spuId" value={selectedSpuId} />
				<button
					type="submit"
					disabled={!selectedSpu?.particleDeviceId || !selectedSpuHasMagRun || sweeping}
					class="w-full rounded-lg p-4 text-center font-bold text-lg transition-all cursor-pointer hover:opacity-90 active:scale-[0.98] disabled:opacity-30 disabled:cursor-not-allowed"
					style="background: linear-gradient(135deg, var(--color-tron-cyan), var(--color-tron-green)); color: var(--color-tron-bg-primary); min-height: 56px;"
				>
					{sweeping ? '⏳ Queueing…' : '📈 Queue Sweep (~19 min)'}
				</button>
			</form>

			{#if form?.sweepStarted}
				<p class="text-sm" style="color: var(--color-tron-green);">
					✓ Sweep queued on {form.sweepUdi}. It begins on the device's next idle pass and
					then runs for about {form.sweepMinutes} minutes; results appear once the rows
					have been ingested.
				</p>
			{/if}

			{#if sweepWatch}
				{#if sweepStatus?.status === 'complete'}
					<div
						class="rounded border p-3 text-sm"
						style="border-color: var(--color-tron-green); color: var(--color-tron-green);"
					>
						<strong>✓ Sweep complete on {sweepWatch.udi}.</strong>
						{#if sweepStatus.rows}
							{sweepStatus.rows} rows ingested{#if sweepStatus.wells?.length}
								across {sweepStatus.wells.length}
								{sweepStatus.wells.length === 1 ? 'well' : 'wells'}{/if}.
						{/if}
						<br />
						<a
							href="/spu/validation/magnetometer/sweep?sessionId={sweepStatus.sessionId}"
							class="underline"
						>
							View this sweep →
						</a>
					</div>
				{:else if sweepStatus?.status === 'stale'}
					<div
						class="rounded border p-3 text-sm"
						style="border-color: var(--color-tron-orange); color: var(--color-tron-orange);"
					>
						<strong>No sweep data after {formatElapsed(sweepElapsedMs)}.</strong>
						A run this old with nothing stored has almost certainly died rather than being
						slow. Check the device and queue the sweep again.
					</div>
				{:else if sweepStatus?.status === 'unknown'}
					<div
						class="rounded border p-3 text-sm"
						style="border-color: var(--color-tron-orange); color: var(--color-tron-orange);"
					>
						Cannot track this sweep: {sweepStatus.reason ?? 'no Particle device linked.'}
					</div>
				{:else}
					<!-- In progress. Styled as progress, never as an error: the device being
					     offline is what a healthy sweep looks like for most of its 19 minutes,
					     and an operator who reads it as a failure will power-cycle the unit
					     and destroy the run. -->
					<div
						class="rounded border p-3 text-sm"
						style="border-color: var(--color-tron-cyan); color: var(--color-tron-cyan);"
					>
						<strong>
							⏳ Sweep {sweepStatus?.status === 'uploading' ? 'uploading' : 'in progress'} on
							{sweepWatch.udi} — {formatElapsed(sweepElapsedMs)} elapsed
						</strong>
						<br />
						{#if sweepStatus?.note}
							{sweepStatus.note}
						{:else if sweepStatus?.deviceOnline === false}
							Device is offline, which is expected while a sweep runs — it stops servicing
							the cloud for the whole run.
						{:else}
							Queued. Waiting for the device to pick it up on its next idle pass.
						{/if}
						<br />
						This page checks every {Math.round(SWEEP_POLL_MS / 1000)}s. Leave the device
						alone until it finishes.
					</div>
				{/if}
			{/if}

			<p class="tron-text-muted text-sm">
				<a href="/spu/validation/magnetometer/sweep" class="underline">View sweep results →</a>
			</p>
		</div>
	</TronCard>

	<!-- Pass/Fail Criteria -->
	<TronCard>
		<div class="p-4">
			<div class="flex items-center justify-between">
				<h3 class="tron-text-primary font-bold">Pass/Fail Criteria (Z-axis)</h3>
				{#if !editingCriteria}
					<button type="button" onclick={() => (editingCriteria = true)} class="tron-text-muted text-xs underline">Edit</button>
				{/if}
			</div>

			{#if editingCriteria}
				<form
					method="POST"
					action="?/updateCriteria"
					use:enhance={() => {
						savingCriteria = true;
						return async ({ update }) => {
							savingCriteria = false;
							editingCriteria = false;
							await update();
						};
					}}
					class="mt-3 flex items-end gap-3"
				>
					<div class="flex-1">
						<label for="minZ" class="tron-label text-xs">Min Z</label>
						<input id="minZ" name="minZ" type="number" class="tron-input w-full" value={data.criteria.minZ} style="min-height: 44px;" />
					</div>
					<div class="flex-1">
						<label for="maxZ" class="tron-label text-xs">Max Z</label>
						<input id="maxZ" name="maxZ" type="number" class="tron-input w-full" value={data.criteria.maxZ} style="min-height: 44px;" />
					</div>
					<TronButton type="submit" variant="primary" disabled={savingCriteria} style="min-height: 44px;">
						{savingCriteria ? 'Saving…' : 'Save'}
					</TronButton>
					<button type="button" onclick={() => (editingCriteria = false)} class="tron-text-muted text-sm">Cancel</button>
				</form>
			{:else}
				<p class="tron-text-muted mt-2 text-sm">
					Z values must be between <strong class="tron-text-primary">{data.criteria.minZ}</strong> and <strong class="tron-text-primary">{data.criteria.maxZ}</strong> gauss to pass.
				</p>
				{#if form?.criteriaUpdated}
					<p class="mt-1 text-xs" style="color: var(--color-tron-green);">✓ Criteria updated</p>
				{/if}
			{/if}
		</div>
	</TronCard>

	<TronCard>
		<div class="space-y-4 p-4">
			<h3 class="tron-text-primary text-lg font-bold">Export Readings</h3>
			<p class="tron-text-muted text-sm">
				Pick any number of SPUs and download every magnetometer reading on record for them as
				one Excel workbook. Sheet <strong class="tron-text-primary">Per Well</strong> keeps the
				bench layout (all 12 channel columns on one row); sheet
				<strong class="tron-text-primary">Per Channel</strong> is one row per channel, which is
				the sheet to pivot when comparing SPUs.
			</p>

			{#if exportable.length === 0}
				<p class="tron-text-muted text-sm">No magnetometer runs have been recorded yet.</p>
			{:else}
				<div class="flex flex-wrap items-center gap-3">
					<input
						type="search"
						placeholder="Filter by UDI…"
						class="tron-input flex-1"
						style="min-height: 44px; min-width: 12rem;"
						bind:value={exportFilter}
					/>
					<TronButton variant="default" onclick={toggleAllVisible}>
						{allVisibleSelected ? 'Clear shown' : 'Select shown'}
					</TronButton>
				</div>

				<div
					class="max-h-72 space-y-1 overflow-y-auto rounded border p-2"
					style="border-color: var(--color-tron-border);"
				>
					{#each visibleExportable as spu (spu.id)}
						<label
							class="flex cursor-pointer items-center gap-3 rounded px-2 py-2 hover:bg-[var(--color-tron-bg-tertiary)]"
							style="min-height: 44px;"
						>
							<input
								type="checkbox"
								checked={exportIds.includes(spu.id)}
								onchange={() => toggleExport(spu.id)}
							/>
							<span class="tron-text-primary flex-1 font-mono text-sm">{spu.udi}</span>
							<span class="tron-text-muted text-xs">Status: {spu.status}</span>
							<span class="tron-text-muted text-xs">
								{spu.runCount}
								{spu.runCount === 1 ? 'run' : 'runs'} · last {formatLastRun(spu.lastRunAt)}
							</span>
						</label>
					{:else}
						<p class="tron-text-muted px-2 py-2 text-sm">No SPUs match that filter.</p>
					{/each}
				</div>

				<div class="flex flex-wrap items-center justify-between gap-3">
					<span class="tron-text-muted text-sm">
						{selectedCount}
						{selectedCount === 1 ? 'SPU' : 'SPUs'} selected
					</span>
					{#if selectedCount > 0}
						<a
							href={exportHref}
							download
							class="tron-button inline-flex items-center"
							style="min-height: 44px; padding: 0 1rem;"
						>
							Download .xlsx
						</a>
					{:else}
						<span class="tron-text-muted text-sm">Select at least one SPU to export.</span>
					{/if}
				</div>
			{/if}
		</div>
	</TronCard>
</div>
