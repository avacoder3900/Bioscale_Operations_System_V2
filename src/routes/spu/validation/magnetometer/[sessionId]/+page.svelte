<script lang="ts">
	import { enhance } from '$app/forms';
	import TronCard from '$lib/components/ui/TronCard.svelte';
	import TronButton from '$lib/components/ui/TronButton.svelte';

	interface MagWell {
		well: number;
		chA_Z: number | null; chB_Z: number | null; chC_Z: number | null;
		chA_T: number | null; chB_T: number | null; chC_T: number | null;
		[key: string]: any;
	}

	interface Props {
		data: {
			session: {
				id: string;
				status: string;
				startedAt: string | null;
				completedAt: string | null;
				barcode: string | null;
				username: string | null;
				spuUdi: string | null;
				spuId: string | null;
				particleDeviceId: string | null;
				criteriaUsed: { minZ: number; maxZ: number } | null;
				deviceTimestamp: string | null;
			};
			result: {
				id: string;
				testType: string;
				rawData: string | null;
				processedData: {
					metrics: MagWell[] | null;
					interpretation: string;
					failureReasons: string[];
				} | null;
				passed: boolean | null;
				notes: string | null;
				createdAt: string;
			} | null;
		};
		form: any;
	}

	let { data, form }: Props = $props();
	let readingResults = $state(false);

	const wells = (data.result?.processedData?.metrics ?? []) as MagWell[];
	const failureReasons = data.result?.processedData?.failureReasons ?? [];
	const minZ = data.session.criteriaUsed?.minZ ?? 3900;
	const maxZ = data.session.criteriaUsed?.maxZ ?? 4500;

	function zColor(z: number | null): string {
		if (z === null) return 'var(--color-tron-text-secondary)';
		if (z >= minZ && z <= maxZ) return 'var(--color-tron-green)';
		return 'var(--color-tron-red)';
	}

	function zBg(z: number | null): string {
		if (z === null) return 'transparent';
		if (z >= minZ && z <= maxZ) return 'rgba(0,255,128,0.08)';
		return 'rgba(255,0,0,0.08)';
	}
</script>

<div class="space-y-6">
	<!-- Back Links -->
	<div class="flex flex-wrap items-center gap-4">
		<a
			href="/spu/validation/magnetometer"
			class="tron-text-muted flex items-center gap-2 text-sm transition-colors hover:text-[var(--color-tron-cyan)]"
		>
			<svg class="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
				<path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M15 19l-7-7 7-7" />
			</svg>
			Back to Dashboard
		</a>

		{#if data.session.spuId}
			<a
				href="/spu/validation/magnetometer/spu/{data.session.spuId}"
				class="tron-text-muted flex items-center gap-2 text-sm transition-colors hover:text-[var(--color-tron-cyan)]"
			>
				<svg class="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
					<path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M15 19l-7-7 7-7" />
				</svg>
				Back to SPU History
			</a>
		{/if}
	</div>

	<!-- Header -->
	<div class="flex items-center justify-between">
		<div>
			<h1 class="tron-text-primary text-2xl font-bold">Magnetometer Test Result</h1>
			<p class="tron-text-muted mt-1">
				{data.session.spuUdi ?? data.session.barcode ?? data.session.id}
			</p>
		</div>

		<!-- Status Badge -->
		{#if data.result?.passed === true}
			<span class="rounded-full px-4 py-2 text-lg font-bold" style="background: rgba(0,255,128,0.15); color: var(--color-tron-green);">
				✅ PASS
			</span>
		{:else if data.result?.passed === false}
			<span class="rounded-full px-4 py-2 text-lg font-bold" style="background: rgba(255,0,0,0.15); color: var(--color-tron-red);">
				❌ FAIL
			</span>
		{:else if data.session.status === 'running' || data.session.status === 'in_progress'}
			<span class="rounded-full px-4 py-2 text-sm font-medium" style="background: rgba(0,255,255,0.15); color: var(--color-tron-cyan);">
				⏳ Running
			</span>
		{/if}
	</div>

	{#if wells.length > 0}
		<!-- Z-Values Results Table -->
		<TronCard>
			<div class="p-4">
				<h3 class="tron-text-primary mb-3 font-bold">Z-Axis Readings (Gauss)</h3>
				<div class="overflow-x-auto">
					<table class="w-full text-sm">
						<thead>
							<tr class="tron-text-muted border-b" style="border-color: var(--color-tron-border);">
								<th class="px-3 py-2 text-left">Well</th>
								<th class="px-3 py-2 text-center">Ch A (Z)</th>
								<th class="px-3 py-2 text-center">Ch B (Z)</th>
								<th class="px-3 py-2 text-center">Ch C (Z)</th>
							</tr>
						</thead>
						<tbody>
							{#each wells as well (well.well)}
								<tr class="border-b" style="border-color: var(--color-tron-border);">
									<td class="px-3 py-3 font-mono font-bold tron-text-primary">{well.well}</td>
									<td class="px-3 py-3 text-center font-mono font-bold" style="color: {zColor(well.chA_Z)}; background: {zBg(well.chA_Z)};">
										{well.chA_Z ?? '—'}
									</td>
									<td class="px-3 py-3 text-center font-mono font-bold" style="color: {zColor(well.chB_Z)}; background: {zBg(well.chB_Z)};">
										{well.chB_Z ?? '—'}
									</td>
									<td class="px-3 py-3 text-center font-mono font-bold" style="color: {zColor(well.chC_Z)}; background: {zBg(well.chC_Z)};">
										{well.chC_Z ?? '—'}
									</td>
								</tr>
							{/each}
						</tbody>
					</table>
				</div>
				<p class="tron-text-muted mt-3 text-xs">
					Green = within range ({minZ}–{maxZ}) · Red = outside range
				</p>
			</div>
		</TronCard>

		<!-- Failure Details -->
		{#if failureReasons.length > 0}
			<TronCard>
				<div class="p-4">
					<h3 class="mb-2 font-bold" style="color: var(--color-tron-red);">Failures</h3>
					<ul class="space-y-1">
						{#each failureReasons as reason}
							<li class="text-sm" style="color: var(--color-tron-red);">• {reason}</li>
						{/each}
					</ul>
				</div>
			</TronCard>
		{/if}
	{:else if data.session.status === 'running' || data.session.status === 'in_progress'}
		<!-- Test Running — offer to read results -->
		<TronCard>
			<div class="p-8 text-center space-y-4">
				<div class="mx-auto h-12 w-12 animate-spin rounded-full border-4 border-[var(--color-tron-cyan)] border-t-transparent"></div>
				<h3 class="tron-text-primary text-lg font-medium">Test Running…</h3>
				<p class="tron-text-muted">When the test completes on the device, click below to read results.</p>

				<form
					method="POST"
					action="?/readResults"
					use:enhance={() => {
						readingResults = true;
						return async ({ update }) => {
							readingResults = false;
							await update();
						};
					}}
				>
					<TronButton type="submit" variant="primary" disabled={readingResults} style="min-height: 48px;">
						{readingResults ? 'Reading…' : '📖 Read Results from Device'}
					</TronButton>
				</form>

				{#if form?.error}
					<p class="text-sm" style="color: var(--color-tron-red);">{form.error}</p>
				{/if}
			</div>
		</TronCard>
	{:else}
		<TronCard>
			<div class="p-8 text-center">
				<p class="tron-text-muted">No results available for this session.</p>
			</div>
		</TronCard>
	{/if}

	<!-- Session Info -->
	<TronCard>
		<div class="p-4">
			<h3 class="tron-text-primary mb-3 font-semibold">Session Info</h3>
			<div class="grid grid-cols-2 gap-4 md:grid-cols-4">
				<div>
					<span class="tron-text-muted block text-xs uppercase">SPU</span>
					<span class="tron-text-primary font-mono font-medium">{data.session.spuUdi ?? 'N/A'}</span>
				</div>
				<div>
					<span class="tron-text-muted block text-xs uppercase">Started</span>
					<span class="tron-text-primary font-medium">
						{data.session.startedAt ? new Date(data.session.startedAt).toLocaleString() : '—'}
					</span>
				</div>
				<div>
					<span class="tron-text-muted block text-xs uppercase">Completed</span>
					<span class="tron-text-primary font-medium">
						{data.session.completedAt ? new Date(data.session.completedAt).toLocaleString() : '—'}
					</span>
				</div>
				<div>
					<span class="tron-text-muted block text-xs uppercase">Operator</span>
					<span class="tron-text-primary font-medium">{data.session.username ?? 'N/A'}</span>
				</div>
				{#if data.session.criteriaUsed}
					<div>
						<span class="tron-text-muted block text-xs uppercase">Criteria Used</span>
						<span class="tron-text-primary font-mono font-medium">
							Z: {data.session.criteriaUsed.minZ} – {data.session.criteriaUsed.maxZ}
						</span>
					</div>
				{/if}
				{#if data.session.deviceTimestamp}
					<div>
						<span class="tron-text-muted block text-xs uppercase">Device Timestamp</span>
						<span class="tron-text-primary font-mono font-medium">{data.session.deviceTimestamp}</span>
					</div>
				{/if}
			</div>
		</div>
	</TronCard>

	<!-- Raw Data (expandable) -->
	{#if data.result?.rawData}
		<TronCard>
			<details class="p-4">
				<summary class="tron-text-muted cursor-pointer text-sm font-medium">Raw Device Output</summary>
				<pre class="mt-3 overflow-x-auto rounded bg-black/30 p-3 text-xs text-[var(--color-tron-text-secondary)]">{data.result.rawData}</pre>
			</details>
		</TronCard>
	{/if}
</div>
