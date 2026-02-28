<script lang="ts">
	import ValidationResult from '$lib/components/validation/ValidationResult.svelte';

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
				rawData: Record<string, unknown> | null;
				processedData: Record<string, unknown> | null;
				passed: boolean | null;
				notes: string | null;
				createdAt: string;
			} | null;
		};
	}

	let { data }: Props = $props();

	// Extract interpretation from processed data if available
	const interpretation =
		(data.result?.processedData?.interpretation as string) ??
		(data.result?.notes ?? '');

	// Extract failure reasons from processed data
	const failureReasons = (data.result?.processedData?.failureReasons as string[]) ?? [];

	// Extract metrics for display
	const metrics = data.result?.processedData?.metrics as Record<string, unknown> | undefined;
</script>

<div class="space-y-6">
	<!-- Back Link -->
	<a
		href="/spu/validation/magnetometer"
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
			<h1 class="tron-heading text-2xl font-bold">Magnetometer Test Result</h1>
			<p class="tron-text-muted mt-1">
				Session: {data.session.barcode ?? data.session.id}
			</p>
		</div>

		<!-- Status Badge -->
		<div>
			{#if data.session.status === 'completed'}
				<span class="rounded-full bg-[var(--color-tron-green)]/20 px-3 py-1 text-sm font-medium text-[var(--color-tron-green)]">
					Completed
				</span>
			{:else if data.session.status === 'failed'}
				<span class="rounded-full bg-[var(--color-tron-red)]/20 px-3 py-1 text-sm font-medium text-[var(--color-tron-red)]">
					Failed
				</span>
			{:else if data.session.status === 'in_progress'}
				<span class="rounded-full bg-[var(--color-tron-cyan)]/20 px-3 py-1 text-sm font-medium text-[var(--color-tron-cyan)]">
					In Progress
				</span>
			{:else}
				<span class="rounded-full bg-[var(--color-tron-text-secondary)]/20 px-3 py-1 text-sm font-medium text-[var(--color-tron-text-secondary)]">
					{data.session.status}
				</span>
			{/if}
		</div>
	</div>

	{#if data.result}
		<ValidationResult
			passed={data.result.passed}
			completedAt={data.session.completedAt}
			username={data.session.username}
			barcode={data.session.barcode}
			testType="Magnetometer"
			processedData={metrics}
			rawData={data.result.rawData}
			{interpretation}
			{failureReasons}
		/>
	{:else}
		<!-- No result yet -->
		<div class="tron-card p-8 text-center">
			<svg class="mx-auto h-12 w-12 text-[var(--color-tron-text-secondary)]" fill="none" viewBox="0 0 24 24" stroke="currentColor">
				<path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z" />
			</svg>
			<h3 class="tron-heading mt-4 text-lg font-medium">Test In Progress</h3>
			<p class="tron-text-muted mt-2">
				Results will appear here once the magnetometer test is complete.
			</p>
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
						{data.session.startedAt ? new Date(data.session.startedAt).toLocaleString() : 'Not started'}
					</span>
				</div>
				<div>
					<span class="tron-text-muted block text-xs uppercase">User</span>
					<span class="tron-heading font-medium">{data.session.username ?? 'N/A'}</span>
				</div>
				<div>
					<span class="tron-text-muted block text-xs uppercase">Status</span>
					<span class="tron-heading font-medium capitalize">{data.session.status}</span>
				</div>
			</div>
		</div>
	{/if}
</div>
