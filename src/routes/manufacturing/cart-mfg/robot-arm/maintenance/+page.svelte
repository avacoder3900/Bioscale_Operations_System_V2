<script lang="ts">
	/**
	 * Maintenance — the tools the wax-fill line no longer needs day to day,
	 * kept one click away rather than as top-level tabs (2026-11 UI redesign).
	 */
	const BASE = '/manufacturing/cart-mfg/robot-arm/maintenance';
	const tools = [
		{
			href: `${BASE}/control`,
			title: 'Leader Arm & Recordings'
		},
		{
			href: `${BASE}/cleanup`,
			title: 'Clean-Up'
		},
		{
			href: `${BASE}/jog`,
			title: 'Jog'
		},
		{
			href: `${BASE}/sync-zero`,
			title: 'Sync Zero & Joint Map'
		},
		{
			href: `${BASE}/conveyor`,
			title: 'Conveyor Bench Test'
		}
	];
</script>

<div class="space-y-4">
	<div>
		<h2 class="text-lg font-bold" style="color: var(--color-tron-cyan)">Maintenance</h2>
	</div>
	<div class="grid grid-cols-1 gap-3 md:grid-cols-2">
		{#each tools as t (t.href)}
			<a
				href={t.href}
				class="block rounded-lg border p-4 transition-colors hover:border-[var(--color-tron-cyan)]"
				style="border-color: var(--color-tron-border); background: var(--color-tron-surface);"
			>
				<div class="text-sm font-semibold" style="color: var(--color-tron-cyan)">{t.title}</div>
			</a>
		{/each}
	</div>
</div>
