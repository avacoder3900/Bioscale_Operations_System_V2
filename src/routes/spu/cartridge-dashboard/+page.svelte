<script lang="ts">
	import { TronCard, TronBadge } from '$lib/components/ui';

	let { data } = $props();

	function getStatusColor(status: string): string {
		switch (status.toLowerCase()) {
			case 'active':
			case 'available':
				return 'var(--color-tron-green)';
			case 'in_use':
			case 'in use':
				return 'var(--color-tron-cyan)';
			case 'depleted':
			case 'expired':
				return 'var(--color-tron-orange)';
			case 'quarantine':
			case 'disposed':
				return 'var(--color-tron-red)';
			default:
				return 'var(--color-tron-text-secondary)';
		}
	}

	function getStatusBadgeVariant(status: string): 'success' | 'info' | 'warning' | 'error' | 'neutral' {
		switch (status.toLowerCase()) {
			case 'available':
				return 'success';
			case 'in_use':
			case 'in use':
				return 'info';
			case 'depleted':
				return 'warning';
			case 'expired':
			case 'quarantine':
			case 'disposed':
				return 'error';
			default:
				return 'neutral';
		}
	}

	function formatDate(date: string | Date | null): string {
		if (!date) return '—';
		return new Date(date).toLocaleDateString();
	}

	function formatRelativeTime(date: string | Date | null): string {
		if (!date) return '—';
		const d = new Date(date);
		const diff = Date.now() - d.getTime();
		const hours = Math.floor(diff / 3600000);
		if (hours < 1) return 'Just now';
		if (hours < 24) return `${hours}h ago`;
		const days = Math.floor(hours / 24);
		if (days === 1) return 'Yesterday';
		return `${days}d ago`;
	}

	// Derive top stats from statusCounts
	let activeCount = $derived((data.statusCounts ?? []).find((s: { status: string }) => s.status === 'available')?.count ?? 0);
	let inUseCount = $derived((data.statusCounts ?? []).find((s: { status: string }) => s.status === 'in_use')?.count ?? 0);
	let depletedCount = $derived((data.statusCounts ?? []).find((s: { status: string }) => s.status === 'depleted')?.count ?? 0);

	// Max count for proportional bars
	let maxStatusCount = $derived(Math.max(...(data.statusCounts ?? []).map((s: { count: number }) => s.count), 1));
	let maxTypeCount = $derived(Math.max(...(data.typeCounts ?? []).map((t: { count: number }) => t.count), 1));
</script>

<div class="space-y-6">
	<!-- Header -->
	<div>
		<h2 class="tron-text-primary font-mono text-2xl font-bold">Cartridge Dashboard</h2>
		<p class="tron-text-muted text-sm">Overview of lab cartridge inventory and activity</p>
	</div>

	<!-- Stats Cards -->
	<div class="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
		<TronCard>
			<div class="text-center">
				<div class="font-mono text-3xl font-bold text-[var(--color-tron-cyan)]">
					{data.totalCartridges}
				</div>
				<div class="tron-text-muted text-sm">Total Cartridges</div>
			</div>
		</TronCard>
		<TronCard>
			<div class="text-center">
				<div class="font-mono text-3xl font-bold text-[var(--color-tron-green)]">
					{activeCount}
				</div>
				<div class="tron-text-muted text-sm">Available</div>
			</div>
		</TronCard>
		<TronCard>
			<div class="text-center">
				<div class="font-mono text-3xl font-bold text-[var(--color-tron-cyan)]">
					{inUseCount}
				</div>
				<div class="tron-text-muted text-sm">In Use</div>
			</div>
		</TronCard>
		<TronCard>
			<div class="text-center">
				<div class="font-mono text-3xl font-bold text-[var(--color-tron-orange)]">
					{depletedCount}
				</div>
				<div class="tron-text-muted text-sm">Depleted</div>
			</div>
		</TronCard>
	</div>

	<!-- Status & Type Breakdown -->
	<div class="grid gap-4 lg:grid-cols-2">
		<!-- Status Breakdown -->
		<TronCard>
			<h3 class="tron-text-primary mb-4 font-mono text-lg font-semibold">Status Breakdown</h3>
			{#if data.statusCounts && data.statusCounts.length > 0}
				<div class="space-y-3">
					{#each data.statusCounts as item (item.status)}
						<div class="flex items-center gap-3">
							<span class="w-24 text-sm capitalize" style="color: {getStatusColor(item.status)}">{item.status.replace('_', ' ')}</span>
							<div class="flex-1">
								<div
									class="h-4 rounded"
									style="width: {(item.count / maxStatusCount) * 100}%; background: {getStatusColor(item.status)}; opacity: 0.7; min-width: 4px"
								></div>
							</div>
							<span class="tron-text-primary w-8 text-right font-mono text-sm font-bold">{item.count}</span>
						</div>
					{/each}
				</div>
			{:else}
				<p class="tron-text-muted text-center text-sm">No status data available.</p>
			{/if}
		</TronCard>

		<!-- Type Breakdown -->
		<TronCard>
			<h3 class="tron-text-primary mb-4 font-mono text-lg font-semibold">Type Breakdown</h3>
			{#if data.typeCounts && data.typeCounts.length > 0}
				<div class="space-y-3">
					{#each data.typeCounts as item (item.type)}
						<div class="flex items-center gap-3">
							<span class="tron-text-primary w-24 text-sm capitalize">{item.type}</span>
							<div class="flex-1">
								<div
									class="h-4 rounded"
									style="width: {(item.count / maxTypeCount) * 100}%; background: var(--color-tron-cyan); opacity: 0.7; min-width: 4px"
								></div>
							</div>
							<span class="tron-text-primary w-8 text-right font-mono text-sm font-bold">{item.count}</span>
						</div>
					{/each}
				</div>
			{:else}
				<p class="tron-text-muted text-center text-sm">No type data available.</p>
			{/if}
		</TronCard>
	</div>

	<!-- Group Summary -->
	{#if data.groupSummary && data.groupSummary.length > 0}
		<TronCard>
			<h3 class="tron-text-primary mb-4 font-mono text-lg font-semibold">Group Summary</h3>
			<div class="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
				{#each data.groupSummary as group (group.groupId)}
					<div class="flex items-center gap-3 rounded border border-[var(--color-tron-border)] p-3">
						<span
							class="h-3 w-3 flex-shrink-0 rounded-full"
							style="background: {group.color || 'var(--color-tron-cyan)'}"
						></span>
						<div class="min-w-0 flex-1">
							<div class="tron-text-primary truncate text-sm font-medium">{group.groupName}</div>
						</div>
						<span class="font-mono text-lg font-bold text-[var(--color-tron-cyan)]">{group.count}</span>
					</div>
				{/each}
			</div>
		</TronCard>
	{/if}

	<!-- Recent Activity Table -->
	<TronCard>
		<h3 class="tron-text-primary mb-4 font-mono text-lg font-semibold">Recent Activity</h3>
		<div class="overflow-x-auto">
			<table class="tron-table">
				<thead>
					<tr>
						<th>Barcode</th>
						<th>Type</th>
						<th>Status</th>
						<th>Updated</th>
					</tr>
				</thead>
				<tbody>
					{#each data.recentActivity ?? [] as item (item.id)}
						<tr>
							<td class="font-mono text-[var(--color-tron-cyan)]">{item.barcode ?? item.id}</td>
							<td class="capitalize">{item.cartridgeType}</td>
							<td><TronBadge variant={getStatusBadgeVariant(item.status)}>{item.status.replace('_', ' ')}</TronBadge></td>
							<td class="tron-text-muted">{formatRelativeTime(item.updatedAt)}</td>
						</tr>
					{:else}
						<tr>
							<td colspan="4" class="tron-text-muted text-center">No cartridge activity yet.</td>
						</tr>
					{/each}
				</tbody>
			</table>
		</div>
	</TronCard>
</div>
