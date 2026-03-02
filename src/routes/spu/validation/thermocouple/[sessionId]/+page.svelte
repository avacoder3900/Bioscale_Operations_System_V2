<script lang="ts">
	import ThermocoupleResult from '$lib/components/validation/thermocouple/ThermocoupleResult.svelte';

	interface ThermocoupleReading {
		timestamp: number;
		temperature: number;
	}

	interface ThermocoupleStats {
		min: number;
		max: number;
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
	}

	let { data }: Props = $props();

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

	function handlePrint() {
		window.print();
	}
</script>

<div class="space-y-6">
	<!-- Back Link -->
	<div class="flex items-center justify-between print:hidden">
		<a
			href="/spu/validation/thermocouple"
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
						href="/spu/validation/thermocouple/history"
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
				<div
					class="rounded-lg border border-[var(--color-tron-cyan)]/30 bg-[var(--color-tron-cyan)]/10 p-4"
				>
					<div class="flex items-center gap-3">
						<svg
							class="h-8 w-8 text-[var(--color-tron-cyan)]"
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
						<div>
							<span class="text-lg font-bold text-[var(--color-tron-cyan)]"
								>Processing</span
							>
							<p class="tron-text-muted text-sm">Results are being processed...</p>
						</div>
					</div>
				</div>
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
