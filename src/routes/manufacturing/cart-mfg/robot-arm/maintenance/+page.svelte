<script lang="ts">
	/**
	 * Maintenance — the tools the wax-fill line no longer needs day to day,
	 * kept one click away rather than as top-level tabs (2026-11 UI redesign).
	 */
	const BASE = '/manufacturing/cart-mfg/robot-arm/maintenance';
	const tools = [
		{
			href: `${BASE}/control`,
			title: 'Leader arm & recordings',
			text: 'Mirror the leader arm (teleop), record a piloted motion to the Pi, replay a raw recording, manage the Pi’s recordings and the 30-day trash, and read the connection log.'
		},
		{
			href: `${BASE}/cleanup`,
			title: 'Clean-up',
			text: 'Split a piloted recording into steps, tidy them, smooth, overlay a pilot’s corrections on an animated one, and send the result to Teach as a move set.'
		},
		{
			href: `${BASE}/jog`,
			title: 'Jog',
			text: 'Per-joint single-step nudges, torque on / off, reload the jog calibration and reset backlash state. The Cartesian pad needs the IK stack on the Pi.'
		},
		{
			href: `${BASE}/sync-zero`,
			title: 'Sync zero & joint map',
			text: 'The matched reference pose and the per-joint scale fit that map the leader arm onto the follower for teleop.'
		},
		{
			href: `${BASE}/conveyor`,
			title: 'Conveyor bench test',
			text: 'Pulse the cooling belt on GPIO 22 for a typed number of milliseconds. Temporary: its controls move into Run later.'
		}
	];
</script>

<div class="space-y-4">
	<div>
		<h2 class="text-lg font-bold" style="color: var(--color-tron-cyan)">Maintenance</h2>
		<p class="mt-1 text-xs" style="color: var(--color-tron-text-secondary)">
			Tools behind the line. Torque, Return to home and Stop arm are on the status card, on every tab.
		</p>
	</div>
	<div class="grid grid-cols-1 gap-3 md:grid-cols-2">
		{#each tools as t (t.href)}
			<a
				href={t.href}
				class="block rounded-lg border p-4 transition-colors hover:border-[var(--color-tron-cyan)]"
				style="border-color: var(--color-tron-border); background: var(--color-tron-surface);"
			>
				<div class="text-sm font-semibold" style="color: var(--color-tron-cyan)">{t.title}</div>
				<p class="mt-1 text-xs" style="color: var(--color-tron-text-secondary)">{t.text}</p>
			</a>
		{/each}
	</div>
</div>
