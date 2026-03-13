<script lang="ts">
	interface Props {
		/** Whether the test passed */
		passed: boolean | null;
		/** Test completion timestamp */
		completedAt: string | null;
		/** Username of the person who ran the test */
		username: string | null;
		/** Tracking barcode */
		barcode: string | null;
		/** Validation type display name */
		testType: string;
		/** Processed/interpreted results to display prominently */
		processedData?: Record<string, unknown> | null;
		/** Raw measurement data (shown in collapsible section) */
		rawData?: Record<string, unknown> | null;
		/** Interpretation or summary text */
		interpretation?: string;
		/** Array of failure reasons if test failed */
		failureReasons?: string[];
	}

	let {
		passed,
		completedAt,
		username,
		barcode,
		testType,
		processedData = null,
		rawData = null,
		interpretation = '',
		failureReasons = []
	}: Props = $props();

	let showRawData = $state(false);

	function formatDate(dateStr: string | null): string {
		if (!dateStr) return 'N/A';
		return new Date(dateStr).toLocaleString();
	}

	function formatValue(value: unknown): string {
		if (value === null || value === undefined) return 'N/A';
		if (typeof value === 'number') return value.toFixed(4);
		if (typeof value === 'object') return JSON.stringify(value, null, 2);
		return String(value);
	}

	function handlePrint() {
		window.print();
	}
</script>

<div class="space-y-6 print:space-y-4">
	<!-- Pass/Fail Indicator -->
	<div class="flex items-center justify-between">
		<div class="flex items-center gap-4">
			{#if passed === null}
				<div class="flex h-16 w-16 items-center justify-center rounded-full bg-[var(--color-tron-text-secondary)]/20">
					<svg class="h-8 w-8 text-[var(--color-tron-text-secondary)]" fill="none" viewBox="0 0 24 24" stroke="currentColor">
						<path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M8.228 9c.549-1.165 2.03-2 3.772-2 2.21 0 4 1.343 4 3 0 1.4-1.278 2.575-3.006 2.907-.542.104-.994.54-.994 1.093m0 3h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
					</svg>
				</div>
				<div>
					<h2 class="tron-heading text-2xl font-bold">Pending</h2>
					<p class="tron-text-muted">Test not yet evaluated</p>
				</div>
			{:else if passed}
				<div class="flex h-16 w-16 items-center justify-center rounded-full bg-[var(--color-tron-green)]/20 print:border-2 print:border-green-600">
					<svg class="h-8 w-8 text-[var(--color-tron-green)] print:text-green-600" fill="none" viewBox="0 0 24 24" stroke="currentColor">
						<path stroke-linecap="round" stroke-linejoin="round" stroke-width="3" d="M5 13l4 4L19 7" />
					</svg>
				</div>
				<div>
					<h2 class="text-2xl font-bold text-[var(--color-tron-green)] print:text-green-600">PASSED</h2>
					<p class="tron-text-muted">{testType} validation successful</p>
				</div>
			{:else}
				<div class="flex h-16 w-16 items-center justify-center rounded-full bg-[var(--color-tron-red)]/20 print:border-2 print:border-red-600">
					<svg class="h-8 w-8 text-[var(--color-tron-red)] print:text-red-600" fill="none" viewBox="0 0 24 24" stroke="currentColor">
						<path stroke-linecap="round" stroke-linejoin="round" stroke-width="3" d="M6 18L18 6M6 6l12 12" />
					</svg>
				</div>
				<div>
					<h2 class="text-2xl font-bold text-[var(--color-tron-red)] print:text-red-600">FAILED</h2>
					<p class="tron-text-muted">{testType} validation failed</p>
				</div>
			{/if}
		</div>

		<button
			onclick={handlePrint}
			class="tron-btn-secondary flex items-center gap-2 print:hidden"
		>
			<svg class="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
				<path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M17 17h2a2 2 0 002-2v-4a2 2 0 00-2-2H5a2 2 0 00-2 2v4a2 2 0 002 2h2m2 4h6a2 2 0 002-2v-4a2 2 0 00-2-2H9a2 2 0 00-2 2v4a2 2 0 002 2zm8-12V5a2 2 0 00-2-2H9a2 2 0 00-2 2v4h10z" />
			</svg>
			Print
		</button>
	</div>

	<!-- Test Metadata -->
	<div class="tron-card grid grid-cols-2 gap-4 p-4 md:grid-cols-4 print:border print:border-gray-300">
		<div>
			<span class="tron-text-muted block text-xs uppercase">Barcode</span>
			<span class="tron-heading font-mono font-medium">{barcode ?? 'N/A'}</span>
		</div>
		<div>
			<span class="tron-text-muted block text-xs uppercase">Test Type</span>
			<span class="tron-heading font-medium">{testType}</span>
		</div>
		<div>
			<span class="tron-text-muted block text-xs uppercase">Completed</span>
			<span class="tron-heading font-medium">{formatDate(completedAt)}</span>
		</div>
		<div>
			<span class="tron-text-muted block text-xs uppercase">Tested By</span>
			<span class="tron-heading font-medium">{username ?? 'N/A'}</span>
		</div>
	</div>

	<!-- Interpretation -->
	{#if interpretation}
		<div class="tron-card p-4 print:border print:border-gray-300">
			<h3 class="tron-heading mb-2 font-semibold">Interpretation</h3>
			<p class="tron-text-secondary">{interpretation}</p>
		</div>
	{/if}

	<!-- Failure Reasons -->
	{#if failureReasons.length > 0}
		<div class="rounded-lg border border-[var(--color-tron-red)]/30 bg-[var(--color-tron-red)]/10 p-4 print:border-red-300">
			<h3 class="mb-2 font-semibold text-[var(--color-tron-red)] print:text-red-600">Failure Reasons</h3>
			<ul class="list-inside list-disc space-y-1 text-[var(--color-tron-red)] print:text-red-600">
				{#each failureReasons as reason, i (i)}
					<li>{reason}</li>
				{/each}
			</ul>
		</div>
	{/if}

	<!-- Processed Data -->
	{#if processedData && Object.keys(processedData).length > 0}
		<div class="tron-card p-4 print:border print:border-gray-300">
			<h3 class="tron-heading mb-4 font-semibold">Results</h3>
			<div class="grid grid-cols-2 gap-4 md:grid-cols-3">
				{#each Object.entries(processedData) as [key, value] (key)}
					<div class="rounded-lg bg-[var(--color-tron-bg-tertiary)] p-3 print:bg-gray-100">
						<span class="tron-text-muted block text-xs uppercase">{key.replace(/_/g, ' ')}</span>
						<span class="tron-heading font-mono text-lg font-medium">{formatValue(value)}</span>
					</div>
				{/each}
			</div>
		</div>
	{/if}

	<!-- Raw Data (Collapsible) -->
	{#if rawData}
		<div class="tron-card print:border print:border-gray-300">
			<button
				onclick={() => (showRawData = !showRawData)}
				class="flex w-full items-center justify-between p-4 text-left print:hidden"
			>
				<h3 class="tron-heading font-semibold">Raw Data</h3>
				<svg
					class="h-5 w-5 transition-transform {showRawData ? 'rotate-180' : ''}"
					fill="none"
					viewBox="0 0 24 24"
					stroke="currentColor"
				>
					<path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M19 9l-7 7-7-7" />
				</svg>
			</button>

			{#if showRawData}
				<div class="border-t border-[var(--color-tron-border)] p-4">
					<pre class="overflow-x-auto rounded-lg bg-[var(--color-tron-bg-tertiary)] p-4 text-sm print:bg-gray-100">{JSON.stringify(rawData, null, 2)}</pre>
				</div>
			{/if}

			<!-- Always show in print -->
			<div class="hidden border-t border-gray-300 p-4 print:block">
				<h3 class="mb-2 font-semibold">Raw Data</h3>
				<pre class="overflow-x-auto rounded bg-gray-100 p-2 text-xs">{JSON.stringify(rawData, null, 2)}</pre>
			</div>
		</div>
	{/if}
</div>

<style>
	@media print {
		:global(body) {
			-webkit-print-color-adjust: exact;
			print-color-adjust: exact;
		}
	}
</style>
