<script lang="ts">
	import { enhance } from '$app/forms';
	import TronCard from '$lib/components/ui/TronCard.svelte';
	import TronButton from '$lib/components/ui/TronButton.svelte';

	interface MagWell {
		well: number;
		chA_X: number | null; chB_X: number | null; chC_X: number | null;
		chA_Y: number | null; chB_Y: number | null; chC_Y: number | null;
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
				/** When the test actually ran on the device. Null = genuinely unknown. */
				testRanAt: string | null;
				pullDelaySeconds: number | null;
				barcode: string | null;
				username: string | null;
				spuUdi: string | null;
				particleDeviceId: string | null;
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

	function fmt(v: number | null): string {
		return v == null || Number.isNaN(v) ? '—' : v.toFixed(1);
	}

	function mag(x: number | null, y: number | null, z: number | null): number | null {
		if (x == null || y == null || z == null) return null;
		if (Number.isNaN(x) || Number.isNaN(y) || Number.isNaN(z)) return null;
		return Math.sqrt(x * x + y * y + z * z);
	}

</script>

<div class="space-y-6">
	<!-- Back Link -->
	<a
		href="/validation/magnetometer"
		class="tron-text-muted flex items-center gap-2 text-sm transition-colors hover:text-[var(--color-tron-cyan)]"
	>
		<svg class="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
			<path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M15 19l-7-7 7-7" />
		</svg>
		Back to Magnetometer Tests
	</a>

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
				<h3 class="tron-text-primary mb-3 font-bold">Magnetic Field Readings (Gauss)</h3>
				<div class="overflow-x-auto">
					<table class="w-full text-sm">
						<thead>
							<tr class="tron-text-muted" style="border-color: var(--color-tron-border);">
								<th class="px-2 py-2 text-left" rowspan="2">Well</th>
								<th class="px-2 py-2 text-center" colspan="4" style="border-left: 1px solid var(--color-tron-border);">Channel A</th>
								<th class="px-2 py-2 text-center" colspan="4" style="border-left: 1px solid var(--color-tron-border);">Channel B</th>
								<th class="px-2 py-2 text-center" colspan="4" style="border-left: 1px solid var(--color-tron-border);">Channel C</th>
							</tr>
							<tr class="tron-text-muted border-b" style="border-color: var(--color-tron-border);">
								<th class="px-2 py-1 text-right" style="border-left: 1px solid var(--color-tron-border);">X</th>
								<th class="px-2 py-1 text-right">Y</th>
								<th class="px-2 py-1 text-right">Z</th>
								<th class="px-2 py-1 text-right">|B|</th>
								<th class="px-2 py-1 text-right" style="border-left: 1px solid var(--color-tron-border);">X</th>
								<th class="px-2 py-1 text-right">Y</th>
								<th class="px-2 py-1 text-right">Z</th>
								<th class="px-2 py-1 text-right">|B|</th>
								<th class="px-2 py-1 text-right" style="border-left: 1px solid var(--color-tron-border);">X</th>
								<th class="px-2 py-1 text-right">Y</th>
								<th class="px-2 py-1 text-right">Z</th>
								<th class="px-2 py-1 text-right">|B|</th>
							</tr>
						</thead>
						<tbody>
							{#each wells as well (well.well)}
								<tr class="border-b" style="border-color: var(--color-tron-border);">
									<td class="px-2 py-2 font-mono font-bold tron-text-primary">{well.well}</td>
									{#if well.error}
										<td colspan="12" class="px-3 py-3 text-center text-sm" style="color: var(--color-tron-red);">
											⚠️ {well.error}
										</td>
									{:else}
										<td class="px-2 py-2 text-right font-mono tron-text-muted" style="border-left: 1px solid var(--color-tron-border);">{fmt(well.chA_X)}</td>
										<td class="px-2 py-2 text-right font-mono tron-text-muted">{fmt(well.chA_Y)}</td>
										<td class="px-2 py-2 text-right font-mono tron-text-primary">{fmt(well.chA_Z)}</td>
										<td class="px-2 py-2 text-right font-mono font-bold tron-text-primary">{fmt(mag(well.chA_X, well.chA_Y, well.chA_Z))}</td>
										<td class="px-2 py-2 text-right font-mono tron-text-muted" style="border-left: 1px solid var(--color-tron-border);">{fmt(well.chB_X)}</td>
										<td class="px-2 py-2 text-right font-mono tron-text-muted">{fmt(well.chB_Y)}</td>
										<td class="px-2 py-2 text-right font-mono tron-text-primary">{fmt(well.chB_Z)}</td>
										<td class="px-2 py-2 text-right font-mono font-bold tron-text-primary">{fmt(mag(well.chB_X, well.chB_Y, well.chB_Z))}</td>
										<td class="px-2 py-2 text-right font-mono tron-text-muted" style="border-left: 1px solid var(--color-tron-border);">{fmt(well.chC_X)}</td>
										<td class="px-2 py-2 text-right font-mono tron-text-muted">{fmt(well.chC_Y)}</td>
										<td class="px-2 py-2 text-right font-mono tron-text-primary">{fmt(well.chC_Z)}</td>
										<td class="px-2 py-2 text-right font-mono font-bold tron-text-primary">{fmt(mag(well.chC_X, well.chC_Y, well.chC_Z))}</td>
									{/if}
								</tr>
							{/each}
						</tbody>
					</table>
				</div>
				<p class="tron-text-muted mt-3 text-xs">
					All values in Gauss, as reported by the magnetometer. |B| = √(X² + Y² + Z²).
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
					<span class="tron-text-muted block text-xs uppercase">Test run</span>
					<span class="tron-text-primary font-medium">
						{#if data.session.testRanAt}
							{new Date(data.session.testRanAt).toLocaleString()}
							{#if data.session.pullDelaySeconds != null && data.session.pullDelaySeconds > 3600}
								<span
									style="color: var(--color-tron-orange);"
									title="The device was still holding this result when BIMS read it, so it was already stale at that point."
								>⚠</span>
							{/if}
						{:else}
							<span
								class="tron-text-muted"
								title="This payload carries no timestamp (legacy format), so the run time is genuinely unknown. It is deliberately not filled in with the time the data was recorded."
							>unknown</span>
						{/if}
					</span>
				</div>
				<div>
					<!-- Distinct from the above: the magnet_validation variable holds an
					     earlier run_test, so reading it is not measuring it. -->
					<span class="tron-text-muted block text-xs uppercase">Recorded in BIMS</span>
					<span class="tron-text-primary font-medium">
						{data.session.completedAt ? new Date(data.session.completedAt).toLocaleString() : '—'}
					</span>
				</div>
				<div>
					<span class="tron-text-muted block text-xs uppercase">Operator</span>
					<span class="tron-text-primary font-medium">{data.session.username ?? 'N/A'}</span>
				</div>
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
