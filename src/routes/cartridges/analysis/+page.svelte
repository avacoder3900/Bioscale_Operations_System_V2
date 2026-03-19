<script lang="ts">
	let { data } = $props();
</script>

<div class="mx-auto max-w-6xl space-y-6 p-4">
	<div class="flex items-center justify-between">
		<div>
			<a
				href="/cartridges"
				class="text-sm"
				style="color: var(--color-tron-text-secondary, #9ca3af)"
			>
				&larr; Back to Cartridges
			</a>
			<h1
				class="mt-1 text-2xl font-bold"
				style="color: var(--color-tron-cyan, #00ffff)"
			>
				Analysis Dashboard
			</h1>
		</div>
		<a
			href="/cartridges/export?format=csv"
			class="tron-button"
			style="min-height: 44px; background: var(--color-tron-green, #39ff14); color: #000; font-weight: 600"
		>
			Export Full Report
		</a>
	</div>

	<!-- Inventory Summary -->
	<div class="grid grid-cols-2 gap-4 md:grid-cols-3 lg:grid-cols-6">
		{#each [
			{ label: 'Total', value: data.inventory.total, color: 'var(--color-tron-cyan, #00ffff)' },
			{ label: 'Available', value: data.inventory.available, color: 'var(--color-tron-green, #39ff14)' },
			{ label: 'In Use', value: data.inventory.inUse, color: 'var(--color-tron-cyan, #00ffff)' },
			{ label: 'Depleted', value: data.inventory.depleted, color: '#6b7280' },
			{ label: 'Expired', value: data.inventory.expired, color: '#ef4444' },
			{ label: 'Quarantine', value: data.inventory.quarantine, color: '#f97316' }
		] as card (card.label)}
			<div class="tron-card p-4 text-center">
				<div class="text-2xl font-bold" style="color: {card.color}">{card.value}</div>
				<div class="text-xs" style="color: var(--color-tron-text-secondary)">{card.label}</div>
			</div>
		{/each}
	</div>

	<!-- Expiration Alerts -->
	<div class="tron-card p-6">
		<h2 class="mb-4 text-lg font-semibold" style="color: var(--color-tron-cyan, #00ffff)">
			Expiration Alerts
		</h2>
		<div class="mb-4 grid grid-cols-2 gap-4 md:grid-cols-4">
			<div class="rounded border border-red-500/30 p-3 text-center">
				<div class="text-xl font-bold" style="color: #ef4444">{data.expiration.expired}</div>
				<div class="text-xs" style="color: var(--color-tron-text-secondary)">Already Expired</div>
			</div>
			<div class="rounded border border-red-400/30 p-3 text-center">
				<div class="text-xl font-bold" style="color: #ef4444">{data.expiration.within30}</div>
				<div class="text-xs" style="color: var(--color-tron-text-secondary)">Within 30 Days</div>
			</div>
			<div class="rounded border border-yellow-400/30 p-3 text-center">
				<div class="text-xl font-bold" style="color: #fbbf24">{data.expiration.within60}</div>
				<div class="text-xs" style="color: var(--color-tron-text-secondary)">30-60 Days</div>
			</div>
			<div class="rounded border border-green-400/30 p-3 text-center">
				<div class="text-xl font-bold" style="color: var(--color-tron-green, #39ff14)">
					{data.expiration.within90}
				</div>
				<div class="text-xs" style="color: var(--color-tron-text-secondary)">60-90 Days</div>
			</div>
		</div>
		{#if data.expiration.expiringSoon.length > 0}
			<h3 class="mb-2 text-sm font-semibold" style="color: #ef4444">Expiring Within 30 Days:</h3>
			<table class="tron-table w-full">
				<thead>
					<tr>
						<th>Barcode</th>
						<th>Lot #</th>
						<th>Type</th>
						<th>Expires</th>
						<th>Group</th>
					</tr>
				</thead>
				<tbody>
					{#each data.expiration.expiringSoon as item (item.id)}
						<tr onclick={() => window.location.href = `/cartridges/${item.id}`} style="cursor: pointer">
							<td style="font-family: monospace; color: var(--color-tron-cyan)">{item.barcode}</td>
							<td>{item.lotNumber}</td>
							<td class="capitalize">{item.cartridgeType}</td>
							<td style="color: #ef4444">
								{item.expirationDate ? new Date(item.expirationDate).toLocaleDateString() : '—'}
							</td>
							<td>{item.groupName ?? '—'}</td>
						</tr>
					{/each}
				</tbody>
			</table>
		{/if}
	</div>

	<div class="grid gap-6 md:grid-cols-2">
		<!-- Type Breakdown -->
		<div class="tron-card p-6">
			<h2 class="mb-4 text-lg font-semibold" style="color: var(--color-tron-cyan, #00ffff)">
				By Type
			</h2>
			{#each data.inventory.byType as t (t.cartridgeType)}
				<div class="mb-2 flex items-center justify-between">
					<span class="capitalize">{t.cartridgeType}</span>
					<span class="font-mono font-bold" style="color: var(--color-tron-cyan)">{t.count}</span>
				</div>
			{/each}
		</div>

		<!-- Usage Stats (Last 30 Days) -->
		<div class="tron-card p-6">
			<h2 class="mb-4 text-lg font-semibold" style="color: var(--color-tron-cyan, #00ffff)">
				Usage (Last 30 Days)
			</h2>
			<div class="mb-4 text-3xl font-bold" style="color: var(--color-tron-green, #39ff14)">
				{data.usage.totalActions}
				<span class="text-sm font-normal" style="color: var(--color-tron-text-secondary)">
					total actions
				</span>
			</div>
			{#if data.usage.activeUsers.length > 0}
				<h3 class="mb-2 text-sm" style="color: var(--color-tron-text-secondary)">Most Active Users:</h3>
				{#each data.usage.activeUsers as u (u.username)}
					<div class="mb-1 flex justify-between text-sm">
						<span>{u.username}</span>
						<span class="font-mono" style="color: var(--color-tron-cyan)">{u.count}</span>
					</div>
				{/each}
			{/if}
		</div>
	</div>

	<!-- Group Breakdown -->
	{#if data.groups.length > 0}
		<div class="tron-card p-6">
			<h2 class="mb-4 text-lg font-semibold" style="color: var(--color-tron-cyan, #00ffff)">
				Group Breakdown
			</h2>
			<div class="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
				{#each data.groups as g (g.groupId)}
					<div
						class="rounded border p-4"
						style="border-color: {g.groupColor ?? '#374151'}"
					>
						<div class="mb-2 flex items-center gap-2">
							<span
								class="h-3 w-3 rounded-full"
								style="background: {g.groupColor ?? '#6b7280'}"
							></span>
							<span class="font-semibold">{g.groupName}</span>
						</div>
						<div class="space-y-1 text-sm">
							<div class="flex justify-between">
								<span style="color: var(--color-tron-text-secondary)">Total</span>
								<span class="font-mono">{g.total}</span>
							</div>
							<div class="flex justify-between">
								<span style="color: var(--color-tron-green, #39ff14)">Available</span>
								<span class="font-mono">{g.available}</span>
							</div>
							<div class="flex justify-between">
								<span style="color: var(--color-tron-cyan, #00ffff)">In Use</span>
								<span class="font-mono">{g.inUse}</span>
							</div>
							<div class="flex justify-between">
								<span style="color: var(--color-tron-text-secondary)">Depleted</span>
								<span class="font-mono">{g.depleted}</span>
							</div>
						</div>
					</div>
				{/each}
			</div>
		</div>
	{/if}
</div>
