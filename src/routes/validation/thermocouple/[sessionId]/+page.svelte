<script lang="ts">
	import { enhance } from '$app/forms';
	import ThermocoupleResult from '$lib/components/validation/thermocouple/ThermocoupleResult.svelte';
	import ThermocoupleChart from '$lib/components/validation/thermocouple/ThermocoupleChart.svelte';

	interface ThermocoupleReading {
		timestamp: number;
		temperature: number;
	}

	interface ThermocoupleStats {
		min: number;
		max: number;
		mode?: number;
		cv?: number;
		average: number;
		stdDev: number;
		range: number;
		drift: number;
		readingCount: number;
		outOfRangeCount: number;
		durationMs: number;
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
			};
			result: {
				id: string;
				testType: string;
				rawData: { readings?: ThermocoupleReading[] } | null;
				processedData: {
					stats?: ThermocoupleStats;
					interpretation?: string;
					failureReasons?: string[];
					criteria?: { minTemp?: number; maxTemp?: number };
				} | null;
				passed: boolean | null;
				notes: string | null;
				createdAt: string;
			} | null;
		};
		form: { error?: string; success?: boolean; passed?: boolean } | null;
	}

	let { data, form }: Props = $props();

	let isSaving = $state(false);
	let showFahrenheit = $state(false);

	function getStatusInfo(status: string) {
		switch (status) {
			case 'completed':
				return {
					label: 'Completed',
					class: 'bg-[var(--color-tron-green)]/20 text-[var(--color-tron-green)]'
				};
			case 'failed':
				return {
					label: 'Failed',
					class: 'bg-[var(--color-tron-red)]/20 text-[var(--color-tron-red)]'
				};
			case 'in_progress':
				return {
					label: 'In Progress',
					class: 'bg-[var(--color-tron-cyan)]/20 text-[var(--color-tron-cyan)]'
				};
			default:
				return {
					label: 'Pending',
					class: 'bg-[var(--color-tron-text-secondary)]/20 text-[var(--color-tron-text-secondary)]'
				};
		}
	}

	const statusInfo = $derived(getStatusInfo(data.session.status));

	// Check if we have complete result data for visualization
	const hasCompleteResult = $derived(
		data.result?.passed !== null && data.result?.processedData?.stats !== undefined
	);

	// Extract result data for components
	const resultStats = $derived(data.result?.processedData?.stats);
	const resultInterpretation = $derived(
		(data.result?.processedData?.interpretation as string) ?? (data.result?.notes ?? '')
	);
	const resultFailureReasons = $derived(data.result?.processedData?.failureReasons ?? []);
	const resultReadings = $derived(
		(data.result?.rawData?.readings as ThermocoupleReading[]) ?? []
	);
	const minTemp = $derived(data.result?.processedData?.criteria?.minTemp);
	const maxTemp = $derived(data.result?.processedData?.criteria?.maxTemp);

	function formatDate(dateStr: string): string {
		return new Date(dateStr).toLocaleString();
	}

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

	function handlePrint() {
		window.print();
	}
</script>

<div class="space-y-6">
	<!-- Back Link -->
	<div class="flex items-center justify-between print:hidden">
		<a
			href="/validation/thermocouple"
			class="tron-text-muted flex items-center gap-2 text-sm transition-colors hover:text-[var(--color-tron-cyan)]"
		>
			<svg class="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
				<path
					stroke-linecap="round"
					stroke-linejoin="round"
					stroke-width="2"
					d="M15 19l-7-7 7-7"
				/>
			</svg>
			Back to Thermocouple Tests
		</a>

		{#if hasCompleteResult}
			<button
				onclick={handlePrint}
				class="tron-button flex items-center gap-2 px-4 py-2 text-sm"
				style="min-height: 44px"
			>
				<svg class="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
					<path
						stroke-linecap="round"
						stroke-linejoin="round"
						stroke-width="2"
						d="M17 17h2a2 2 0 002-2v-4a2 2 0 00-2-2H5a2 2 0 00-2 2v4a2 2 0 002 2h2m2 4h6a2 2 0 002-2v-4a2 2 0 00-2-2H9a2 2 0 00-2 2v4a2 2 0 002 2zm8-12V5a2 2 0 00-2-2H9a2 2 0 00-2 2v4h10z"
					/>
				</svg>
				Print Report
			</button>
		{/if}
	</div>

	<!-- Header -->
	<div class="flex items-center justify-between">
		<div>
			<h1
				class="tron-heading text-2xl font-bold"
				style="color: var(--color-tron-cyan, #00ffff)"
			>
				Thermocouple Test Result
			</h1>
			<p class="tron-text-muted mt-1">
				Session: {data.session.barcode ?? data.session.id}
			</p>
		</div>

		<!-- Status Badge -->
		<span class="rounded-full px-3 py-1 text-sm font-medium {statusInfo.class}">
			{statusInfo.label}
		</span>
	</div>

	<!-- Session Info Card -->
	<div class="tron-card p-4">
		<h3 class="tron-heading mb-4 font-semibold">Session Information</h3>
		<div class="grid grid-cols-2 gap-4 md:grid-cols-4">
			<div>
				<span class="tron-text-muted block text-xs uppercase">Barcode</span>
				<span class="tron-heading font-mono font-medium"
					>{data.session.barcode ?? 'N/A'}</span
				>
			</div>
			<div>
				<span class="tron-text-muted block text-xs uppercase">Started</span>
				<span class="tron-heading font-medium">
					{data.session.startedAt
						? new Date(data.session.startedAt).toLocaleString()
						: 'Not started'}
				</span>
			</div>
			<div>
				<span class="tron-text-muted block text-xs uppercase">User</span>
				<span class="tron-heading font-medium">{data.session.username ?? 'N/A'}</span>
			</div>
			<div>
				<span class="tron-text-muted block text-xs uppercase">Status</span>
				<span class="tron-heading font-medium capitalize"
					>{data.session.status.replace('_', ' ')}</span
				>
			</div>
		</div>
	</div>

	{#if hasCompleteResult && resultStats}
		<!-- Full Result Visualization -->
		<ThermocoupleResult
			passed={data.result?.passed ?? false}
			stats={resultStats}
			interpretation={resultInterpretation}
			failureReasons={resultFailureReasons}
			readings={resultReadings}
			{minTemp}
			{maxTemp}
		/>

		<!-- Completion Info -->
		{#if data.session.completedAt}
			<div class="tron-card p-4 print:hidden">
				<div class="flex items-center justify-between">
					<span class="tron-text-muted text-sm">
						Completed: {formatDate(data.session.completedAt)}
					</span>
					<a
						href="/validation/thermocouple"
						class="text-sm text-[var(--color-tron-cyan)] hover:underline"
					>
						View All History
					</a>
				</div>
			</div>
		{/if}
	{:else if data.result}
		<!-- Partial Result -->
		<div class="tron-card p-4">
			<h3 class="tron-heading mb-4 font-semibold">Test Results</h3>

			{#if data.result.passed === true}
				<div
					class="rounded-lg border border-[var(--color-tron-green)]/30 bg-[var(--color-tron-green)]/10 p-4"
				>
					<div class="flex items-center gap-3">
						<svg
							class="h-8 w-8 text-[var(--color-tron-green)]"
							fill="none"
							viewBox="0 0 24 24"
							stroke="currentColor"
						>
							<path
								stroke-linecap="round"
								stroke-linejoin="round"
								stroke-width="2"
								d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z"
							/>
						</svg>
						<div>
							<span class="text-lg font-bold text-[var(--color-tron-green)]"
								>Test Passed</span
							>
							<p class="tron-text-muted text-sm">
								Thermocouple readings within acceptable range
							</p>
						</div>
					</div>
				</div>
			{:else if data.result.passed === false}
				<div
					class="rounded-lg border border-[var(--color-tron-red)]/30 bg-[var(--color-tron-red)]/10 p-4"
				>
					<div class="flex items-center gap-3">
						<svg
							class="h-8 w-8 text-[var(--color-tron-red)]"
							fill="none"
							viewBox="0 0 24 24"
							stroke="currentColor"
						>
							<path
								stroke-linecap="round"
								stroke-linejoin="round"
								stroke-width="2"
								d="M10 14l2-2m0 0l2-2m-2 2l-2-2m2 2l2 2m7-2a9 9 0 11-18 0 9 9 0 0118 0z"
							/>
						</svg>
						<div>
							<span class="text-lg font-bold text-[var(--color-tron-red)]"
								>Test Failed</span
							>
							<p class="tron-text-muted text-sm">
								{data.result.notes ?? 'Temperature readings outside acceptable range'}
							</p>
						</div>
					</div>
				</div>
			{:else}
				<!--
					Awaiting a verdict. No acceptance range is configured, so nothing
					judges this automatically and the session would otherwise sit here
					forever once the uploader's post-POST state was gone. The operator
					reviews the stored numbers and records the call right here.
				-->
				<div
					class="rounded-lg border border-[var(--color-tron-orange)]/30 bg-[var(--color-tron-orange)]/10 p-4"
				>
					<div class="flex items-center justify-between gap-3">
						<div>
							<span class="text-lg font-bold text-[var(--color-tron-orange)]"
								>Awaiting verdict</span
							>
							<p class="tron-text-muted text-sm">
								The readings below are what was stored for this session. Review them and
								record Pass or Fail — that verdict is the record.
							</p>
						</div>
						{#if resultStats}
							<button
								type="button"
								onclick={() => (showFahrenheit = !showFahrenheit)}
								class="shrink-0 rounded-lg bg-[var(--color-tron-bg-tertiary)] px-4 py-2 text-sm font-medium text-[var(--color-tron-text-secondary)] transition-colors hover:text-[var(--color-tron-cyan)] print:hidden"
							>
								Show in {showFahrenheit ? '°C' : '°F'}
							</button>
						{/if}
					</div>
				</div>

				{#if resultStats}
					<div class="mt-4 grid grid-cols-2 gap-4 md:grid-cols-4">
						{#if resultStats.mode !== undefined}
							<div class="rounded-lg border border-[var(--color-tron-cyan)]/30 bg-[var(--color-tron-bg-tertiary)] p-4 text-center">
								<span class="tron-text-muted block text-xs uppercase">Mode</span>
								<span class="tron-heading text-2xl font-bold">{fmtTemp(resultStats.mode)}</span>
							</div>
						{/if}
						<div class="rounded-lg border border-[var(--color-tron-cyan)]/30 bg-[var(--color-tron-bg-tertiary)] p-4 text-center">
							<span class="tron-text-muted block text-xs uppercase">Min</span>
							<span class="tron-heading text-2xl font-bold">{fmtTemp(resultStats.min)}</span>
						</div>
						<div class="rounded-lg border border-[var(--color-tron-cyan)]/30 bg-[var(--color-tron-bg-tertiary)] p-4 text-center">
							<span class="tron-text-muted block text-xs uppercase">Max</span>
							<span class="tron-heading text-2xl font-bold">{fmtTemp(resultStats.max)}</span>
						</div>
						<div class="rounded-lg bg-[var(--color-tron-bg-tertiary)] p-4 text-center">
							<span class="tron-text-muted block text-xs uppercase">Average</span>
							<span class="tron-heading text-2xl font-bold">{fmtTemp(resultStats.average)}</span>
						</div>
						<div class="rounded-lg bg-[var(--color-tron-bg-tertiary)] p-4 text-center">
							<span class="tron-text-muted block text-xs uppercase">Std Dev</span>
							<span class="tron-heading text-2xl font-bold">{resultStats.stdDev.toFixed(3)}</span>
						</div>
						{#if resultStats.cv !== undefined}
							<div class="rounded-lg bg-[var(--color-tron-bg-tertiary)] p-4 text-center">
								<span class="tron-text-muted block text-xs uppercase">CV %</span>
								<span class="tron-heading text-2xl font-bold">{resultStats.cv.toFixed(2)}%</span>
							</div>
						{/if}
						<div class="rounded-lg bg-[var(--color-tron-bg-tertiary)] p-4 text-center">
							<span class="tron-text-muted block text-xs uppercase">Range</span>
							<span class="tron-heading text-2xl font-bold">{fmtTemp(resultStats.range)}</span>
						</div>
						<div class="rounded-lg bg-[var(--color-tron-bg-tertiary)] p-4 text-center">
							<span class="tron-text-muted block text-xs uppercase">Readings</span>
							<span class="tron-heading text-2xl font-bold">{resultStats.readingCount}</span>
						</div>
						<div class="rounded-lg bg-[var(--color-tron-bg-tertiary)] p-4 text-center">
							<span class="tron-text-muted block text-xs uppercase">Duration</span>
							<span class="tron-heading text-2xl font-bold">{formatDuration(resultStats.durationMs)}</span>
						</div>
					</div>
				{/if}

				{#if resultReadings.length > 0}
					<div class="mt-4">
						<ThermocoupleChart readings={resultReadings} showBands={false} />
					</div>
				{/if}

				{#if form?.error}
					<div class="mt-4 rounded-lg bg-[var(--color-tron-red)]/10 p-4 text-[var(--color-tron-red)]">
						{form.error}
					</div>
				{/if}

				<form
					method="POST"
					action="?/verdict"
					class="mt-4 print:hidden"
					use:enhance={() => {
						isSaving = true;
						return async ({ update }) => {
							await update();
							isSaving = false;
						};
					}}
				>
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
						Recorded against {data.session.barcode ?? 'this session'} — the readings stored under it.
					</p>
				</form>
			{/if}

			{#if data.result.notes}
				<div class="mt-4 border-t border-[var(--color-tron-border)] pt-4">
					<h4 class="tron-text-muted mb-2 text-xs uppercase">Notes</h4>
					<p class="tron-heading text-sm">{data.result.notes}</p>
				</div>
			{/if}
		</div>
	{:else}
		<!-- No Result Yet -->
		<div class="tron-card p-8 text-center">
			<svg
				class="mx-auto h-12 w-12 text-[var(--color-tron-text-secondary)]"
				fill="none"
				viewBox="0 0 24 24"
				stroke="currentColor"
			>
				<path
					stroke-linecap="round"
					stroke-linejoin="round"
					stroke-width="2"
					d="M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z"
				/>
			</svg>
			<h3 class="tron-heading mt-4 text-lg font-medium">Test In Progress</h3>
			<p class="tron-text-muted mt-2">
				Results will appear here once the thermocouple test is complete.
			</p>
		</div>
	{/if}
</div>
