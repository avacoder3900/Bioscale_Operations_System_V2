<script lang="ts">
	let { data } = $props();
</script>

<div class="space-y-6">
	<div class="flex items-center justify-between">
		<h2 class="tron-heading text-2xl font-bold text-[var(--color-tron-cyan)]">
			CV Dashboard
		</h2>
		<a
			href="/cv/inspect"
			class="rounded-lg bg-[var(--color-tron-cyan)] px-4 py-2 font-medium text-[var(--color-tron-bg-primary)] transition-colors hover:opacity-90"
		>
			Capture & Inspect
		</a>
	</div>

	<!-- API Status -->
	{#if !data.healthy}
		<div class="rounded-lg border border-[var(--color-tron-red)]/30 bg-[var(--color-tron-red)]/10 p-4">
			<p class="text-sm text-[var(--color-tron-red)]">
				CV API is not reachable. Check that the CV service is running and CV_API_URL is configured.
			</p>
		</div>
	{/if}

	<!-- Stats Bar -->
	<div class="grid grid-cols-2 gap-4 sm:grid-cols-4">
		<div class="rounded-lg border border-[var(--color-tron-border)] bg-[var(--color-tron-bg-secondary)] p-4">
			<p class="text-xs uppercase tracking-wider text-[var(--color-tron-text-secondary)]">Total Inspections</p>
			<p class="mt-1 text-2xl font-bold text-[var(--color-tron-text-primary)]">{data.stats.total}</p>
		</div>
		<div class="rounded-lg border border-[var(--color-tron-border)] bg-[var(--color-tron-bg-secondary)] p-4">
			<p class="text-xs uppercase tracking-wider text-[var(--color-tron-green)]">Passed</p>
			<p class="mt-1 text-2xl font-bold text-[var(--color-tron-green)]">{data.stats.passed}</p>
		</div>
		<div class="rounded-lg border border-[var(--color-tron-border)] bg-[var(--color-tron-bg-secondary)] p-4">
			<p class="text-xs uppercase tracking-wider text-[var(--color-tron-red)]">Failed</p>
			<p class="mt-1 text-2xl font-bold text-[var(--color-tron-red)]">{data.stats.failed}</p>
		</div>
		<div class="rounded-lg border border-[var(--color-tron-border)] bg-[var(--color-tron-bg-secondary)] p-4">
			<p class="text-xs uppercase tracking-wider text-[var(--color-tron-cyan)]">Pass Rate</p>
			<p class="mt-1 text-2xl font-bold text-[var(--color-tron-cyan)]">{data.stats.passRate}%</p>
		</div>
	</div>

	<div class="grid gap-6 lg:grid-cols-3">
		<!-- Recent Inspections (2/3) -->
		<div class="lg:col-span-2">
			<div class="rounded-lg border border-[var(--color-tron-border)] bg-[var(--color-tron-bg-secondary)]">
				<div class="border-b border-[var(--color-tron-border)] px-4 py-3">
					<h3 class="font-semibold text-[var(--color-tron-text-primary)]">Recent Inspections</h3>
				</div>
				{#if data.inspections.length === 0}
					<div class="p-8 text-center text-[var(--color-tron-text-secondary)]">
						No inspections yet. <a href="/cv/inspect" class="text-[var(--color-tron-cyan)] hover:underline">Capture your first image</a>.
					</div>
				{:else}
					<div class="divide-y divide-[var(--color-tron-border)]">
						{#each data.inspections as insp}
							<div class="flex items-center gap-4 px-4 py-3">
								<img
									src={insp.thumbUrl}
									alt="Inspection thumbnail"
									class="h-12 w-12 rounded border border-[var(--color-tron-border)] object-cover"
									onerror={(e) => { (e.currentTarget as HTMLImageElement).style.display = 'none'; }}
								/>
								<div class="min-w-0 flex-1">
									<div class="flex items-center gap-2">
										<span class="text-sm font-medium text-[var(--color-tron-text-primary)]">
											{insp.inspection_type}
										</span>
										{#if insp.status === 'complete'}
											{#if insp.result === 'pass'}
												<span class="rounded-full bg-[var(--color-tron-green)]/20 px-2 py-0.5 text-xs font-semibold text-[var(--color-tron-green)]">PASS</span>
											{:else}
												<span class="rounded-full bg-[var(--color-tron-red)]/20 px-2 py-0.5 text-xs font-semibold text-[var(--color-tron-red)]">FAIL</span>
											{/if}
										{:else if insp.status === 'pending' || insp.status === 'processing'}
											<span class="animate-pulse rounded-full bg-[var(--color-tron-yellow)]/20 px-2 py-0.5 text-xs font-semibold text-[var(--color-tron-yellow)]">{insp.status}</span>
										{:else}
											<span class="rounded-full bg-[var(--color-tron-text-secondary)]/20 px-2 py-0.5 text-xs text-[var(--color-tron-text-secondary)]">Error</span>
										{/if}
									</div>
									<p class="mt-0.5 text-xs text-[var(--color-tron-text-secondary)]">
										{new Date(insp.created_at).toLocaleString()}
										{#if insp.confidence_score !== null}
											&middot; Score: {(insp.confidence_score * 100).toFixed(1)}%
										{/if}
										{#if insp.cartridge_record_id}
											&middot; <a href="/cv/cartridge/{insp.cartridge_record_id}" class="text-[var(--color-tron-cyan)] hover:underline">View Cartridge</a>
										{/if}
									</p>
								</div>
							</div>
						{/each}
					</div>
				{/if}
				{#if data.inspections.length > 0}
					<div class="border-t border-[var(--color-tron-border)] px-4 py-2 text-center">
						<a href="/cv/history" class="text-sm text-[var(--color-tron-cyan)] hover:underline">View all inspections</a>
					</div>
				{/if}
			</div>
		</div>

		<!-- Right Column (1/3) -->
		<div class="space-y-6">
			<!-- Camera Status -->
			<div class="rounded-lg border border-[var(--color-tron-border)] bg-[var(--color-tron-bg-secondary)]">
				<div class="border-b border-[var(--color-tron-border)] px-4 py-3">
					<h3 class="font-semibold text-[var(--color-tron-text-primary)]">Cameras</h3>
				</div>
				{#if data.cameras.length === 0}
					<div class="p-4 text-sm text-[var(--color-tron-text-secondary)]">No cameras detected</div>
				{:else}
					<div class="divide-y divide-[var(--color-tron-border)]">
						{#each data.cameras as cam}
							<div class="flex items-center justify-between px-4 py-3">
								<div>
									<p class="text-sm font-medium text-[var(--color-tron-text-primary)]">{cam.name}</p>
									<p class="text-xs text-[var(--color-tron-text-secondary)]">{cam.width}x{cam.height}</p>
								</div>
								<div class="h-2.5 w-2.5 rounded-full {cam.is_open ? 'bg-[var(--color-tron-green)]' : 'bg-[var(--color-tron-text-secondary)]'}"></div>
							</div>
						{/each}
					</div>
				{/if}
			</div>

			<!-- Quick Actions -->
			<div class="rounded-lg border border-[var(--color-tron-border)] bg-[var(--color-tron-bg-secondary)] p-4">
				<h3 class="mb-3 font-semibold text-[var(--color-tron-text-primary)]">Quick Actions</h3>
				<div class="space-y-2">
					<a
						href="/cv/inspect"
						class="flex w-full items-center gap-2 rounded-lg border border-[var(--color-tron-cyan)]/30 px-3 py-2 text-sm text-[var(--color-tron-cyan)] transition-colors hover:bg-[var(--color-tron-cyan)]/10"
					>
						<svg class="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
							<path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M3 9a2 2 0 012-2h.93a2 2 0 001.664-.89l.812-1.22A2 2 0 0110.07 4h3.86a2 2 0 011.664.89l.812 1.22A2 2 0 0018.07 7H19a2 2 0 012 2v9a2 2 0 01-2 2H5a2 2 0 01-2-2V9z" />
							<path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M15 13a3 3 0 11-6 0 3 3 0 016 0z" />
						</svg>
						Capture & Inspect
					</a>
					<a
						href="/cv/history"
						class="flex w-full items-center gap-2 rounded-lg border border-[var(--color-tron-border)] px-3 py-2 text-sm text-[var(--color-tron-text-secondary)] transition-colors hover:bg-[var(--color-tron-bg-tertiary)]"
					>
						<svg class="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
							<path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z" />
						</svg>
						View History
					</a>
				</div>
			</div>
		</div>
	</div>
</div>
