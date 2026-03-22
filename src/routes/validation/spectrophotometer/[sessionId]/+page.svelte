<script lang="ts">
	import SpectrophotometerResult from '$lib/components/validation/spectrophotometer/SpectrophotometerResult.svelte';
	import SpectrophotometerCapture from '$lib/components/validation/spectrophotometer/SpectrophotometerCapture.svelte';

	interface SpectrophotometerReading {
		wavelength: number;
		absorbance: number;
		transmittance?: number;
	}

	interface SpectrophotometerMetrics {
		peakWavelength: number;
		peakAbsorbance: number;
		baselineAbsorbance: number;
		baselineDrift: number;
		fwhm: number | null;
		integratedAbsorbance: number;
		dataPointCount: number;
		wavelengthRange: { min: number; max: number };
		averageAbsorbance: number;
	}

	interface Props {
		data: {
			session: {
				id: string;
				type: string;
				status: string;
				startedAt: string | null;
				completedAt: string | null;
				createdAt: string;
				barcode: string | null;
				barcodeType: string | null;
				username: string | null;
			};
			result: {
				id: string;
				testType: string;
				rawData: { readings?: SpectrophotometerReading[] } | null;
				processedData: {
					metrics?: SpectrophotometerMetrics;
					interpretation?: string;
					details?: string[];
					failureReasons?: string[];
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
					class: 'bg-[var(--color-tron-green)]/20 text-[var(--color-tron-green)]',
					description: 'Test completed successfully'
				};
			case 'failed':
				return {
					label: 'Failed',
					class: 'bg-[var(--color-tron-red)]/20 text-[var(--color-tron-red)]',
					description: 'Test failed - see results below'
				};
			case 'in_progress':
				return {
					label: 'In Progress',
					class: 'bg-[var(--color-tron-cyan)]/20 text-[var(--color-tron-cyan)]',
					description: 'Waiting for device data...'
				};
			default:
				return {
					label: 'Waiting',
					class: 'bg-[var(--color-tron-text-secondary)]/20 text-[var(--color-tron-text-secondary)]',
					description: 'Waiting for test to start'
				};
		}
	}

	const statusInfo = $derived(getStatusInfo(data.session.status));

	// Check if we have complete result data for visualization
	const hasCompleteResult = $derived(
		data.result?.passed !== null && data.result?.processedData?.metrics !== undefined
	);

	// Extract result data for component
	const resultMetrics = $derived(data.result?.processedData?.metrics);
	const resultInterpretation = $derived(data.result?.processedData?.interpretation ?? '');
	const resultDetails = $derived(data.result?.processedData?.details ?? []);
	const resultFailureReasons = $derived(data.result?.processedData?.failureReasons ?? []);
	const resultReadings = $derived(data.result?.rawData?.readings ?? []);

	function formatDate(dateStr: string): string {
		return new Date(dateStr).toLocaleString();
	}
</script>

<div class="space-y-6">
	<!-- Back Link -->
	<a
		href="/validation/spectrophotometer"
		class="tron-text-muted flex items-center gap-2 text-sm transition-colors hover:text-[var(--color-tron-cyan)]"
	>
		<svg class="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
			<path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M15 19l-7-7 7-7" />
		</svg>
		Back to Spectrophotometer Tests
	</a>

	<!-- Header -->
	<div class="flex items-center justify-between">
		<div>
			<h1 class="tron-heading text-2xl font-bold">Spectrophotometer Test</h1>
			<p class="tron-text-muted mt-1">
				Session: {data.session.barcode ?? data.session.id}
			</p>
		</div>

		<!-- Status Badge -->
		<span class="rounded-full px-3 py-1 text-sm font-medium {statusInfo.class}">
			{statusInfo.label}
		</span>
	</div>

	<!-- Barcode Display Card -->
	<div class="tron-card border-[var(--color-tron-cyan)] p-8 text-center">
		<div class="mb-4">
			<span class="tron-text-muted mb-2 block text-xs uppercase">Tracking Barcode</span>
			<span class="tron-heading font-mono text-4xl font-bold tracking-wider">
				{data.session.barcode ?? 'N/A'}
			</span>
		</div>

		<p class="tron-text-muted text-sm">
			{statusInfo.description}
		</p>

		{#if data.session.status === 'in_progress'}
			<!-- Waiting Animation -->
			<div class="mt-6 flex justify-center">
				<div class="flex items-center gap-2">
					<div class="h-3 w-3 animate-pulse rounded-full bg-[var(--color-tron-cyan)]"></div>
					<div
						class="h-3 w-3 animate-pulse rounded-full bg-[var(--color-tron-cyan)] delay-100"
					></div>
					<div
						class="h-3 w-3 animate-pulse rounded-full bg-[var(--color-tron-cyan)] delay-200"
					></div>
				</div>
			</div>
			<p class="tron-text-muted mt-4 text-sm">
				Connect to the SPU device below to run the spectrophotometer validation test.
			</p>
		{/if}
	</div>

	<!-- Session Info Card -->
	<div class="tron-card p-4">
		<h3 class="tron-heading mb-4 font-semibold">Session Information</h3>
		<div class="grid grid-cols-2 gap-4 md:grid-cols-4">
			<div>
				<span class="tron-text-muted block text-xs uppercase">Barcode</span>
				<span class="tron-heading font-mono font-medium">{data.session.barcode ?? 'N/A'}</span>
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

	{#if hasCompleteResult && resultMetrics}
		<!-- Full Result Visualization -->
		<SpectrophotometerResult
			passed={data.result?.passed ?? false}
			metrics={resultMetrics}
			interpretation={resultInterpretation}
			failureReasons={resultFailureReasons}
			details={resultDetails}
			readings={resultReadings}
		/>

		<!-- Completion Info -->
		{#if data.session.completedAt}
			<div class="tron-card mt-6 p-4">
				<div class="flex items-center justify-between">
					<span class="tron-text-muted text-sm">
						Completed: {formatDate(data.session.completedAt)}
					</span>
					<a
						href="/validation/spectrophotometer/history"
						class="text-sm text-[var(--color-tron-cyan)] hover:underline"
					>
						View All History
					</a>
				</div>
			</div>
		{/if}
	{:else if data.result}
		<!-- Partial Result (processing or legacy data) -->
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
							<span class="text-lg font-bold text-[var(--color-tron-green)]">Test Passed</span>
							<p class="tron-text-muted text-sm">
								Spectrophotometer calibration within acceptable range
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
							<span class="text-lg font-bold text-[var(--color-tron-red)]">Test Failed</span>
							<p class="tron-text-muted text-sm">
								{data.result.notes ?? 'Calibration outside acceptable range'}
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
							<span class="text-lg font-bold text-[var(--color-tron-cyan)]">Processing</span>
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

			{#if data.session.completedAt}
				<div class="mt-4 border-t border-[var(--color-tron-border)] pt-4">
					<span class="tron-text-muted text-sm">
						Completed at: {formatDate(data.session.completedAt)}
					</span>
				</div>
			{/if}
		</div>
	{:else if data.session.status === 'in_progress'}
		<!-- Serial Capture Interface -->
		<SpectrophotometerCapture sessionId={data.session.id} />
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
					d="M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2"
				/>
			</svg>
			<h3 class="tron-heading mt-4 text-lg font-medium">No Results Available</h3>
			<p class="tron-text-muted mt-2">This test session has not received any data yet.</p>
		</div>
	{/if}
</div>
