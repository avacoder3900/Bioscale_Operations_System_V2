<script lang="ts">
	import RobotArmControlBar from '$lib/components/RobotArmControlBar.svelte';
	import { enhance } from '$app/forms';
	import { daysLeftLabel } from '$lib/robot-arm/animation';
	import { invalidateAll } from '$app/navigation';

	let { data, form } = $props();


	// Recording trash. Delete moves a recording to R2 for 30 days; Recover
	// brings it back to the Pi. Only the daily cron removes trash permanently.
	let showTrash = $state(false);
	let recordingBusy = $state(false);
	const deletedRecordings = $derived(data.deletedRecordings ?? []);
	// Recordings On Pi: click NAME or DATE to sort; newest first by default.
	let recordingSort = $state<'date' | 'name'>('date');
	const sortedRecordings = $derived(
		[...data.piRecordings].sort((a, b) => (recordingSort === 'name' ? a.name.localeCompare(b.name, undefined, { numeric: true }) : new Date(b.modified).getTime() - new Date(a.modified).getTime()))
	);
	const recordingEnhance = () => {
		recordingBusy = true;
		return async ({ update }: { update: (opts?: { reset?: boolean }) => Promise<void> }) => {
			await update({ reset: false });
			recordingBusy = false;
		};
	};


	// `active` and `activeError` now arrive pre-separated from the server, so the
	// hand-written union guards this page used to carry are gone.
	//
	// While something is running, /api/robot-arm/session is polled so the
	// session bar follows the run — in particular which loop a multi-loop
	// replay is on, which only changes while the page sits open. The poll
	// result overrides the page data until the next full load; when the run
	// ends, one invalidateAll() restores the forms and the holder row.
	type LiveSession = {
		active: { run_id: string; kind: string } | null;
		activeError: string | null;
		holder: (typeof data)['holder'];
	};
	let live = $state<LiveSession | null>(null);
	const active = $derived(live?.active ?? data.active ?? null);
	const activeError = $derived(live ? live.activeError : (data.activeError ?? null));
	const holder = $derived(live?.holder ?? data.holder ?? null);
	const replayLoop = $derived(
		active?.kind === 'replay' && holder?.type === 'replay' ? (holder.loop ?? null) : null
	);

	const armReachable = $derived(data.preflight != null);

	const SESSION_POLL_MS = 2000;
	// Boolean on purpose: each poll replaces `active`, and an effect keyed on
	// the object would tear down and restart the interval every tick.
	const running = $derived(active != null);
	$effect(() => {
		// A fresh page load is authoritative again; drop the stale override.
		void data;
		live = null;
	});
	$effect(() => {
		if (!running) return;
		let cancelled = false;
		let inFlight = false;
		const tick = async () => {
			if (inFlight || document.hidden) return;
			inFlight = true;
			try {
				const res = await fetch('/api/robot-arm/session', { cache: 'no-store' });
				if (!res.ok || cancelled) return;
				const body = (await res.json()) as LiveSession;
				if (cancelled) return;
				if (body.active == null && body.activeError == null) {
					// The run ended (or was stopped elsewhere): reload the page data
					// once so the start buttons re-enable and the holder row settles.
					clearInterval(id);
					live = body;
					await invalidateAll();
					return;
				}
				live = body;
			} catch {
				// A missed poll is not an outage; the next tick tries again.
			} finally {
				inFlight = false;
			}
		};
		const id = setInterval(tick, SESSION_POLL_MS);
		return () => {
			cancelled = true;
			clearInterval(id);
		};
	});

	function logTime(iso: string): string {
		return new Date(iso).toLocaleString();
	}

</script>

<div class="mx-auto max-w-7xl space-y-6">
	<div class="flex items-center justify-between">
		<h1 class="text-base font-semibold" style="color: var(--color-tron-cyan)">
			Leader Arm
		</h1>
		<a
			href="/manufacturing/cart-mfg/robot-arm/maintenance"
			class="text-xs transition-colors hover:text-[var(--color-tron-cyan)]"
			style="color: var(--color-tron-text-secondary)"
		>
			← Maintenance
		</a>
	</div>

	<!--
		The ARM CONNECTION panel lives in the Robot Arm layout's right rail, above
		the camera, so it is visible on every tab — not here.
	-->
	<div class="min-w-0 space-y-6">
		<!--
			ARM-01 §8 — the single session indicator, sitting directly above the
			controls it governs. This replaces both the old control bar position
			and the separate inline banner that used to duplicate it.
		-->
		<RobotArmControlBar
			{holder}
			{active}
			connectError={activeError}
			currentUserId={data.currentUserId}
		/>

		{#if form && 'warning' in form && form.warning}
			<div class="rounded border border-amber-500/40 bg-amber-900/10 p-3 text-sm text-amber-300">
				{form.warning}
			</div>
		{:else if form?.success}
			<div class="rounded border border-green-500/40 bg-green-900/10 p-3 text-sm text-green-300">
				{form.success}
				{#if 'runId' in form && form.runId}
					<a
						href="/manufacturing/cart-mfg/robot-arm/history/{form.runId}"
						class="ml-2 underline"
						style="color: var(--color-tron-cyan)">View Run →</a
					>
				{/if}
			</div>
		{:else if form?.error}
			<div class="rounded border border-red-500/40 bg-red-900/10 p-3 text-sm text-red-300">
				{form.error}
			</div>
		{/if}

		<!-- Teleop / Replay — Record lives on the Teach tab (under the conveyor belt) -->
		<div class="grid grid-cols-1 gap-4 md:grid-cols-2">
			<!-- Teleop -->
			<form
				method="POST"
				action="?/startTeleop"
				class="space-y-3 rounded-lg border border-[var(--color-tron-border)] bg-[var(--color-tron-surface)] p-4"
			>
				<div>
					<h2 class="font-semibold" style="color: var(--color-tron-cyan)">Teleop</h2>
				</div>
				<label class="block text-xs" style="color: var(--color-tron-text-secondary)">
					Rate (Hz)
					<input
						type="number"
						name="rate_hz"
						value="30"
						min="1"
						max="60"
						class="mt-1 w-full rounded border border-[var(--color-tron-border)] bg-black/40 px-2 py-1 text-sm"
						style="color: var(--color-tron-text)"
					/>
				</label>
				<label class="block text-xs" style="color: var(--color-tron-text-secondary)">
					Duration (s)
					<input
						type="number"
						name="duration_s"
						placeholder="Until Stopped"
						min="1"
						class="mt-1 w-full rounded border border-[var(--color-tron-border)] bg-black/40 px-2 py-1 text-sm"
						style="color: var(--color-tron-text)"
					/>
				</label>
				<button
					type="submit"
					disabled={!!active}
					class="w-full rounded border border-[var(--color-tron-cyan)]/50 bg-[var(--color-tron-cyan)]/10 px-3 py-1.5 text-sm font-medium transition-colors hover:bg-[var(--color-tron-cyan)]/20 disabled:cursor-not-allowed disabled:opacity-40"
					style="color: var(--color-tron-cyan)">Start Teleop</button
				>
			</form>

			<!-- Replay -->
			<form
				method="POST"
				action="?/startReplay"
				class="space-y-3 rounded-lg border border-[var(--color-tron-border)] bg-[var(--color-tron-surface)] p-4"
			>
				<div>
					<h2 class="font-semibold" style="color: var(--color-tron-cyan)">Replay</h2>
				</div>
				{#if active?.kind === 'replay'}
					<!--
						Loop progress while a replay runs. The Pi logs a replay.loop
						event at the top of each loop; the session poll above picks up
						the latest one. No event yet means the first loop is ramping in.
					-->
					<div
						class="rounded border px-3 py-2 text-xs"
						style="border-color: var(--color-tron-accent, #38bdf8); background: rgba(56,189,248,0.08); color: var(--color-tron-text)"
						aria-live="polite"
					>
						{#if replayLoop}
							<div class="flex items-center justify-between gap-2">
								<span class="font-semibold">Loop {replayLoop.index} of {replayLoop.of}</span>
								<span style="color: var(--color-tron-text-secondary)">
									{replayLoop.of - replayLoop.index} left after this one
								</span>
							</div>
							<div class="mt-1.5 h-1.5 w-full overflow-hidden rounded-full bg-black/40">
								<div
									class="h-full rounded-full transition-[width] duration-500"
									style="width: {Math.round((replayLoop.index / replayLoop.of) * 100)}%; background: var(--color-tron-accent, #38bdf8)"
								></div>
							</div>
						{:else}
							<span class="font-semibold">Replaying…</span>
							<span style="color: var(--color-tron-text-secondary)">loop count not reported yet</span>
						{/if}
					</div>
				{/if}
				<label class="block text-xs" style="color: var(--color-tron-text-secondary)">
					Recording
					<select
						name="source"
						required
						class="mt-1 w-full rounded border border-[var(--color-tron-border)] bg-black/40 px-2 py-1 text-sm"
						style="color: var(--color-tron-text)"
					>
						<option value="">— Pick One —</option>
						{#each data.piRecordings as r (r.path)}
							<option value={r.path}>{r.name}</option>
						{/each}
					</select>
				</label>
				<label class="block text-xs" style="color: var(--color-tron-text-secondary)">
					Loops
					<input
						type="number"
						name="loops"
						value="1"
						min="1"
						max="100"
						class="mt-1 w-full rounded border border-[var(--color-tron-border)] bg-black/40 px-2 py-1 text-sm"
						style="color: var(--color-tron-text)"
					/>
				</label>
				<button
					type="submit"
					disabled={!!active || data.piRecordings.length === 0}
					class="w-full rounded border border-[var(--color-tron-cyan)]/50 bg-[var(--color-tron-cyan)]/10 px-3 py-1.5 text-sm font-medium transition-colors hover:bg-[var(--color-tron-cyan)]/20 disabled:cursor-not-allowed disabled:opacity-40"
					style="color: var(--color-tron-cyan)">Start Replay</button
				>
			</form>
		</div>

		<!-- Recordings table, with the 30-day trash -->
		<section>
			<div class="mb-2 flex flex-wrap items-center justify-between gap-2">
				<h2
					class="text-sm font-bold uppercase tracking-wider"
					style="color: var(--color-tron-text-secondary)"
				>
					Recordings On Pi ({data.piRecordings.length})
				</h2>
				<button
					type="button"
					onclick={() => (showTrash = !showTrash)}
					class="min-h-[36px] rounded border border-[var(--color-tron-cyan)]/50 bg-[var(--color-tron-cyan)]/10 px-3 py-1 text-xs font-medium transition-colors hover:bg-[var(--color-tron-cyan)]/20"
					style="color: var(--color-tron-cyan)"
					aria-expanded={showTrash}
				>
					{showTrash ? 'Hide' : 'Recover Recordings'} ({deletedRecordings.length})
				</button>
			</div>

			{#if showTrash}
				<div
					class="mb-3 overflow-hidden rounded border border-[var(--color-tron-border)] bg-[var(--color-tron-surface)]"
				>
					{#if deletedRecordings.length === 0}
						<p class="px-3 py-2 text-xs" style="color: var(--color-tron-text-secondary)">
							Trash Empty
						</p>
					{:else}
						<table class="w-full text-xs">
							<thead
								class="border-b border-[var(--color-tron-border)] text-left uppercase tracking-wider"
								style="color: var(--color-tron-text-secondary)"
							>
								<tr>
									<th class="px-3 py-2">Name</th>
									<th class="px-3 py-2">Deleted</th>
									<th class="px-3 py-2"></th>
									<th class="px-3 py-2"></th>
								</tr>
							</thead>
							<tbody style="color: var(--color-tron-text)">
								{#each deletedRecordings as t (t._id)}
									<tr class="border-b border-[var(--color-tron-border)]/50 last:border-b-0">
										<td class="px-3 py-2 font-mono">{t.name}</td>
										<td class="px-3 py-2" style="color: var(--color-tron-text-secondary)">
											{new Date(t.deletedAt).toLocaleString()}
											{#if t.deletedBy?.username}· {t.deletedBy.username}{/if}
										</td>
										<td class="px-3 py-2" style="color: var(--color-tron-text-secondary)">
											{daysLeftLabel(t.expiresAt)}
										</td>
										<td class="px-3 py-2 text-right">
											<form method="POST" action="?/recoverRecording" use:enhance={recordingEnhance}>
												<input type="hidden" name="id" value={t._id} />
												<button
													type="submit"
													disabled={!armReachable || recordingBusy}
													class="rounded border border-[var(--color-tron-cyan)]/50 px-2 py-1 text-xs transition-colors hover:bg-[var(--color-tron-cyan)]/20 disabled:cursor-not-allowed disabled:opacity-40"
													style="color: var(--color-tron-cyan)"
												>
													Recover
												</button>
											</form>
										</td>
									</tr>
								{/each}
							</tbody>
						</table>
					{/if}
				</div>
			{/if}

			{#if data.piRecordings.length === 0}
				<p class="text-sm" style="color: var(--color-tron-text-secondary)">
					No Recordings
				</p>
			{:else}
				<div
					class="overflow-hidden rounded border border-[var(--color-tron-border)] bg-[var(--color-tron-surface)]"
				>
					<table class="w-full text-xs">
						<thead
							class="border-b border-[var(--color-tron-border)] text-left uppercase tracking-wider"
							style="color: var(--color-tron-text-secondary)"
						>
							<tr>
								<th class="px-3 py-2">
									<button type="button" class="uppercase tracking-wider" style={recordingSort === 'name' ? 'color: var(--color-tron-cyan)' : ''} onclick={() => (recordingSort = 'name')} aria-pressed={recordingSort === 'name'}>Name</button>
								</th>
								<th class="px-3 py-2">Size</th>
								<th class="px-3 py-2">
									<button type="button" class="uppercase tracking-wider" style={recordingSort === 'date' ? 'color: var(--color-tron-cyan)' : ''} onclick={() => (recordingSort = 'date')} aria-pressed={recordingSort === 'date'}>Date</button>
								</th>
								<th class="w-10 px-3 py-2"><span class="sr-only">Delete</span></th>
							</tr>
						</thead>
						<tbody style="color: var(--color-tron-text)">
							{#each sortedRecordings as r (r.path)}
								<tr class="border-b border-[var(--color-tron-border)]/50 last:border-b-0">
									<td class="px-3 py-2 font-mono">
										{r.name}
										<a
											href={`/manufacturing/cart-mfg/robot-arm/maintenance/cleanup?source=${encodeURIComponent(r.name)}`}
											class="ml-2 font-sans text-[11px] hover:underline"
											style="color: var(--color-tron-cyan)"
											title="Split this recording into steps and clean it up">Clean Up</a
										>
									</td>
									<td class="px-3 py-2" style="color: var(--color-tron-text-secondary)">
										{(r.size_bytes / 1024).toFixed(1)} KB
									</td>
									<td class="px-3 py-2" style="color: var(--color-tron-text-secondary)">
										{new Date(r.modified).toLocaleString()}
									</td>
									<td class="px-3 py-1 text-right">
										<form
											method="POST"
											action="?/deleteRecording"
											use:enhance={recordingEnhance}
											onsubmit={(e) => {
												if (!confirm(`Delete "${r.name}"? It can be recovered for 30 days.`)) e.preventDefault();
											}}
										>
											<input type="hidden" name="name" value={r.name} />
											<input type="hidden" name="modified" value={r.modified} />
											<button
												type="submit"
												disabled={!!active || recordingBusy}
												title={active ? 'Stop the active session before deleting' : `Delete ${r.name}`}
												aria-label="Delete {r.name}"
												class="inline-flex h-8 w-8 items-center justify-center rounded transition-colors hover:bg-red-500/15 disabled:cursor-not-allowed disabled:opacity-40"
												style="color: #ef4444"
											>
												<svg viewBox="0 0 24 24" class="h-4 w-4" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
													<path d="M3 6h18" />
													<path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
													<path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6" />
													<path d="M10 11v6M14 11v6" />
												</svg>
											</button>
										</form>
									</td>
								</tr>
							{/each}
						</tbody>
					</table>
				</div>
			{/if}
		</section>

		<!-- Connection log -->
		<section>
			<h2
				class="mb-2 text-sm font-bold uppercase tracking-wider"
				style="color: var(--color-tron-text-secondary)"
			>
				Connection Log
			</h2>
			{#if (data.connectionLog ?? []).length === 0}
				<p class="text-sm" style="color: var(--color-tron-text-secondary)">
					No Connection History
				</p>
			{:else}
				<div
					class="overflow-hidden rounded border border-[var(--color-tron-border)] bg-[var(--color-tron-surface)]"
				>
					<table class="w-full text-xs">
						<thead
							class="border-b border-[var(--color-tron-border)] text-left uppercase tracking-wider"
							style="color: var(--color-tron-text-secondary)"
						>
							<tr>
								<th class="px-3 py-2">When</th>
								<th class="px-3 py-2">Result</th>
								<th class="px-3 py-2">Detail</th>
							</tr>
						</thead>
						<tbody style="color: var(--color-tron-text)">
							{#each data.connectionLog as row (row._id)}
								<tr class="border-b border-[var(--color-tron-border)]/50 last:border-b-0">
									<td class="whitespace-nowrap px-3 py-2 font-mono">{logTime(row.createdAt)}</td>
									<td class="px-3 py-2">
										<span style="color: {row.success ? '#22c55e' : '#ef4444'}">
											{row.success ? '● Reachable' : '● Unreachable'}
										</span>
									</td>
									<td class="break-all px-3 py-2" style="color: var(--color-tron-text-secondary)">
										{#if row.success}
											{row.eventData?.reason === 'change' ? 'Recovered' : 'Still Up'}
										{:else}
											{row.errorMessage || 'Unreachable'}
										{/if}
									</td>
								</tr>
							{/each}
						</tbody>
					</table>
				</div>
			{/if}
		</section>
	</div>
</div>
