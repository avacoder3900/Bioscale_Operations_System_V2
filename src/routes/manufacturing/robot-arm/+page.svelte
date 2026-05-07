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
		const d = new Date(iso);
		const date = d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
		const time = d
			.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', hour12: true })
			.replace(' ', '')
			.toLowerCase();
		return `${date}, ${time}`;
	}
</script>

<div class="mx-auto max-w-6xl space-y-8 p-4">
	<div class="flex items-center justify-between">
		<h1 class="text-2xl font-bold" style="color: var(--color-tron-cyan)">Robot Arm</h1>
		<div class="flex gap-2">
			<a
				href="/manufacturing/robot-arm/control"
				class="rounded border border-[var(--color-tron-cyan)]/50 bg-[var(--color-tron-cyan)]/10 px-3 py-1.5 text-xs font-medium transition-colors hover:bg-[var(--color-tron-cyan)]/20"
				style="color: var(--color-tron-cyan)"
			>
				Remote control →
			</a>
			<a
				href="/manufacturing/robot-arm/runs"
				class="rounded border border-[var(--color-tron-border)] px-3 py-1.5 text-xs font-medium transition-colors hover:border-[var(--color-tron-cyan)] hover:text-[var(--color-tron-cyan)]"
				style="color: var(--color-tron-text)"
			>
				Full run log →
			</a>
		</div>
	</div>

	<!-- Arms -->
	<section>
		<h2
			class="mb-3 text-sm font-bold uppercase tracking-wider"
			style="color: var(--color-tron-text-secondary)"
		>
			Registered arms
		</h2>
		{#if data.arms.length === 0}
			<p class="text-sm" style="color: var(--color-tron-text-secondary)">
				No arms registered yet. Run the seed script to populate.
			</p>
		{:else}
			<div class="grid grid-cols-1 gap-4 sm:grid-cols-2">
				{#each data.arms as arm (arm._id)}
					<div
						class="rounded-lg border border-[var(--color-tron-border)] bg-[var(--color-tron-surface)] p-4"
					>
						<div class="flex items-baseline justify-between">
							<h3 class="text-lg font-semibold capitalize" style="color: var(--color-tron-text)">
								{arm.role}
							</h3>
							<span class="text-xs" style="color: var(--color-tron-text-secondary)">
								{arm.modelName} · {arm.voltage}V
							</span>
						</div>
						<dl
							class="mt-2 grid grid-cols-2 gap-x-3 gap-y-1 text-xs"
							style="color: var(--color-tron-text-secondary)"
						>
							<dt>Serial</dt>
							<dd style="color: var(--color-tron-text)">{arm.serialNumber}</dd>
							<dt>Port</dt>
							<dd style="color: var(--color-tron-text)">{arm.comPort ?? '—'}</dd>
							<dt>Firmware</dt>
							<dd style="color: var(--color-tron-text)">{arm.firmwareVersion ?? '—'}</dd>
						</dl>
					</div>
				{/each}
			</div>
		{/if}
	</section>

	<!-- Recent runs -->
	<section>
		<h2
			class="mb-3 text-sm font-bold uppercase tracking-wider"
			style="color: var(--color-tron-text-secondary)"
		>
			Recent runs
		</h2>
		{#if data.recentRuns.length === 0}
			<p class="text-sm" style="color: var(--color-tron-text-secondary)">No runs recorded yet.</p>
		{:else}
			<div class="overflow-hidden rounded-lg border border-[var(--color-tron-border)]">
				<table class="w-full text-sm">
					<thead
						class="border-b border-[var(--color-tron-border)] bg-[var(--color-tron-surface)] text-left text-xs uppercase tracking-wider"
						style="color: var(--color-tron-text-secondary)"
					>
						<tr>
							<th class="px-3 py-2">Type</th>
							<th class="px-3 py-2">Status</th>
							<th class="px-3 py-2">Triggered by</th>
							<th class="px-3 py-2">Started</th>
							<th class="px-3 py-2">Ended</th>
						</tr>
					</thead>
					<tbody style="color: var(--color-tron-text)">
						{#each data.recentRuns as run (run._id)}
							<tr class="border-b border-[var(--color-tron-border)]/50 last:border-b-0">
								<td class="px-3 py-2">
									<a
										href="/manufacturing/robot-arm/runs/{run._id}"
										class="hover:underline"
										style="color: var(--color-tron-cyan)">{run.type}</a
									>
								</td>
								<td class="px-3 py-2 {statusColor(run.status)}">{run.status}</td>
								<td class="px-3 py-2">{run.triggeredBy?.username ?? '—'}</td>
								<td class="px-3 py-2 text-xs" style="color: var(--color-tron-text-secondary)">
									{formatTime(run.startedAt)}
								</td>
								<td class="px-3 py-2 text-xs" style="color: var(--color-tron-text-secondary)">
									{formatTime(run.endedAt)}
								</td>
							</tr>
						{/each}
					</tbody>
				</table>
			</div>
		{/if}
	</section>

	<!-- Datasets summary -->
	<section>
		<h2
			class="mb-3 text-sm font-bold uppercase tracking-wider"
			style="color: var(--color-tron-text-secondary)"
		>
			Datasets
		</h2>
		<p class="text-sm" style="color: var(--color-tron-text-secondary)">
			{data.datasetCount} recorded session{data.datasetCount === 1 ? '' : 's'} on disk.
		</p>
	</section>
</div>
