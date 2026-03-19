<script lang="ts">
	let { data } = $props();

	let expandedStage = $state<string | null>(null);

	function toggle(id: string) {
		expandedStage = expandedStage === id ? null : id;
	}
</script>

<div class="space-y-6">
	<div>
		<h1 class="text-2xl font-bold text-[var(--color-tron-cyan)]">Cartridge Line Inventory Overview</h1>
		<p class="mt-1 text-sm text-[var(--color-tron-text-secondary)]">Material flow through the cartridge manufacturing pipeline</p>
	</div>

	<!-- Pipeline summary bar -->
	<div class="grid grid-cols-3 gap-3 sm:grid-cols-6">
		<div class="rounded-lg border border-[var(--color-tron-border)] bg-[var(--color-tron-surface)] p-3 text-center">
			<div class="text-xl font-bold text-[var(--color-tron-text)]">{data.totals.backed}</div>
			<div class="text-[10px] text-[var(--color-tron-text-secondary)]">Backed</div>
		</div>
		<div class="rounded-lg border border-amber-500/30 bg-amber-900/10 p-3 text-center">
			<div class="text-xl font-bold text-amber-400">{data.totals.waxStored}</div>
			<div class="text-[10px] text-amber-300/70">Wax Stored</div>
		</div>
		<div class="rounded-lg border border-purple-500/30 bg-purple-900/10 p-3 text-center">
			<div class="text-xl font-bold text-purple-400">{data.totals.reagentStored}</div>
			<div class="text-[10px] text-purple-300/70">Reagent Stored</div>
		</div>
		<div class="rounded-lg border border-green-500/30 bg-green-900/10 p-3 text-center">
			<div class="text-xl font-bold text-green-400">{data.totals.sealed}</div>
			<div class="text-[10px] text-green-300/70">Sealed</div>
		</div>
		<div class="rounded-lg border border-red-500/30 bg-red-900/10 p-3 text-center">
			<div class="text-xl font-bold text-red-400">{data.totals.voided}</div>
			<div class="text-[10px] text-red-300/70">Voided</div>
		</div>
		<div class="rounded-lg border border-[var(--color-tron-cyan)]/30 bg-[var(--color-tron-cyan)]/10 p-3 text-center">
			<div class="text-xl font-bold text-[var(--color-tron-cyan)]">{data.totals.totalInSystem}</div>
			<div class="text-[10px] text-[var(--color-tron-cyan)]/70">Total in System</div>
		</div>
	</div>

	<!-- Pipeline stages -->
	<div class="space-y-2">
		{#each data.stages as stage, i (stage.id)}
			{@const isExpanded = expandedStage === stage.id}
			<!-- Arrow connector between stages -->
			{#if i > 0}
				<div class="flex justify-center py-1">
					<svg class="h-5 w-5 text-[var(--color-tron-border)]" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2">
						<path stroke-linecap="round" stroke-linejoin="round" d="M19 14l-7 7m0 0l-7-7m7 7V3" />
					</svg>
				</div>
			{/if}

			<div class="rounded-lg border border-[var(--color-tron-border)] bg-[var(--color-tron-surface)] overflow-hidden">
				<!-- Stage header -->
				<button
					type="button"
					onclick={() => toggle(stage.id)}
					class="flex w-full items-center justify-between p-4 text-left transition-colors hover:bg-[var(--color-tron-cyan)]/5"
				>
					<div class="flex items-center gap-3">
						<div class="flex h-10 w-10 shrink-0 items-center justify-center rounded-full border border-[var(--color-tron-border)] bg-[var(--color-tron-bg-tertiary)] text-sm font-bold text-[var(--color-tron-cyan)]">
							{i + 1}
						</div>
						<div>
							<h3 class="text-sm font-semibold text-[var(--color-tron-text)]">{stage.name}</h3>
							<div class="mt-0.5 flex items-center gap-3 text-xs text-[var(--color-tron-text-secondary)]">
								{#if stage.activeRuns > 0}
									<span class="rounded bg-green-900/30 px-1.5 py-0.5 text-green-400">{stage.activeRuns} active run{stage.activeRuns !== 1 ? 's' : ''}</span>
								{/if}
								{#if stage.completedRuns > 0}
									<span>{stage.completedRuns} completed</span>
								{/if}
							</div>
						</div>
					</div>

					<div class="flex items-center gap-4">
						<!-- Quick counts: inputs → outputs -->
						<div class="flex items-center gap-2 text-xs">
							{#each stage.inputs.filter((inp) => inp.count !== null) as inp}
								<span class="rounded bg-red-900/20 px-2 py-0.5 text-red-300" title="{inp.name}: {inp.count}">
									{inp.icon} {inp.count}
								</span>
							{/each}
							{#if stage.inputs.some((inp) => inp.count !== null) && stage.outputs.some((out) => out.count !== null)}
								<span class="text-[var(--color-tron-text-secondary)]">→</span>
							{/if}
							{#each stage.outputs.filter((out) => out.count !== null) as out}
								<span class="rounded bg-green-900/20 px-2 py-0.5 text-green-300" title="{out.name}: {out.count}">
									{out.icon} {out.count}
								</span>
							{/each}
						</div>

						<svg class="h-5 w-5 text-[var(--color-tron-text-secondary)] transition-transform {isExpanded ? 'rotate-180' : ''}" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2">
							<path stroke-linecap="round" stroke-linejoin="round" d="M19 9l-7 7-7-7" />
						</svg>
					</div>
				</button>

				<!-- Expanded detail -->
				{#if isExpanded}
					<div class="border-t border-[var(--color-tron-border)] p-4">
						<div class="grid gap-4 sm:grid-cols-2">
							<!-- Inputs consumed -->
							<div>
								<h4 class="mb-2 text-xs font-semibold uppercase text-red-400">Inputs Consumed</h4>
								<div class="space-y-2">
									{#each stage.inputs as inp}
										<div class="flex items-center justify-between rounded border border-red-500/20 bg-red-900/10 px-3 py-2">
											<div class="flex items-center gap-2">
												<span class="text-base">{inp.icon}</span>
												<span class="text-sm text-[var(--color-tron-text)]">{inp.name}</span>
											</div>
											<span class="font-mono text-sm font-bold {inp.count !== null ? 'text-red-300' : 'text-[var(--color-tron-text-secondary)]'}">
												{inp.count !== null ? inp.count : '—'}
												<span class="ml-1 text-[10px] font-normal text-[var(--color-tron-text-secondary)]">{inp.unit}</span>
											</span>
										</div>
									{/each}
								</div>
							</div>

							<!-- Outputs produced -->
							<div>
								<h4 class="mb-2 text-xs font-semibold uppercase text-green-400">Outputs Produced</h4>
								<div class="space-y-2">
									{#each stage.outputs as out}
										<div class="flex items-center justify-between rounded border border-green-500/20 bg-green-900/10 px-3 py-2">
											<div class="flex items-center gap-2">
												<span class="text-base">{out.icon}</span>
												<span class="text-sm text-[var(--color-tron-text)]">{out.name}</span>
											</div>
											<span class="font-mono text-sm font-bold {out.count !== null ? 'text-green-300' : 'text-[var(--color-tron-text-secondary)]'}">
												{out.count !== null ? out.count : '—'}
												<span class="ml-1 text-[10px] font-normal text-[var(--color-tron-text-secondary)]">{out.unit}</span>
											</span>
										</div>
									{/each}
								</div>
							</div>
						</div>

						<!-- Link to stage -->
						<div class="mt-3 flex justify-end">
							<a
								href={stage.href}
								class="rounded border border-[var(--color-tron-cyan)]/40 px-3 py-1.5 text-xs text-[var(--color-tron-cyan)] transition-colors hover:bg-[var(--color-tron-cyan)]/10"
							>
								Go to {stage.name} →
							</a>
						</div>
					</div>
				{/if}
			</div>
		{/each}
	</div>
</div>
