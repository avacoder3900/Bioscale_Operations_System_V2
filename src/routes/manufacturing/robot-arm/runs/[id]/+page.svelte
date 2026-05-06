<script lang="ts">
	let { data } = $props();

	function statusColor(status: string): string {
		if (status === 'running' || status === 'pending') return 'text-yellow-400';
		if (status === 'completed') return 'text-green-400';
		if (status === 'failed') return 'text-red-400';
		if (status === 'cancelled') return 'text-gray-400';
		return 'text-[var(--color-tron-text-secondary)]';
	}

	function formatTime(iso: string | null | undefined): string {
		if (!iso) return '—';
		return new Date(iso).toLocaleString();
	}

	function formatPayload(payload: unknown): string {
		try {
			return JSON.stringify(payload, null, 2);
		} catch {
			return String(payload);
		}
	}
</script>

<div class="mx-auto max-w-5xl space-y-6 p-4">
	<div class="flex items-center justify-between">
		<div>
			<h1 class="text-2xl font-bold capitalize" style="color: var(--color-tron-cyan)">
				{data.run.type} run
			</h1>
			<p class="mt-1 font-mono text-xs" style="color: var(--color-tron-text-secondary)">
				{data.run.runId}
			</p>
		</div>
		<a
			href="/manufacturing/robot-arm/runs"
			class="text-xs transition-colors hover:text-[var(--color-tron-cyan)]"
			style="color: var(--color-tron-text-secondary)"
		>
			← back to runs
		</a>
	</div>

	<!-- Header card -->
	<section
		class="rounded-lg border border-[var(--color-tron-border)] bg-[var(--color-tron-surface)] p-4"
	>
		<dl
			class="grid grid-cols-2 gap-x-6 gap-y-2 text-sm sm:grid-cols-4"
			style="color: var(--color-tron-text-secondary)"
		>
			<dt>Status</dt>
			<dd class={statusColor(data.run.status)}>{data.run.status}</dd>
			<dt>Triggered by</dt>
			<dd style="color: var(--color-tron-text)">{data.run.triggeredBy?.username ?? '—'}</dd>
			<dt>Started</dt>
			<dd style="color: var(--color-tron-text)">{formatTime(data.run.startedAt)}</dd>
			<dt>Ended</dt>
			<dd style="color: var(--color-tron-text)">{formatTime(data.run.endedAt)}</dd>
			<dt>Lot</dt>
			<dd style="color: var(--color-tron-text)">{data.run.lotId ?? '—'}</dd>
			<dt>Finalized</dt>
			<dd style="color: var(--color-tron-text)">{formatTime(data.run.finalizedAt)}</dd>
		</dl>
	</section>

	<!-- Parameters -->
	{#if data.run.parameters}
		<section>
			<h2
				class="mb-2 text-sm font-bold uppercase tracking-wider"
				style="color: var(--color-tron-text-secondary)"
			>
				Parameters
			</h2>
			<pre
				class="overflow-x-auto rounded border border-[var(--color-tron-border)] bg-[var(--color-tron-surface)] p-3 text-xs"
				style="color: var(--color-tron-text)">{formatPayload(data.run.parameters)}</pre>
		</section>
	{/if}

	<!-- Result -->
	{#if data.run.result}
		<section>
			<h2
				class="mb-2 text-sm font-bold uppercase tracking-wider"
				style="color: var(--color-tron-text-secondary)"
			>
				Result
			</h2>
			<pre
				class="overflow-x-auto rounded border border-[var(--color-tron-border)] bg-[var(--color-tron-surface)] p-3 text-xs"
				style="color: var(--color-tron-text)">{formatPayload(data.run.result)}</pre>
		</section>
	{/if}

	<!-- Linked dataset -->
	{#if data.dataset}
		<section>
			<h2
				class="mb-2 text-sm font-bold uppercase tracking-wider"
				style="color: var(--color-tron-text-secondary)"
			>
				Dataset
			</h2>
			<div
				class="rounded border border-[var(--color-tron-border)] bg-[var(--color-tron-surface)] p-3 text-sm"
			>
				<p style="color: var(--color-tron-text)">
					<span class="font-medium">{data.dataset.name}</span>
					<span style="color: var(--color-tron-text-secondary)" class="ml-2 text-xs">
						{data.dataset.frames} frames · {data.dataset.durationS}s · {data.dataset.rateHz}Hz
					</span>
				</p>
				<p class="mt-1 font-mono text-xs" style="color: var(--color-tron-text-secondary)">
					{data.dataset.path}
				</p>
			</div>
		</section>
	{/if}

	<!-- Event timeline -->
	<section>
		<h2
			class="mb-2 text-sm font-bold uppercase tracking-wider"
			style="color: var(--color-tron-text-secondary)"
		>
			Event timeline ({data.run.events.length})
		</h2>
		{#if data.run.events.length === 0}
			<p class="text-sm" style="color: var(--color-tron-text-secondary)">No events captured.</p>
		{:else}
			<div
				class="overflow-hidden rounded-lg border border-[var(--color-tron-border)] bg-[var(--color-tron-surface)]"
			>
				{#each data.run.events as event, idx (idx)}
					<div
						class="border-b border-[var(--color-tron-border)]/50 p-3 text-xs last:border-b-0"
					>
						<div class="flex items-baseline justify-between">
							<span class="font-mono font-medium" style="color: var(--color-tron-cyan)"
								>{event.type}</span
							>
							<span style="color: var(--color-tron-text-secondary)"
								>{formatTime(event.at)}</span
							>
						</div>
						{#if event.payload}
							<pre class="mt-1 whitespace-pre-wrap break-all" style="color: var(--color-tron-text)">{formatPayload(event.payload)}</pre>
						{/if}
					</div>
				{/each}
			</div>
		{/if}
	</section>
</div>
