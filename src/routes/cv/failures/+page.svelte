<script lang="ts">
	let { data } = $props();

	function fmtDate(d: string) {
		return new Date(d).toLocaleString();
	}

	function pct(n: number) {
		return (n * 100).toFixed(1) + '%';
	}

	const maxDefect = $derived(Math.max(1, ...data.byDefect.map((d: any) => d.count)));
</script>

<div class="space-y-6">
	<div class="flex items-center justify-between">
		<h2 class="text-2xl font-bold text-[var(--color-tron-cyan)]">Common Failures</h2>
		<p class="text-sm text-[var(--color-tron-text-secondary)]">
			{data.totalFailures} failed of {data.totalInspections} inspections
		</p>
	</div>

	<!-- Stats -->
	<div class="grid grid-cols-2 gap-4 sm:grid-cols-3">
		<div class="rounded-lg border border-[var(--color-tron-border)] bg-[var(--color-tron-bg-secondary)] p-4 text-center">
			<div class="text-2xl font-bold text-[var(--color-tron-red)]">{data.totalFailures}</div>
			<div class="text-xs uppercase tracking-wider text-[var(--color-tron-text-secondary)]">Failures</div>
		</div>
		<div class="rounded-lg border border-[var(--color-tron-border)] bg-[var(--color-tron-bg-secondary)] p-4 text-center">
			<div class="text-2xl font-bold text-[var(--color-tron-yellow)]">{pct(data.failRate)}</div>
			<div class="text-xs uppercase tracking-wider text-[var(--color-tron-text-secondary)]">Fail Rate</div>
		</div>
		<div class="rounded-lg border border-[var(--color-tron-border)] bg-[var(--color-tron-bg-secondary)] p-4 text-center">
			<div class="text-2xl font-bold text-[var(--color-tron-text-primary)]">{data.byDefect.length}</div>
			<div class="text-xs uppercase tracking-wider text-[var(--color-tron-text-secondary)]">Failure Modes</div>
		</div>
	</div>

	<div class="grid gap-6 lg:grid-cols-2">
		<!-- Top defect types -->
		<div class="rounded-lg border border-[var(--color-tron-border)] bg-[var(--color-tron-bg-secondary)] p-4">
			<h3 class="mb-4 text-sm font-semibold uppercase tracking-wider text-[var(--color-tron-text-secondary)]">
				Most Common Defect Types
			</h3>
			{#if data.byDefect.length === 0}
				<p class="text-sm text-[var(--color-tron-text-secondary)]">No defect data recorded on failed inspections yet.</p>
			{:else}
				<div class="space-y-2">
					{#each data.byDefect as d}
						<div>
							<div class="mb-1 flex items-center justify-between text-sm">
								<span class="text-[var(--color-tron-text-primary)]">{d._id}</span>
								<span class="text-[var(--color-tron-text-secondary)]">{d.count}</span>
							</div>
							<div class="h-2 overflow-hidden rounded-full bg-[var(--color-tron-bg-tertiary)]">
								<div
									class="h-full rounded-full bg-[var(--color-tron-red)]"
									style="width: {(d.count / maxDefect) * 100}%"
								></div>
							</div>
						</div>
					{/each}
				</div>
			{/if}
		</div>

		<!-- Failures by phase -->
		<div class="rounded-lg border border-[var(--color-tron-border)] bg-[var(--color-tron-bg-secondary)] p-4">
			<h3 class="mb-4 text-sm font-semibold uppercase tracking-wider text-[var(--color-tron-text-secondary)]">
				Failures by Phase
			</h3>
			{#if data.byPhase.length === 0}
				<p class="text-sm text-[var(--color-tron-text-secondary)]">No failures recorded yet.</p>
			{:else}
				<div class="space-y-2">
					{#each data.byPhase as p}
						<div class="flex items-center justify-between rounded bg-[var(--color-tron-bg-tertiary)] px-3 py-2 text-sm">
							<span class="text-[var(--color-tron-text-primary)]">{p._id}</span>
							<span class="font-semibold text-[var(--color-tron-red)]">{p.count}</span>
						</div>
					{/each}
				</div>
			{/if}
		</div>
	</div>

	<!-- Failures by project -->
	<div class="rounded-lg border border-[var(--color-tron-border)] bg-[var(--color-tron-bg-secondary)] p-4">
		<h3 class="mb-4 text-sm font-semibold uppercase tracking-wider text-[var(--color-tron-text-secondary)]">
			Failures by Project
		</h3>
		{#if data.byProject.length === 0}
			<p class="text-sm text-[var(--color-tron-text-secondary)]">No failures recorded yet.</p>
		{:else}
			<div class="flex flex-wrap gap-2">
				{#each data.byProject as p}
					<div class="flex items-center gap-2 rounded-lg border border-[var(--color-tron-border)] bg-[var(--color-tron-bg-tertiary)] px-3 py-1.5 text-sm">
						<span class="text-[var(--color-tron-text-primary)]">{data.projectMap[p._id] || p._id || 'Unassigned'}</span>
						<span class="rounded-full bg-[var(--color-tron-red)]/20 px-2 py-0.5 text-xs font-semibold text-[var(--color-tron-red)]">{p.count}</span>
					</div>
				{/each}
			</div>
		{/if}
	</div>

	<!-- Recent failures -->
	<div class="overflow-hidden rounded-lg border border-[var(--color-tron-border)] bg-[var(--color-tron-bg-secondary)]">
		<h3 class="border-b border-[var(--color-tron-border)] px-4 py-3 text-sm font-semibold uppercase tracking-wider text-[var(--color-tron-text-secondary)]">
			Recent Failures
		</h3>
		{#if data.recent.length === 0}
			<div class="p-8 text-center text-[var(--color-tron-text-secondary)]">No failed inspections recorded.</div>
		{:else}
			<div class="overflow-x-auto">
				<table class="w-full">
					<thead>
						<tr class="border-b border-[var(--color-tron-border)] text-left text-xs uppercase tracking-wider text-[var(--color-tron-text-secondary)]">
							<th class="px-4 py-3">Project</th>
							<th class="px-4 py-3">Phase</th>
							<th class="px-4 py-3">Defects</th>
							<th class="px-4 py-3">Confidence</th>
							<th class="px-4 py-3">Date</th>
							<th class="px-4 py-3">Cartridge</th>
						</tr>
					</thead>
					<tbody class="divide-y divide-[var(--color-tron-border)]">
						{#each data.recent as insp}
							<tr class="transition-colors hover:bg-[var(--color-tron-bg-tertiary)]">
								<td class="px-4 py-2 text-sm text-[var(--color-tron-text-primary)]">
									{data.projectMap[insp.projectId] || insp.projectId || '—'}
								</td>
								<td class="px-4 py-2 text-sm text-[var(--color-tron-text-secondary)]">{insp.phase || '—'}</td>
								<td class="px-4 py-2 text-sm text-[var(--color-tron-text-secondary)]">
									{#if insp.defects?.length}
										<div class="flex flex-wrap gap-1">
											{#each insp.defects as def}
												<span class="rounded bg-[var(--color-tron-red)]/10 px-1.5 py-0.5 text-xs text-[var(--color-tron-red)]">
													{def.type || 'defect'}{def.severity ? ` (${def.severity})` : ''}
												</span>
											{/each}
										</div>
									{:else}
										<span class="text-xs text-[var(--color-tron-text-secondary)]">—</span>
									{/if}
								</td>
								<td class="px-4 py-2 text-sm text-[var(--color-tron-text-primary)]">
									{insp.confidenceScore != null ? Math.round(insp.confidenceScore * 100) + '%' : '—'}
								</td>
								<td class="px-4 py-2 text-xs text-[var(--color-tron-text-secondary)]">{fmtDate(insp.createdAt)}</td>
								<td class="px-4 py-2">
									{#if insp.cartridgeRecordId}
										<a href="/cv/cartridge/{insp.cartridgeRecordId}" class="text-xs text-[var(--color-tron-cyan)] hover:underline">{insp.cartridgeRecordId}</a>
									{:else}
										<span class="text-xs text-[var(--color-tron-text-secondary)]">—</span>
									{/if}
								</td>
							</tr>
						{/each}
					</tbody>
				</table>
			</div>
		{/if}
	</div>
</div>
