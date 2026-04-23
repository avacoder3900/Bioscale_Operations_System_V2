<script lang="ts">
	let { data } = $props();

	function fmtTime(iso: string | null): string {
		if (!iso) return '—';
		const d = new Date(iso);
		return d.toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
	}
</script>

<div class="mx-auto max-w-5xl space-y-8 p-4">
	<div class="flex items-center justify-between">
		<div>
			<h1 class="text-2xl font-bold" style="color: var(--color-tron-cyan)">Manufacturing Settings</h1>
			<p class="mt-1 text-xs" style="color: var(--color-tron-text-secondary)">
				Current values for wax filling and reagent filling. Last saved: {fmtTime(data.lastUpdatedAt)}
			</p>
		</div>
		<a href="/manufacturing/opentron-control"
			class="rounded border border-[var(--color-tron-border)] px-3 py-1.5 text-xs hover:border-[var(--color-tron-cyan)] transition-colors"
			style="color: var(--color-tron-text)">
			← Back to Opentron Control
		</a>
	</div>

	<!-- Wax Filling -->
	<section class="rounded-lg border border-[var(--color-tron-cyan)]/30 bg-[var(--color-tron-surface)]/40 p-5">
		<div class="mb-4 flex items-center justify-between">
			<h2 class="text-lg font-semibold" style="color: var(--color-tron-cyan)">Wax Filling</h2>
			<a href="/manufacturing/wax-filling/settings"
				class="rounded border border-[var(--color-tron-cyan)]/50 bg-[var(--color-tron-cyan)]/10 px-3 py-1.5 text-xs font-medium text-[var(--color-tron-cyan)] hover:bg-[var(--color-tron-cyan)]/20 transition-colors">
				Edit wax settings →
			</a>
		</div>

		<div class="mb-3">
			<h3 class="mb-2 text-xs font-bold uppercase tracking-wider" style="color: var(--color-tron-text-secondary)">Timers</h3>
			<div class="grid grid-cols-1 gap-3 sm:grid-cols-2 md:grid-cols-3">
				<div class="rounded border border-[var(--color-tron-border)] p-3">
					<div class="text-[10px] uppercase tracking-wider" style="color: var(--color-tron-text-secondary)">Minimum oven cure time</div>
					<div class="mt-1 font-mono text-lg" style="color: var(--color-tron-text)">{data.wax.minOvenTimeMin} <span class="text-xs">min</span></div>
				</div>
				<div class="rounded border border-[var(--color-tron-border)] p-3">
					<div class="text-[10px] uppercase tracking-wider" style="color: var(--color-tron-text-secondary)">Run duration (expected)</div>
					<div class="mt-1 font-mono text-lg" style="color: var(--color-tron-text)">{data.wax.runDurationMin} <span class="text-xs">min</span></div>
				</div>
				<div class="rounded border border-[var(--color-tron-border)] p-3">
					<div class="text-[10px] uppercase tracking-wider" style="color: var(--color-tron-text-secondary)">Remove-deck warning</div>
					<div class="mt-1 font-mono text-lg" style="color: var(--color-tron-text)">{data.wax.removeDeckWarningMin} <span class="text-xs">min</span></div>
				</div>
				<div class="rounded border border-[var(--color-tron-border)] p-3">
					<div class="text-[10px] uppercase tracking-wider" style="color: var(--color-tron-text-secondary)">Cooling warning</div>
					<div class="mt-1 font-mono text-lg" style="color: var(--color-tron-text)">{data.wax.coolingWarningMin} <span class="text-xs">min</span></div>
				</div>
				<div class="rounded border border-[var(--color-tron-border)] p-3">
					<div class="text-[10px] uppercase tracking-wider" style="color: var(--color-tron-text-secondary)">Min cooling before QC</div>
					<div class="mt-1 font-mono text-lg" style="color: var(--color-tron-text)">{data.wax.minCoolingBeforeQcMin} <span class="text-xs">min</span></div>
				</div>
				<div class="rounded border border-[var(--color-tron-border)] p-3">
					<div class="text-[10px] uppercase tracking-wider" style="color: var(--color-tron-text-secondary)">Deck lockout</div>
					<div class="mt-1 font-mono text-lg" style="color: var(--color-tron-text)">{data.wax.deckLockoutMin} <span class="text-xs">min</span></div>
				</div>
			</div>
		</div>

		<div class="mb-3">
			<h3 class="mb-2 text-xs font-bold uppercase tracking-wider" style="color: var(--color-tron-text-secondary)">Temperatures</h3>
			<div class="grid grid-cols-1 gap-3 sm:grid-cols-2">
				<div class="rounded border border-[var(--color-tron-border)] p-3">
					<div class="text-[10px] uppercase tracking-wider" style="color: var(--color-tron-text-secondary)">Incubator temperature</div>
					<div class="mt-1 font-mono text-lg" style="color: var(--color-tron-text)">{data.wax.incubatorTempC} <span class="text-xs">°C</span></div>
				</div>
				<div class="rounded border border-[var(--color-tron-border)] p-3">
					<div class="text-[10px] uppercase tracking-wider" style="color: var(--color-tron-text-secondary)">Heater temperature</div>
					<div class="mt-1 font-mono text-lg" style="color: var(--color-tron-text)">{data.wax.heaterTempC} <span class="text-xs">°C</span></div>
				</div>
			</div>
		</div>

		<div>
			<h3 class="mb-2 text-xs font-bold uppercase tracking-wider" style="color: var(--color-tron-text-secondary)">Volumes &amp; geometry</h3>
			<div class="grid grid-cols-2 gap-3 sm:grid-cols-4">
				<div class="rounded border border-[var(--color-tron-border)] p-3">
					<div class="text-[10px] uppercase tracking-wider" style="color: var(--color-tron-text-secondary)">Wax per deck</div>
					<div class="mt-1 font-mono text-base" style="color: var(--color-tron-text)">{data.wax.waxPerDeckUl} <span class="text-xs">μL</span></div>
				</div>
				<div class="rounded border border-[var(--color-tron-border)] p-3">
					<div class="text-[10px] uppercase tracking-wider" style="color: var(--color-tron-text-secondary)">Tube capacity</div>
					<div class="mt-1 font-mono text-base" style="color: var(--color-tron-text)">{data.wax.tubeCapacityUl} <span class="text-xs">μL</span></div>
				</div>
				<div class="rounded border border-[var(--color-tron-border)] p-3">
					<div class="text-[10px] uppercase tracking-wider" style="color: var(--color-tron-text-secondary)">Wax per cartridge</div>
					<div class="mt-1 font-mono text-base" style="color: var(--color-tron-text)">{data.wax.waxPerCartridgeUl} <span class="text-xs">μL</span></div>
				</div>
				<div class="rounded border border-[var(--color-tron-border)] p-3">
					<div class="text-[10px] uppercase tracking-wider" style="color: var(--color-tron-text-secondary)">Cartridges per column</div>
					<div class="mt-1 font-mono text-base" style="color: var(--color-tron-text)">{data.wax.cartridgesPerColumn}</div>
				</div>
			</div>
		</div>
	</section>

	<!-- Reagent Filling -->
	<section class="rounded-lg border border-purple-500/30 bg-purple-900/5 p-5">
		<div class="mb-4 flex items-center justify-between">
			<h2 class="text-lg font-semibold text-purple-300">Reagent Filling</h2>
			<a href="/manufacturing/reagent-filling/settings"
				class="rounded border border-purple-500/50 bg-purple-900/10 px-3 py-1.5 text-xs font-medium text-purple-300 hover:bg-purple-900/20 transition-colors">
				Edit reagent settings →
			</a>
		</div>

		<div class="grid grid-cols-1 gap-3 sm:grid-cols-3">
			<div class="rounded border border-[var(--color-tron-border)] p-3">
				<div class="text-[10px] uppercase tracking-wider" style="color: var(--color-tron-text-secondary)">Minimum cooling time</div>
				<div class="mt-1 font-mono text-lg" style="color: var(--color-tron-text)">{data.reagent.minCoolingTimeMin} <span class="text-xs">min</span></div>
			</div>
			<div class="rounded border border-[var(--color-tron-border)] p-3">
				<div class="text-[10px] uppercase tracking-wider" style="color: var(--color-tron-text-secondary)">Fill time per cartridge</div>
				<div class="mt-1 font-mono text-lg" style="color: var(--color-tron-text)">{data.reagent.fillTimePerCartridgeMin} <span class="text-xs">min</span></div>
			</div>
			<div class="rounded border border-[var(--color-tron-border)] p-3">
				<div class="text-[10px] uppercase tracking-wider" style="color: var(--color-tron-text-secondary)">Max time before seal</div>
				<div class="mt-1 font-mono text-lg" style="color: var(--color-tron-text)">{data.reagent.maxTimeBeforeSealMin} <span class="text-xs">min</span></div>
			</div>
		</div>
	</section>
</div>
