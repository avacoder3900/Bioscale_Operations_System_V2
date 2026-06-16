<script lang="ts">
	interface ProcessedParam {
		name?: string;
		channel?: number | string;
		value?: number;
		min?: number;
		max?: number;
		target?: number;
		unit?: string;
		passed?: boolean;
		required?: boolean;
	}

	interface RawReading {
		readingNumber?: number;
		channel?: number | string;
		value?: number;
		timestampMs?: number;
	}

	interface SessionResult {
		_id?: string;
		testType?: string;
		rawData?: { readings?: RawReading[] } | null;
		processedData?: ProcessedParam[] | Record<string, unknown> | null;
		passed?: boolean | null;
		notes?: string | null;
		createdAt?: string | null;
	}

	interface Session {
		_id: string;
		type?: string;
		spuId?: string;
		spuUdi?: string | null;
		status: string;
		startedAt?: string | null;
		completedAt?: string | null;
		barcode?: string | null;
		overallPassed?: boolean | null;
		failureReasons?: string[];
		results?: SessionResult[];
	}

	interface Props {
		data: { session: Session };
	}

	let { data }: Props = $props();

	const session = $derived(data.session);

	function getStatusInfo(status: string, overallPassed: boolean | null | undefined) {
		if (status === 'completed' || overallPassed === true) {
			return {
				label: 'Passed',
				class: 'bg-[var(--color-tron-green)]/20 text-[var(--color-tron-green)]'
			};
		}
		if (status === 'failed' || overallPassed === false) {
			return {
				label: 'Failed',
				class: 'bg-[var(--color-tron-red)]/20 text-[var(--color-tron-red)]'
			};
		}
		if (status === 'in_progress' || status === 'running') {
			return {
				label: 'In Progress',
				class: 'bg-[var(--color-tron-cyan)]/20 text-[var(--color-tron-cyan)]'
			};
		}
		return {
			label: 'Pending',
			class: 'bg-[var(--color-tron-text-secondary)]/20 text-[var(--color-tron-text-secondary)]'
		};
	}

	const statusInfo = $derived(getStatusInfo(session.status, session.overallPassed));

	const firstResult = $derived(session.results?.[0] ?? null);

	// processedData may be an array of parameter rows; normalize to an array if so.
	const processedRows = $derived.by<ProcessedParam[]>(() => {
		const pd = firstResult?.processedData;
		if (Array.isArray(pd)) return pd as ProcessedParam[];
		return [];
	});

	const rawReadings = $derived.by<RawReading[]>(() => {
		const r = firstResult?.rawData?.readings;
		if (Array.isArray(r)) return r;
		// fall back to a top-level rawData on the session if present
		const sessionRaw = (session as unknown as { rawData?: { readings?: RawReading[] } }).rawData;
		if (sessionRaw && Array.isArray(sessionRaw.readings)) return sessionRaw.readings;
		return [];
	});

	const failureReasons = $derived(session.failureReasons ?? []);

	function badgeFor(passed: boolean | null | undefined) {
		if (passed === true)
			return {
				label: 'Pass',
				class: 'bg-[var(--color-tron-green)]/20 text-[var(--color-tron-green)]'
			};
		if (passed === false)
			return {
				label: 'Fail',
				class: 'bg-[var(--color-tron-red)]/20 text-[var(--color-tron-red)]'
			};
		return {
			label: '—',
			class: 'bg-[var(--color-tron-text-secondary)]/20 text-[var(--color-tron-text-secondary)]'
		};
	}

	function fmtDate(dateStr: string | null | undefined): string {
		if (!dateStr) return 'N/A';
		return new Date(dateStr).toLocaleString();
	}

	function fmtNum(v: number | undefined): string {
		if (v === null || v === undefined || Number.isNaN(v)) return '—';
		return String(v);
	}
</script>

<div class="space-y-6">
	<!-- Back Link -->
	<div class="print:hidden">
		<a
			href="/spu/validation/optical-confirmation"
			class="tron-text-muted flex items-center gap-2 text-sm transition-colors hover:text-[var(--color-tron-cyan)]"
		>
			<svg class="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
				<path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M15 19l-7-7 7-7" />
			</svg>
			Back to Optical Confirmation
		</a>
	</div>

	<!-- Header -->
	<div class="flex items-center justify-between">
		<div>
			<h1 class="tron-heading text-2xl font-bold">Optical Confirmation Result</h1>
			<p class="tron-text-muted mt-1">
				SPU: {session.spuUdi ?? session.spuId ?? session._id}
			</p>
		</div>
		<span class="rounded-full px-3 py-1 text-sm font-medium {statusInfo.class}">
			{statusInfo.label}
		</span>
	</div>

	<!-- Overall Result Banner -->
	{#if session.overallPassed === true}
		<div class="rounded-lg border border-[var(--color-tron-green)]/30 bg-[var(--color-tron-green)]/10 p-4">
			<div class="flex items-center gap-3">
				<svg class="h-8 w-8 text-[var(--color-tron-green)]" fill="none" viewBox="0 0 24 24" stroke="currentColor">
					<path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z" />
				</svg>
				<div>
					<span class="text-lg font-bold text-[var(--color-tron-green)]">Validation Passed</span>
					<p class="tron-text-muted text-sm">All optical confirmation parameters within range</p>
				</div>
			</div>
		</div>
	{:else if session.overallPassed === false}
		<div class="rounded-lg border border-[var(--color-tron-red)]/30 bg-[var(--color-tron-red)]/10 p-4">
			<div class="flex items-center gap-3">
				<svg class="h-8 w-8 text-[var(--color-tron-red)]" fill="none" viewBox="0 0 24 24" stroke="currentColor">
					<path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M10 14l2-2m0 0l2-2m-2 2l-2-2m2 2l2 2m7-2a9 9 0 11-18 0 9 9 0 0118 0z" />
				</svg>
				<div>
					<span class="text-lg font-bold text-[var(--color-tron-red)]">Validation Failed</span>
					<p class="tron-text-muted text-sm">One or more parameters outside acceptable range</p>
				</div>
			</div>
		</div>
	{:else}
		<div class="rounded-lg border border-[var(--color-tron-cyan)]/30 bg-[var(--color-tron-cyan)]/10 p-4">
			<div class="flex items-center gap-3">
				<svg class="h-8 w-8 text-[var(--color-tron-cyan)]" fill="none" viewBox="0 0 24 24" stroke="currentColor">
					<path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z" />
				</svg>
				<div>
					<span class="text-lg font-bold text-[var(--color-tron-cyan)]">Pending</span>
					<p class="tron-text-muted text-sm">Results are being processed or not yet available</p>
				</div>
			</div>
		</div>
	{/if}

	<!-- Session Info Card -->
	<div class="tron-card p-4">
		<h3 class="tron-heading mb-4 font-semibold">Session Information</h3>
		<div class="grid grid-cols-2 gap-4 md:grid-cols-4">
			<div>
				<span class="tron-text-muted block text-xs uppercase">Barcode</span>
				<span class="tron-heading font-mono font-medium">{session.barcode ?? 'N/A'}</span>
			</div>
			<div>
				<span class="tron-text-muted block text-xs uppercase">Completed</span>
				<span class="tron-heading font-medium">{fmtDate(session.completedAt)}</span>
			</div>
			<div>
				<span class="tron-text-muted block text-xs uppercase">SPU UDI</span>
				<span class="tron-heading font-mono font-medium">{session.spuUdi ?? 'N/A'}</span>
			</div>
			<div>
				<span class="tron-text-muted block text-xs uppercase">Status</span>
				<span class="tron-heading font-medium capitalize">{session.status.replace('_', ' ')}</span>
			</div>
		</div>
	</div>

	<!-- Processed Parameters Table -->
	{#if processedRows.length > 0}
		<div class="tron-card p-4">
			<h3 class="tron-heading mb-4 font-semibold">Parameter Results</h3>
			<div class="max-h-96 overflow-y-auto">
				<table class="w-full text-sm">
					<thead class="sticky top-0 bg-[var(--color-tron-bg-secondary)]">
						<tr class="text-left">
							<th class="tron-text-muted p-2">Name</th>
							<th class="tron-text-muted p-2">Channel</th>
							<th class="tron-text-muted p-2">Value</th>
							<th class="tron-text-muted p-2">Range</th>
							<th class="tron-text-muted p-2">Result</th>
						</tr>
					</thead>
					<tbody>
						{#each processedRows as row}
							{@const b = badgeFor(row.passed)}
							<tr class="border-t border-[var(--color-tron-border)]">
								<td class="tron-heading p-2">{row.name ?? '—'}</td>
								<td class="tron-text-muted p-2">{fmtNum(row.channel as number)}</td>
								<td class="tron-heading p-2 font-mono">
									{fmtNum(row.value)}{row.unit ? ` ${row.unit}` : ''}
								</td>
								<td class="tron-text-muted p-2 font-mono">
									[{fmtNum(row.min)}, {fmtNum(row.max)}]
								</td>
								<td class="p-2">
									<span class="rounded-full px-2 py-1 text-xs font-medium {b.class}">{b.label}</span>
								</td>
							</tr>
						{/each}
					</tbody>
				</table>
			</div>
		</div>
	{:else if session.results && session.results.length > 0}
		<!-- Fallback: raw results list -->
		<div class="tron-card p-4">
			<h3 class="tron-heading mb-4 font-semibold">Results</h3>
			<div class="max-h-96 overflow-y-auto">
				<table class="w-full text-sm">
					<thead class="sticky top-0 bg-[var(--color-tron-bg-secondary)]">
						<tr class="text-left">
							<th class="tron-text-muted p-2">Test Type</th>
							<th class="tron-text-muted p-2">Notes</th>
							<th class="tron-text-muted p-2">Result</th>
						</tr>
					</thead>
					<tbody>
						{#each session.results as res}
							{@const b = badgeFor(res.passed)}
							<tr class="border-t border-[var(--color-tron-border)]">
								<td class="tron-heading p-2">{res.testType ?? '—'}</td>
								<td class="tron-text-muted p-2">{res.notes ?? '—'}</td>
								<td class="p-2">
									<span class="rounded-full px-2 py-1 text-xs font-medium {b.class}">{b.label}</span>
								</td>
							</tr>
						{/each}
					</tbody>
				</table>
			</div>
		</div>
	{/if}

	<!-- Raw Readings Table -->
	{#if rawReadings.length > 0}
		<div class="tron-card p-4">
			<h3 class="tron-heading mb-4 font-semibold">Raw Readings</h3>
			<div class="max-h-96 overflow-y-auto">
				<table class="w-full text-sm">
					<thead class="sticky top-0 bg-[var(--color-tron-bg-secondary)]">
						<tr class="text-left">
							<th class="tron-text-muted p-2">#</th>
							<th class="tron-text-muted p-2">Channel</th>
							<th class="tron-text-muted p-2">Value</th>
							<th class="tron-text-muted p-2">Timestamp (ms)</th>
						</tr>
					</thead>
					<tbody>
						{#each rawReadings as reading}
							<tr class="border-t border-[var(--color-tron-border)]">
								<td class="tron-text-muted p-2">{fmtNum(reading.readingNumber)}</td>
								<td class="tron-text-muted p-2">{fmtNum(reading.channel as number)}</td>
								<td class="tron-heading p-2 font-mono">{fmtNum(reading.value)}</td>
								<td class="tron-text-muted p-2 font-mono">{fmtNum(reading.timestampMs)}</td>
							</tr>
						{/each}
					</tbody>
				</table>
			</div>
		</div>
	{/if}

	<!-- Failure Reasons -->
	{#if failureReasons.length > 0}
		<div class="rounded-lg border border-[var(--color-tron-red)]/30 bg-[var(--color-tron-red)]/10 p-4">
			<h3 class="mb-2 font-semibold text-[var(--color-tron-red)]">Failure Reasons</h3>
			<ul class="list-inside list-disc space-y-1 text-sm text-[var(--color-tron-red)]">
				{#each failureReasons as reason}
					<li>{reason}</li>
				{/each}
			</ul>
		</div>
	{/if}
</div>
