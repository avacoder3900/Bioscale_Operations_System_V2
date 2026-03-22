<script lang="ts">
	import { enhance } from '$app/forms';
	import { goto } from '$app/navigation';

	let { data, form } = $props();

	let searchInput = $state(data.filters.search);
	let statusFilter = $state(data.filters.status);
	let showDeleteConfirm = $state<string | null>(null);

	function handleSearch(e: Event) {
		e.preventDefault();
		applyFilters();
	}

	function applyFilters() {
		const params = new URLSearchParams();
		if (searchInput.trim()) params.set('search', searchInput.trim());
		if (statusFilter) params.set('status', statusFilter);
		goto(`/assays?${params.toString()}`);
	}

	function formatDuration(ms: number | null): string {
		if (!ms) return '—';
		if (ms < 1000) return `${ms}ms`;
		const seconds = ms / 1000;
		if (seconds < 60) return `${seconds.toFixed(1)}s`;
		const minutes = Math.floor(seconds / 60);
		const remainingSeconds = Math.round(seconds % 60);
		return `${minutes}m ${remainingSeconds}s`;
	}

	function formatDate(date: string | Date | null): string {
		if (!date) return '—';
		return new Date(date).toLocaleDateString();
	}
</script>

<div class="mx-auto max-w-7xl space-y-6 p-4">
	<!-- Header -->
	<div class="flex items-center justify-between">
		<h1 class="text-2xl font-bold" style="color: var(--color-tron-cyan, #00ffff)">Assays</h1>
		<div class="flex gap-2">
			<a
				href="/assays/export?format=csv"
				class="tron-button"
				style="min-height: 44px"
			>
				Export CSV
			</a>
			{#if data.canWrite}
				<a
					href="/assays/import"
					class="tron-button"
					style="min-height: 44px"
				>
					Import JSON
				</a>
				<a
					href="/assays/new"
					class="tron-button"
					style="min-height: 44px; background: var(--color-tron-cyan, #00ffff); color: #000; font-weight: 600"
				>
					+ Create Assay
				</a>
			{/if}
		</div>
	</div>

	<!-- Stats Cards -->
	<div class="grid grid-cols-2 gap-4 md:grid-cols-4">
		<div class="tron-card p-4 text-center">
			<div class="text-2xl font-bold" style="color: var(--color-tron-cyan, #00ffff)">
				{data.stats.total}
			</div>
			<div class="text-sm" style="color: var(--color-tron-text-secondary, #9ca3af)">
				Total Assays
			</div>
		</div>
		<div class="tron-card p-4 text-center">
			<div class="text-2xl font-bold" style="color: var(--color-tron-green, #39ff14)">
				{data.stats.active}
			</div>
			<div class="text-sm" style="color: var(--color-tron-text-secondary, #9ca3af)">Active</div>
		</div>
		<div class="tron-card p-4 text-center">
			<div class="text-2xl font-bold" style="color: var(--color-tron-text-secondary, #9ca3af)">
				{data.stats.inactive}
			</div>
			<div class="text-sm" style="color: var(--color-tron-text-secondary, #9ca3af)">
				Inactive
			</div>
		</div>
		<div class="tron-card p-4 text-center">
			<div class="text-2xl font-bold" style="color: var(--color-tron-orange, #f97316)">
				{data.stats.totalLinkedCartridges}
			</div>
			<div class="text-sm" style="color: var(--color-tron-text-secondary, #9ca3af)">
				Linked Cartridges
			</div>
		</div>
	</div>

	<!-- Search & Filters -->
	<div class="tron-card p-4">
		<form onsubmit={handleSearch} class="flex flex-wrap items-end gap-3">
			<div class="flex-1">
				<input
					type="text"
					class="tron-input w-full"
					style="min-height: 44px"
					placeholder="Search by name or assay ID..."
					bind:value={searchInput}
				/>
			</div>
			<select
				class="tron-input"
				style="min-height: 44px"
				bind:value={statusFilter}
				onchange={applyFilters}
			>
				<option value="">All Status</option>
				<option value="active">Active</option>
				<option value="inactive">Inactive</option>
			</select>
			<button class="tron-button" style="min-height: 44px" type="submit">Search</button>
			{#if data.filters.search || data.filters.status}
				<a href="/assays" class="tron-button" style="min-height: 44px; opacity: 0.7">
					Clear
				</a>
			{/if}
		</form>
	</div>

	<!-- Success/Error Messages -->
	{#if form?.success}
		<div
			class="tron-card p-3"
			style="border-color: var(--color-tron-green, #39ff14); color: var(--color-tron-green, #39ff14)"
		>
			Operation completed successfully.
		</div>
	{/if}
	{#if form?.error}
		<div class="tron-card p-3" style="border-color: #ef4444; color: #ef4444">
			{form.error}
		</div>
	{/if}

	<!-- Table -->
	{#if data.assays.length === 0}
		<div class="tron-card p-8 text-center">
			<p style="color: var(--color-tron-text-secondary, #9ca3af)">
				{#if data.filters.search || data.filters.status}
					No assays match your filters.
				{:else}
					No assays found. Create one to get started.
				{/if}
			</p>
		</div>
	{:else}
		<div class="overflow-x-auto">
			<table class="tron-table w-full">
				<thead>
					<tr>
						<th>Assay ID</th>
						<th>Name</th>
						<th>Duration</th>
						<th>BCODE Length</th>
						<th>Version</th>
						<th>Cartridges</th>
						<th>Status</th>
						<th>Updated</th>
						{#if data.canWrite || data.canDelete}
							<th>Actions</th>
						{/if}
					</tr>
				</thead>
				<tbody>
					{#each data.assays as assay (assay.assayId)}
						<tr
							style="cursor: pointer"
							onclick={() => goto(`/assays/${assay.assayId}`)}
						>
							<td style="color: var(--color-tron-cyan, #00ffff); font-family: monospace">
								{assay.assayId}
							</td>
							<td>{assay.name}</td>
							<td>{formatDuration(assay.duration)}</td>
							<td style="font-family: monospace">
								{assay.bcodeLength ?? '—'}
							</td>
							<td>v{assay.version ?? 1}</td>
							<td>
								{#if assay.linkedCartridges > 0}
									<span style="color: var(--color-tron-cyan, #00ffff)">
										{assay.linkedCartridges}
									</span>
								{:else}
									<span style="color: var(--color-tron-text-secondary, #9ca3af)">0</span>
								{/if}
							</td>
							<td>
								{#if assay.isActive}
									<span
										class="inline-block rounded px-2 py-1 text-xs font-semibold"
										style="background: color-mix(in srgb, var(--color-tron-green, #39ff14) 20%, transparent); color: var(--color-tron-green, #39ff14); border: 1px solid var(--color-tron-green, #39ff14)"
									>
										Active
									</span>
								{:else}
									<span
										class="inline-block rounded px-2 py-1 text-xs font-semibold"
										style="background: color-mix(in srgb, #6b7280 20%, transparent); color: #6b7280; border: 1px solid #6b7280"
									>
										Inactive
									</span>
								{/if}
							</td>
							<td style="color: var(--color-tron-text-secondary, #9ca3af)">
								{formatDate(assay.updatedAt)}
							</td>
							{#if data.canWrite || data.canDelete}
								<td>
									<!-- svelte-ignore a11y_click_events_have_key_events a11y_no_static_element_interactions -->
								<div class="flex gap-1" onclick={(e) => e.stopPropagation()}>
										{#if data.canWrite}
											<form method="POST" action="?/duplicate" use:enhance>
												<input type="hidden" name="assayId" value={assay.assayId} />
												<button
													class="tron-button px-2 py-1 text-xs"
													style="min-height: 32px"
													type="submit"
												>
													Duplicate
												</button>
											</form>
										{/if}
										{#if data.canDelete}
											{#if showDeleteConfirm === assay.assayId}
												<form method="POST" action="?/delete" use:enhance>
													<input type="hidden" name="assayId" value={assay.assayId} />
													<button
														class="tron-button px-2 py-1 text-xs"
														style="min-height: 32px; color: #ef4444; border-color: #ef4444"
														type="submit"
													>
														Confirm
													</button>
												</form>
												<button
													class="tron-button px-2 py-1 text-xs"
													style="min-height: 32px"
													onclick={() => (showDeleteConfirm = null)}
												>
													Cancel
												</button>
											{:else}
												<button
													class="tron-button px-2 py-1 text-xs"
													style="min-height: 32px; opacity: 0.7"
													onclick={() => (showDeleteConfirm = assay.assayId)}
												>
													Deactivate
												</button>
											{/if}
										{/if}
									</div>
								</td>
							{/if}
						</tr>
					{/each}
				</tbody>
			</table>
		</div>
	{/if}
</div>
