<script lang="ts">
	interface Props {
		data: {
			recentLots: {
				lotId: string;
				qrCodeRef: string;
				configId: string;
				quantityProduced: number;
				startTime: string | null;
				finishTime: string | null;
				cycleTime: number | null;
				status: string;
				username: string | null;
			}[];
			stats: Record<string, { lotsToday: number; unitsToday: number }>;
		};
	}

	let { data }: Props = $props();
</script>

<div class="space-y-6">
	<h1 class="text-2xl font-semibold text-[var(--color-tron-text)]">Manufacturing Dashboard</h1>

	{#if Object.keys(data.stats).length > 0}
		<div class="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
			{#each Object.entries(data.stats) as [configId, s]}
				<div
					class="rounded-lg border border-[var(--color-tron-border)] bg-[var(--color-tron-bg-secondary)] p-4"
				>
					<div class="text-sm text-[var(--color-tron-text-secondary)]">{configId}</div>
					<div class="mt-1 text-xl font-semibold text-[var(--color-tron-text)]">
						{s.unitsToday} units today
					</div>
					<div class="text-sm text-[var(--color-tron-text-secondary)]">{s.lotsToday} lots</div>
				</div>
			{/each}
		</div>
	{/if}

	<section class="rounded-lg border border-[var(--color-tron-border)] bg-[var(--color-tron-bg-secondary)]">
		<h2 class="border-b border-[var(--color-tron-border)] px-4 py-3 text-lg font-medium text-[var(--color-tron-text)]">
			Lot History
		</h2>
		<div class="overflow-x-auto">
			<table class="w-full text-left text-sm">
				<thead>
					<tr class="border-b border-[var(--color-tron-border)] text-[var(--color-tron-text-secondary)]">
						<th class="px-4 py-3">Lot ID</th>
						<th class="px-4 py-3">Config</th>
						<th class="px-4 py-3">Operator</th>
						<th class="px-4 py-3">Qty</th>
						<th class="px-4 py-3">Cycle (s)</th>
						<th class="px-4 py-3">Status</th>
						<th class="px-4 py-3">Finish</th>
					</tr>
				</thead>
				<tbody>
					{#if data.recentLots.length === 0}
						<tr>
							<td colspan="7" class="px-4 py-8 text-center text-[var(--color-tron-text-secondary)]">
								No lots yet. Start a batch from WI-01 or WI-02.
							</td>
						</tr>
					{:else}
						{#each data.recentLots as lot}
							<tr class="border-b border-[var(--color-tron-border)]">
								<td class="px-4 py-3">
									<a
										href="/manufacturing/lots/{lot.lotId}"
										class="text-[var(--color-tron-cyan)] hover:underline"
									>
										{lot.lotId}
									</a>
								</td>
								<td class="px-4 py-3 text-[var(--color-tron-text)]">{lot.configId}</td>
								<td class="px-4 py-3 text-[var(--color-tron-text)]">{lot.username ?? '—'}</td>
								<td class="px-4 py-3 text-[var(--color-tron-text)]">{lot.quantityProduced}</td>
								<td class="px-4 py-3 text-[var(--color-tron-text)]">{lot.cycleTime ?? '—'}</td>
								<td class="px-4 py-3 text-[var(--color-tron-text)]">{lot.status}</td>
								<td class="px-4 py-3 text-[var(--color-tron-text-secondary)]">{lot.finishTime ? new Date(lot.finishTime).toLocaleString() : '—'}</td>
							</tr>
						{/each}
					{/if}
				</tbody>
			</table>
		</div>
	</section>
</div>
