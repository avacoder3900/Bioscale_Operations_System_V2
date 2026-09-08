<script lang="ts">
	import { enhance } from '$app/forms';
	import ThermocoupleChart from '$lib/components/validation/thermocouple/ThermocoupleChart.svelte';
	import ThermoFileUpload from '$lib/components/validation/thermocouple/ThermoFileUpload.svelte';

	interface Stats {
		min: number; max: number; mode: number; average: number; stdDev: number;
		cv: number; range: number; drift: number;
		readingCount: number; durationMs: number;
	}

	interface Props {
		data: {
			spus: Array<{ id: string; udi: string; status: string; thermoStatus: string | null }>;
			recentSessions: Array<{
				id: string;
				status: string;
				barcode: string | null;
				createdAt: string;
				spuUdi: string | null;
				stats: { min: number; max: number; mode: number | null; average: number } | null;
			}>;
		};
		form: {
			error?: string;
			uploaded?: boolean;
			sessionId?: string;
			barcode?: string | null;
			spuUdi?: string | null;
			fileName?: string;
			columnsNote?: string;
			stats?: Stats;
			series?: Array<{ timestamp: number; temperature: number }>;
			success?: boolean;
			passed?: boolean;
		} | null;
	}

	let { data, form }: Props = $props();

	let selectedSpuId = $state('');
	let hasFile = $state(false);
	let showFahrenheit = $state(false);
	let isUploading = $state(false);
	let isSaving = $state(false);
	// Remounts the picker after a completed cycle so the next SPU starts clean.
	let uploadNonce = $state(0);

	// The logger writes naive wall-clock text, so the server needs to know which
	// zone the operator recorded in. Re-evaluated on hydration, where it is real.
	let tzOffset = $state(new Date().getTimezoneOffset());

	let selectedSpu = $derived(data.spus.find(s => s.id === selectedSpuId));

	// Everything shown below comes back from the server, computed from the file
	// it actually read and stored. There is no client-side copy that can drift.
	let uploaded = $derived(form?.uploaded ? form : null);
	let stats = $derived(uploaded?.stats ?? null);
	let series = $derived(uploaded?.series ?? []);
	let uploadLabel = $derived(
		isUploading ? 'Reading file...' : selectedSpu ? 'Upload for ' + selectedSpu.udi : 'Upload'
	);

	function toF(c: number): number { return c * 9 / 5 + 32; }
	function fmtTemp(c: number): string {
		if (showFahrenheit) return toF(c).toFixed(2) + '°F';
		return c.toFixed(2) + '°C';
	}
	function formatDuration(ms: number): string {
		const totalSec = Math.floor(ms / 1000);
		const min = Math.floor(totalSec / 60);
		const sec = totalSec % 60;
		if (min > 0) return min + 'm ' + sec + 's';
		return sec + 's';
	}
	function formatDate(d: string): string { return new Date(d).toLocaleString(); }
</script>

<div class="space-y-6">
	<!-- Header -->
	<div class="flex items-center justify-between">
		<div>
			<h1 class="tron-heading text-2xl font-bold">Thermocouple Validation</h1>
			<p class="tron-text-muted mt-1">Upload temperature data from your thermocouple software</p>
		</div>
		<a
			href="/validation/thermocouple"
			class="text-sm text-[var(--color-tron-orange)] hover:underline"
		>
			View History →
		</a>
	</div>

	<!-- Verdict recorded -->
	{#if form?.success}
		<div class="rounded-lg border p-4
			{form.passed
				? 'border-[var(--color-tron-green)]/30 bg-[var(--color-tron-green)]/10'
				: 'border-[var(--color-tron-red)]/30 bg-[var(--color-tron-red)]/10'}">
			<div class="flex items-center gap-3">
				{#if form.passed}
					<svg class="h-8 w-8 text-[var(--color-tron-green)]" fill="none" viewBox="0 0 24 24" stroke="currentColor">
						<path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z" />
					</svg>
					<div>
						<span class="text-lg font-bold text-[var(--color-tron-green)]">Test Passed</span>
						<p class="tron-text-muted text-sm">
							{form.barcode ?? 'Session'} recorded against {form.spuUdi ?? 'the SPU'} on operator review.
						</p>
					</div>
				{:else}
					<svg class="h-8 w-8 text-[var(--color-tron-red)]" fill="none" viewBox="0 0 24 24" stroke="currentColor">
						<path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M10 14l2-2m0 0l2-2m-2 2l-2-2m2 2l2 2m7-2a9 9 0 11-18 0 9 9 0 0118 0z" />
					</svg>
					<div>
						<span class="text-lg font-bold text-[var(--color-tron-red)]">Test Failed</span>
						<p class="tron-text-muted text-sm">
							{form.barcode ?? 'Session'} recorded against {form.spuUdi ?? 'the SPU'} on operator review.
						</p>
					</div>
				{/if}
			</div>
			{#if form.sessionId}
				<a href="/validation/thermocouple/{form.sessionId}" class="mt-2 inline-block text-sm text-[var(--color-tron-cyan)] hover:underline">
					View full results →
				</a>
			{/if}
		</div>
	{/if}

	{#if form?.error}
		<div class="rounded-lg bg-[var(--color-tron-red)]/10 p-4 text-[var(--color-tron-red)]">
			{form.error}
		</div>
	{/if}

	<!-- Step 1: pick the SPU, post the file. -->
	{#if !uploaded}
		<form
			method="POST"
			action="?/upload"
			enctype="multipart/form-data"
			use:enhance={() => {
				isUploading = true;
				return async ({ update }) => {
					await update();
					isUploading = false;
				};
			}}
		>
			<input type="hidden" name="tzOffset" value={tzOffset} />

			<div class="tron-card p-6">
				<h2 class="tron-heading mb-4 text-lg font-semibold">Select SPU</h2>
				<select
					name="spuId"
					bind:value={selectedSpuId}
					class="tron-input w-full rounded-lg px-4 py-3 text-lg"
					required
				>
					<option value="" disabled>Choose an SPU...</option>
					{#each data.spus as spu (spu.id)}
						<option value={spu.id}>
							{spu.udi} — {spu.status}
							{#if spu.thermoStatus}
								(thermo: {spu.thermoStatus})
							{/if}
						</option>
					{/each}
				</select>
				{#if selectedSpu}
					<p class="tron-text-muted mt-2 text-sm">
						Current thermocouple status: <span class="font-medium capitalize">{selectedSpu.thermoStatus ?? 'not tested'}</span>
					</p>
				{/if}
			</div>

			<div class="tron-card mt-4 p-6">
				<h2 class="tron-heading mb-4 text-lg font-semibold">Upload Temperature Data</h2>
				{#key uploadNonce}
					<ThermoFileUpload name="file" onfile={(f) => hasFile = f !== null} />
				{/key}
			</div>

			<button
				type="submit"
				disabled={!selectedSpuId || !hasFile || isUploading}
				class="mt-4 w-full rounded-lg bg-[var(--color-tron-orange)] px-6 py-4 text-lg font-semibold text-[var(--color-tron-bg-primary)] transition-all hover:bg-[var(--color-tron-orange)]/90 disabled:cursor-not-allowed disabled:opacity-50"
				style="min-height: 44px"
			>
				{uploadLabel}
			</button>

			{#if !selectedSpuId || !hasFile}
				<p class="tron-text-muted mt-3 text-center text-sm">
					Choose an SPU and a .csv or .xlsx file, then upload. The statistics and chart are
					computed from the stored file and shown before you record a verdict.
				</p>
			{/if}
		</form>
	{/if}

	<!-- Step 2: review what was stored, then judge it. -->
	{#if uploaded && stats}
		<div class="tron-card p-4">
			<div class="flex flex-wrap items-center justify-between gap-2">
				<div>
					<p class="tron-heading font-medium">
						{uploaded.barcode ?? 'Uploaded'} · {uploaded.spuUdi ?? ''}
					</p>
					<p class="tron-text-muted text-sm">
						{uploaded.fileName}{#if uploaded.columnsNote}&nbsp;· {uploaded.columnsNote}{/if}&nbsp;· {stats.readingCount} readings
					</p>
				</div>
				<button
					type="button"
					onclick={() => showFahrenheit = !showFahrenheit}
					class="rounded-lg bg-[var(--color-tron-bg-tertiary)] px-4 py-2 text-sm font-medium text-[var(--color-tron-text-secondary)] transition-colors hover:text-[var(--color-tron-cyan)]"
				>
					Show in {showFahrenheit ? '°C' : '°F'}
				</button>
			</div>
		</div>

		<!-- Stats Grid -->
		<div class="tron-card p-6">
			<h2 class="tron-heading mb-4 text-lg font-semibold">Statistics</h2>
			<div class="grid grid-cols-2 gap-4 md:grid-cols-4">
				<div class="rounded-lg border border-[var(--color-tron-cyan)]/30 bg-[var(--color-tron-bg-tertiary)] p-4 text-center">
					<span class="tron-text-muted block text-xs uppercase">Mode</span>
					<span class="tron-heading text-2xl font-bold">{fmtTemp(stats.mode)}</span>
				</div>
				<div class="rounded-lg border border-[var(--color-tron-cyan)]/30 bg-[var(--color-tron-bg-tertiary)] p-4 text-center">
					<span class="tron-text-muted block text-xs uppercase">Min</span>
					<span class="tron-heading text-2xl font-bold">{fmtTemp(stats.min)}</span>
				</div>
				<div class="rounded-lg border border-[var(--color-tron-cyan)]/30 bg-[var(--color-tron-bg-tertiary)] p-4 text-center">
					<span class="tron-text-muted block text-xs uppercase">Max</span>
					<span class="tron-heading text-2xl font-bold">{fmtTemp(stats.max)}</span>
				</div>
				<div class="rounded-lg bg-[var(--color-tron-bg-tertiary)] p-4 text-center">
					<span class="tron-text-muted block text-xs uppercase">Average</span>
					<span class="tron-heading text-2xl font-bold">{fmtTemp(stats.average)}</span>
				</div>
				<div class="rounded-lg bg-[var(--color-tron-bg-tertiary)] p-4 text-center">
					<span class="tron-text-muted block text-xs uppercase">Std Dev</span>
					<span class="tron-heading text-2xl font-bold">{stats.stdDev.toFixed(3)}</span>
				</div>
				<div class="rounded-lg bg-[var(--color-tron-bg-tertiary)] p-4 text-center">
					<span class="tron-text-muted block text-xs uppercase">CV %</span>
					<span class="tron-heading text-2xl font-bold">{stats.cv.toFixed(2)}%</span>
				</div>
				<div class="rounded-lg bg-[var(--color-tron-bg-tertiary)] p-4 text-center">
					<span class="tron-text-muted block text-xs uppercase">Range</span>
					<span class="tron-heading text-2xl font-bold">{fmtTemp(stats.range)}</span>
				</div>
				<div class="rounded-lg bg-[var(--color-tron-bg-tertiary)] p-4 text-center">
					<span class="tron-text-muted block text-xs uppercase">Drift</span>
					<span class="tron-heading text-2xl font-bold">{stats.drift >= 0 ? '+' : ''}{fmtTemp(stats.drift)}</span>
				</div>
				<div class="rounded-lg bg-[var(--color-tron-bg-tertiary)] p-4 text-center">
					<span class="tron-text-muted block text-xs uppercase">Duration</span>
					<span class="tron-heading text-2xl font-bold">{formatDuration(stats.durationMs)}</span>
				</div>
			</div>
		</div>

		<!-- Chart -->
		<div>
			<ThermocoupleChart readings={series} showBands={false} />
		</div>

		<!-- Verdict -->
		<form
			method="POST"
			action="?/verdict"
			use:enhance={() => {
				isSaving = true;
				return async ({ result, update }) => {
					await update();
					isSaving = false;
					if (result.type === 'success') {
						selectedSpuId = '';
						hasFile = false;
						uploadNonce += 1;
					}
				};
			}}
		>
			<input type="hidden" name="sessionId" value={uploaded.sessionId} />
			<p class="tron-text-muted mb-3 text-center text-sm">
				No acceptance range is configured. The operator judges the readings above and
				records the verdict — that verdict is the record.
			</p>
			<div class="flex gap-3">
				<button
					type="submit"
					name="outcome"
					value="passed"
					disabled={isSaving}
					class="flex-1 rounded-lg bg-[var(--color-tron-green)] px-6 py-4 text-lg font-semibold text-[var(--color-tron-bg-primary)] transition-all hover:bg-[var(--color-tron-green)]/90 disabled:cursor-not-allowed disabled:opacity-50"
					style="min-height: 44px"
				>
					{isSaving ? 'Saving...' : 'Pass'}
				</button>
				<button
					type="submit"
					name="outcome"
					value="failed"
					disabled={isSaving}
					class="flex-1 rounded-lg bg-[var(--color-tron-red)] px-6 py-4 text-lg font-semibold text-[var(--color-tron-bg-primary)] transition-all hover:bg-[var(--color-tron-red)]/90 disabled:cursor-not-allowed disabled:opacity-50"
					style="min-height: 44px"
				>
					{isSaving ? 'Saving...' : 'Fail'}
				</button>
			</div>
			<p class="tron-text-muted mt-2 text-center text-xs">
				Recorded against {uploaded.spuUdi ?? 'the uploaded SPU'} — the SPU this file was stored under.
			</p>
		</form>
	{/if}

	<!-- Recent Tests -->
	{#if data.recentSessions.length > 0}
		<div class="tron-card">
			<div class="border-b border-[var(--color-tron-border)] p-4">
				<h2 class="tron-heading text-lg font-semibold">Recent Uploads</h2>
			</div>
			<div class="divide-y divide-[var(--color-tron-border)]">
				{#each data.recentSessions as session (session.id)}
					<a
						href="/validation/thermocouple/{session.id}"
						class="flex items-center justify-between p-4 transition-colors hover:bg-[var(--color-tron-bg-tertiary)]"
					>
						<div>
							<span class="tron-heading font-medium">{session.barcode ?? session.id.slice(0, 8)}</span>
							{#if session.spuUdi}
								<span class="tron-text-muted ml-2 text-sm">({session.spuUdi})</span>
							{/if}
							{#if session.stats}
								<span class="tron-text-muted ml-2 text-sm">
									{session.stats.min.toFixed(1)}°C – {session.stats.max.toFixed(1)}°C{#if session.stats.mode != null}&nbsp;· mode {session.stats.mode.toFixed(1)}°C{/if} (avg {session.stats.average.toFixed(1)}°C)
								</span>
							{/if}
						</div>
						<div class="flex items-center gap-3">
							<span class="tron-text-muted text-sm">{formatDate(session.createdAt)}</span>
							<span class="rounded-full px-2 py-1 text-xs font-medium
								{session.status === 'completed'
									? 'bg-[var(--color-tron-green)]/20 text-[var(--color-tron-green)]'
									: session.status === 'failed'
										? 'bg-[var(--color-tron-red)]/20 text-[var(--color-tron-red)]'
										: 'bg-[var(--color-tron-text-secondary)]/20 text-[var(--color-tron-text-secondary)]'}">
								{session.status === 'completed' ? 'Passed' : session.status === 'failed' ? 'Failed' : 'Pending'}
							</span>
						</div>
					</a>
				{/each}
			</div>
		</div>
	{/if}
</div>
