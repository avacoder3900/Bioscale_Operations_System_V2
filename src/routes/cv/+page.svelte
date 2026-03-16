<script lang="ts">
	let { data } = $props();

	function formatDate(iso: string): string {
		const d = new Date(iso);
		return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
	}

	function statusColor(status: string, result: string | null): string {
		if (status === 'pending') return 'bg-[var(--color-tron-yellow)] text-black';
		if (status === 'processing') return 'bg-blue-500 text-white animate-pulse';
		if (status === 'failed') return 'bg-gray-500 text-white';
		if (result === 'pass') return 'bg-[var(--color-tron-green)] text-black';
		if (result === 'fail') return 'bg-[var(--color-tron-red)] text-white';
		return 'bg-gray-500 text-white';
	}

	function statusLabel(status: string, result: string | null): string {
		if (status === 'pending') return 'Pending';
		if (status === 'processing') return 'Processing';
		if (status === 'failed') return 'Error';
		if (result === 'pass') return 'PASS';
		if (result === 'fail') return 'FAIL';
		return status;
	}
</script>

<div class="space-y-6">
	<!-- Header -->
	<div class="flex items-center justify-between">
		<h1 class="text-2xl font-bold text-[var(--color-tron-text)]">Computer Vision Dashboard</h1>
		<a
			href="/cv/inspect"
			class="rounded-md bg-[var(--color-tron-cyan)] px-4 py-2 text-sm font-medium text-black transition-opacity hover:opacity-90"
		>
			Capture & Inspect
		</a>
	</div>

	{#if data.error}
		<div class="rounded-lg border border-[var(--color-tron-yellow)] bg-[var(--color-tron-yellow)]/10 p-4">
			<p class="text-sm text-[var(--color-tron-yellow)]">{data.error}</p>
			<p class="mt-1 text-xs text-[var(--color-tron-text-secondary)]">
				Ensure the CV API is running at the configured CV_API_URL.
			</p>
		</div>
	{/if}

	<!-- Stats cards -->
	<div class="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
		<div class="rounded-lg border border-[var(--color-tron-border)] bg-[var(--color-tron-bg-secondary)] p-4">
			<p class="text-xs font-medium uppercase tracking-wider text-[var(--color-tron-text-secondary)]">
				Total Inspections
			</p>
			<p class="mt-2 text-3xl font-bold text-[var(--color-tron-text)]">
				{data.stats?.total_inspections ?? '—'}
			</p>
		</div>

		<div class="rounded-lg border border-[var(--color-tron-border)] bg-[var(--color-tron-bg-secondary)] p-4">
			<p class="text-xs font-medium uppercase tracking-wider text-[var(--color-tron-text-secondary)]">
				Pass Rate
			</p>
			<p class="mt-2 text-3xl font-bold text-[var(--color-tron-green)]">
				{data.stats ? `${(data.stats.pass_rate * 100).toFixed(1)}%` : '—'}
			</p>
		</div>

		<div class="rounded-lg border border-[var(--color-tron-border)] bg-[var(--color-tron-bg-secondary)] p-4">
			<p class="text-xs font-medium uppercase tracking-wider text-[var(--color-tron-text-secondary)]">
				Failures
			</p>
			<p class="mt-2 text-3xl font-bold text-[var(--color-tron-red)]">
				{data.stats?.fail_count ?? '—'}
			</p>
		</div>

		<div class="rounded-lg border border-[var(--color-tron-border)] bg-[var(--color-tron-bg-secondary)] p-4">
			<p class="text-xs font-medium uppercase tracking-wider text-[var(--color-tron-text-secondary)]">
				Pending
			</p>
			<p class="mt-2 text-3xl font-bold text-[var(--color-tron-yellow)]">
				{data.stats?.pending_count ?? '—'}
			</p>
		</div>
	</div>

	<!-- Main content grid -->
	<div class="grid grid-cols-1 gap-6 lg:grid-cols-3">
		<!-- Recent Inspections table (2/3 width) -->
		<div class="lg:col-span-2">
			<div class="rounded-lg border border-[var(--color-tron-border)] bg-[var(--color-tron-bg-secondary)]">
				<div class="border-b border-[var(--color-tron-border)] px-4 py-3">
					<h2 class="text-sm font-semibold text-[var(--color-tron-text)]">Recent Inspections</h2>
				</div>

				{#if data.recentInspections.length === 0}
					<div class="flex flex-col items-center justify-center py-12">
						<svg class="mb-3 h-10 w-10 text-[var(--color-tron-text-secondary)]" fill="none" stroke="currentColor" viewBox="0 0 24 24">
							<path stroke-linecap="round" stroke-linejoin="round" stroke-width="1.5" d="M2.036 12.322a1.012 1.012 0 010-.639C3.423 7.51 7.36 4.5 12 4.5c4.638 0 8.573 3.007 9.963 7.178.07.207.07.431 0 .639C20.577 16.49 16.64 19.5 12 19.5c-4.638 0-8.573-3.007-9.963-7.178z" />
							<path stroke-linecap="round" stroke-linejoin="round" d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
						</svg>
						<p class="text-sm text-[var(--color-tron-text-secondary)]">No inspections yet</p>
						<a href="/cv/inspect" class="mt-2 text-xs text-[var(--color-tron-cyan)] hover:underline">
							Run your first inspection
						</a>
					</div>
				{:else}
					<div class="overflow-x-auto">
						<table class="w-full text-sm">
							<thead>
								<tr class="border-b border-[var(--color-tron-border)] text-left text-xs uppercase tracking-wider text-[var(--color-tron-text-secondary)]">
									<th class="px-4 py-2">Status</th>
									<th class="px-4 py-2">Type</th>
									<th class="px-4 py-2">Confidence</th>
									<th class="px-4 py-2">Phase</th>
									<th class="px-4 py-2">Cartridge</th>
									<th class="px-4 py-2">Date</th>
								</tr>
							</thead>
							<tbody>
								{#each data.recentInspections as insp (insp.id)}
									<tr class="border-b border-[var(--color-tron-border)] transition-colors hover:bg-[var(--color-tron-bg-tertiary)]">
										<td class="px-4 py-2">
											<span class="inline-block rounded px-2 py-0.5 text-xs font-semibold {statusColor(insp.status, insp.result)}">
												{statusLabel(insp.status, insp.result)}
											</span>
										</td>
										<td class="px-4 py-2 text-[var(--color-tron-text-secondary)]">
											{insp.inspection_type}
										</td>
										<td class="px-4 py-2">
											{#if insp.confidence_score !== null}
												<div class="flex items-center gap-2">
													<div class="h-1.5 w-16 rounded-full bg-[var(--color-tron-bg-tertiary)]">
														<div
															class="h-full rounded-full {insp.result === 'pass' ? 'bg-[var(--color-tron-green)]' : 'bg-[var(--color-tron-red)]'}"
															style="width: {Math.min(insp.confidence_score * 100, 100)}%"
														></div>
													</div>
													<span class="text-xs text-[var(--color-tron-text-secondary)]">
														{(insp.confidence_score * 100).toFixed(0)}%
													</span>
												</div>
											{:else}
												<span class="text-xs text-[var(--color-tron-text-secondary)]">—</span>
											{/if}
										</td>
										<td class="px-4 py-2 text-[var(--color-tron-text-secondary)]">
											{insp.phase ?? '—'}
										</td>
										<td class="px-4 py-2">
											{#if insp.cartridge_record_id}
												<a
													href="/cv/cartridge/{insp.cartridge_record_id}"
													class="text-xs text-[var(--color-tron-cyan)] hover:underline"
												>
													{insp.cartridge_record_id}
												</a>
											{:else}
												<span class="text-xs text-[var(--color-tron-text-secondary)]">—</span>
											{/if}
										</td>
										<td class="px-4 py-2 text-xs text-[var(--color-tron-text-secondary)]">
											{formatDate(insp.created_at)}
										</td>
									</tr>
								{/each}
							</tbody>
						</table>
					</div>
				{/if}
			</div>
		</div>

		<!-- Right column: Camera status + Quick actions -->
		<div class="space-y-6">
			<!-- Camera Status -->
			<div class="rounded-lg border border-[var(--color-tron-border)] bg-[var(--color-tron-bg-secondary)]">
				<div class="border-b border-[var(--color-tron-border)] px-4 py-3">
					<h2 class="text-sm font-semibold text-[var(--color-tron-text)]">Cameras</h2>
				</div>
				<div class="p-4 space-y-3">
					{#if data.cameras.length === 0}
						<p class="text-xs text-[var(--color-tron-text-secondary)]">No cameras detected</p>
					{:else}
						{#each data.cameras as cam (cam.index)}
							<div class="flex items-center justify-between rounded border border-[var(--color-tron-border)] px-3 py-2">
								<div>
									<p class="text-sm font-medium text-[var(--color-tron-text)]">{cam.name}</p>
									<p class="text-xs text-[var(--color-tron-text-secondary)]">{cam.width}x{cam.height}</p>
								</div>
								<div class="flex items-center gap-1.5">
									<div class="h-2 w-2 rounded-full {cam.is_open ? 'bg-[var(--color-tron-green)]' : 'bg-[var(--color-tron-text-secondary)]'}"></div>
									<span class="text-xs text-[var(--color-tron-text-secondary)]">
										{cam.is_open ? 'Online' : 'Offline'}
									</span>
								</div>
							</div>
						{/each}
					{/if}
				</div>
			</div>

			<!-- Quick Actions -->
			<div class="rounded-lg border border-[var(--color-tron-border)] bg-[var(--color-tron-bg-secondary)]">
				<div class="border-b border-[var(--color-tron-border)] px-4 py-3">
					<h2 class="text-sm font-semibold text-[var(--color-tron-text)]">Quick Actions</h2>
				</div>
				<div class="p-4 space-y-2">
					<a
						href="/cv/inspect"
						class="flex w-full items-center gap-2 rounded border border-[var(--color-tron-cyan)] px-3 py-2 text-sm font-medium text-[var(--color-tron-cyan)] transition-colors hover:bg-[var(--color-tron-cyan)] hover:text-black"
					>
						<svg class="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2">
							<path stroke-linecap="round" stroke-linejoin="round" d="M3 9a2 2 0 012-2h.93a2 2 0 001.664-.89l.812-1.22A2 2 0 0110.07 4h3.86a2 2 0 011.664.89l.812 1.22A2 2 0 0018.07 7H19a2 2 0 012 2v9a2 2 0 01-2 2H5a2 2 0 01-2-2V9z" />
							<path stroke-linecap="round" stroke-linejoin="round" d="M15 13a3 3 0 11-6 0 3 3 0 016 0z" />
						</svg>
						Capture & Inspect
					</a>
					<a
						href="/cv/history"
						class="flex w-full items-center gap-2 rounded border border-[var(--color-tron-border)] px-3 py-2 text-sm text-[var(--color-tron-text-secondary)] transition-colors hover:border-[var(--color-tron-text-secondary)] hover:text-[var(--color-tron-text)]"
					>
						<svg class="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2">
							<path stroke-linecap="round" stroke-linejoin="round" d="M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z" />
						</svg>
						View History
					</a>
				</div>
			</div>

			<!-- Recent Samples -->
			<div class="rounded-lg border border-[var(--color-tron-border)] bg-[var(--color-tron-bg-secondary)]">
				<div class="border-b border-[var(--color-tron-border)] px-4 py-3">
					<h2 class="text-sm font-semibold text-[var(--color-tron-text)]">Recent Samples</h2>
				</div>
				<div class="p-4 space-y-2">
					{#if data.samples.length === 0}
						<p class="text-xs text-[var(--color-tron-text-secondary)]">No samples found</p>
					{:else}
						{#each data.samples.slice(0, 5) as sample (sample.id)}
							<div class="flex items-center justify-between rounded px-2 py-1.5 text-xs">
								<span class="font-medium text-[var(--color-tron-text)]">{sample.name}</span>
								<span class="text-[var(--color-tron-text-secondary)]">{sample.project || '—'}</span>
							</div>
						{/each}
					{/if}
				</div>
			</div>
		</div>
	</div>
</div>
