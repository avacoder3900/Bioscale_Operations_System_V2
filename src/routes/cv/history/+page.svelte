<script lang="ts">
	import { goto } from '$app/navigation';
	import { CARTRIDGE_PHASES } from '$lib/types/cv';
	import type { InspectionResponse } from '$lib/types/cv';

	let { data } = $props();

	// Filter state
	let filterCartridge = $state('');
	let filterPhase = $state('');
	let filterResult = $state('');
	let selectedInspection = $state<InspectionResponse | null>(null);

	const filteredInspections = $derived.by(() => {
		let list = data.inspections;
		if (filterCartridge) {
			const q = filterCartridge.toLowerCase();
			list = list.filter((i) => i.cartridge_record_id?.toLowerCase().includes(q));
		}
		if (filterPhase) {
			list = list.filter((i) => i.phase === filterPhase);
		}
		if (filterResult === 'pass') {
			list = list.filter((i) => i.result === 'pass');
		} else if (filterResult === 'fail') {
			list = list.filter((i) => i.result === 'fail');
		} else if (filterResult === 'pending') {
			list = list.filter((i) => i.status === 'pending' || i.status === 'processing');
		} else if (filterResult === 'error') {
			list = list.filter((i) => i.status === 'failed');
		}
		return list;
	});

	function formatDate(iso: string): string {
		return new Date(iso).toLocaleDateString('en-US', {
			month: 'short',
			day: 'numeric',
			year: 'numeric',
			hour: '2-digit',
			minute: '2-digit'
		});
	}

	function statusColor(status: string, result: string | null): string {
		if (status === 'pending') return 'bg-[var(--color-tron-yellow)] text-black';
		if (status === 'processing') return 'bg-blue-500 text-white';
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

	function severityColor(severity: string): string {
		if (severity === 'high') return 'text-[var(--color-tron-red)]';
		if (severity === 'medium') return 'text-[var(--color-tron-orange)]';
		return 'text-[var(--color-tron-yellow)]';
	}

	function handlePrev() {
		const newSkip = Math.max(0, data.skip - data.limit);
		goto(`/cv/history?skip=${newSkip}&limit=${data.limit}`);
	}

	function handleNext() {
		goto(`/cv/history?skip=${data.skip + data.limit}&limit=${data.limit}`);
	}
</script>

<div class="space-y-6">
	<!-- Header -->
	<div class="flex items-center justify-between">
		<h1 class="text-2xl font-bold text-[var(--color-tron-text)]">Inspection History</h1>
		<span class="text-sm text-[var(--color-tron-text-secondary)]">
			{filteredInspections.length} inspection{filteredInspections.length !== 1 ? 's' : ''}
		</span>
	</div>

	{#if data.error}
		<div class="rounded-lg border border-[var(--color-tron-yellow)] bg-[var(--color-tron-yellow)]/10 p-4">
			<p class="text-sm text-[var(--color-tron-yellow)]">{data.error}</p>
		</div>
	{/if}

	<!-- Filters -->
	<div class="flex flex-wrap gap-3">
		<input
			type="text"
			bind:value={filterCartridge}
			placeholder="Filter by cartridge ID..."
			class="tron-input px-3 py-2 text-sm w-48"
		/>
		<select bind:value={filterPhase} class="tron-input px-3 py-2 text-sm">
			<option value="">All phases</option>
			{#each CARTRIDGE_PHASES as phase}
				<option value={phase}>{phase.replace(/_/g, ' ')}</option>
			{/each}
		</select>
		<select bind:value={filterResult} class="tron-input px-3 py-2 text-sm">
			<option value="">All results</option>
			<option value="pass">Pass</option>
			<option value="fail">Fail</option>
			<option value="pending">Pending</option>
			<option value="error">Error</option>
		</select>
	</div>

	<div class="grid grid-cols-1 gap-6 lg:grid-cols-3">
		<!-- Inspections table -->
		<div class="lg:col-span-2">
			<div class="rounded-lg border border-[var(--color-tron-border)] bg-[var(--color-tron-bg-secondary)]">
				{#if filteredInspections.length === 0}
					<div class="flex flex-col items-center justify-center py-16">
						<p class="text-sm text-[var(--color-tron-text-secondary)]">No inspections found</p>
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
								{#each filteredInspections as insp (insp.id)}
									<!-- svelte-ignore a11y_no_static_element_interactions -->
									<!-- svelte-ignore a11y_click_events_have_key_events -->
									<tr
										class="cursor-pointer border-b border-[var(--color-tron-border)] transition-colors hover:bg-[var(--color-tron-bg-tertiary)] {selectedInspection?.id === insp.id ? 'bg-[var(--color-tron-bg-tertiary)]' : ''}"
										onclick={() => { selectedInspection = insp; }}
									>
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
												<span class="text-xs">{(insp.confidence_score * 100).toFixed(1)}%</span>
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
													onclick={(e) => e.stopPropagation()}
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

					<!-- Pagination -->
					<div class="flex items-center justify-between border-t border-[var(--color-tron-border)] px-4 py-3">
						<button
							onclick={handlePrev}
							disabled={data.skip === 0}
							class="rounded px-3 py-1 text-xs text-[var(--color-tron-text-secondary)] transition-colors hover:text-[var(--color-tron-text)] disabled:opacity-50"
						>
							Previous
						</button>
						<span class="text-xs text-[var(--color-tron-text-secondary)]">
							{data.skip + 1}–{data.skip + filteredInspections.length}
						</span>
						<button
							onclick={handleNext}
							disabled={data.inspections.length < data.limit}
							class="rounded px-3 py-1 text-xs text-[var(--color-tron-text-secondary)] transition-colors hover:text-[var(--color-tron-text)] disabled:opacity-50"
						>
							Next
						</button>
					</div>
				{/if}
			</div>
		</div>

		<!-- Detail panel -->
		<div>
			{#if selectedInspection}
				<div class="rounded-lg border border-[var(--color-tron-border)] bg-[var(--color-tron-bg-secondary)] p-4 space-y-4 sticky top-6">
					<h2 class="text-sm font-semibold text-[var(--color-tron-text)]">Inspection Detail</h2>

					<!-- Image -->
					<div class="rounded overflow-hidden border border-[var(--color-tron-border)]">
						<img
							src="{data.cvBaseUrl}/api/v1/images/{selectedInspection.image_id}/file"
							alt="Inspection"
							class="w-full"
						/>
					</div>

					<!-- Result badge -->
					<div class="text-center">
						<span class="inline-block rounded-lg px-4 py-2 text-lg font-bold {statusColor(selectedInspection.status, selectedInspection.result)}">
							{statusLabel(selectedInspection.status, selectedInspection.result)}
						</span>
					</div>

					<!-- Details -->
					<div class="space-y-2 text-xs">
						<div class="flex justify-between">
							<span class="text-[var(--color-tron-text-secondary)]">Confidence</span>
							<span class="text-[var(--color-tron-text)]">
								{selectedInspection.confidence_score !== null ? `${(selectedInspection.confidence_score * 100).toFixed(1)}%` : '—'}
							</span>
						</div>
						<div class="flex justify-between">
							<span class="text-[var(--color-tron-text-secondary)]">Type</span>
							<span class="text-[var(--color-tron-text)]">{selectedInspection.inspection_type}</span>
						</div>
						<div class="flex justify-between">
							<span class="text-[var(--color-tron-text-secondary)]">Phase</span>
							<span class="text-[var(--color-tron-text)]">{selectedInspection.phase ?? '—'}</span>
						</div>
						<div class="flex justify-between">
							<span class="text-[var(--color-tron-text-secondary)]">Model</span>
							<span class="text-[var(--color-tron-text)]">{selectedInspection.model_version || '—'}</span>
						</div>
						<div class="flex justify-between">
							<span class="text-[var(--color-tron-text-secondary)]">Processing</span>
							<span class="text-[var(--color-tron-text)]">
								{selectedInspection.processing_time_ms ? `${selectedInspection.processing_time_ms}ms` : '—'}
							</span>
						</div>
						<div class="flex justify-between">
							<span class="text-[var(--color-tron-text-secondary)]">Created</span>
							<span class="text-[var(--color-tron-text)]">{formatDate(selectedInspection.created_at)}</span>
						</div>
						{#if selectedInspection.completed_at}
							<div class="flex justify-between">
								<span class="text-[var(--color-tron-text-secondary)]">Completed</span>
								<span class="text-[var(--color-tron-text)]">{formatDate(selectedInspection.completed_at)}</span>
							</div>
						{/if}
						{#if selectedInspection.cartridge_record_id}
							<div class="flex justify-between">
								<span class="text-[var(--color-tron-text-secondary)]">Cartridge</span>
								<a
									href="/cv/cartridge/{selectedInspection.cartridge_record_id}"
									class="text-[var(--color-tron-cyan)] hover:underline"
								>
									{selectedInspection.cartridge_record_id}
								</a>
							</div>
						{/if}
					</div>

					<!-- Defects -->
					{#if selectedInspection.defects && selectedInspection.defects.length > 0}
						<div class="space-y-1">
							<h3 class="text-xs font-semibold uppercase tracking-wider text-[var(--color-tron-text-secondary)]">Defects</h3>
							{#each selectedInspection.defects as defect}
								<div class="flex items-center gap-2 text-xs">
									<span class="{severityColor(defect.severity)} font-bold">
										{defect.severity === 'high' ? '!' : defect.severity === 'medium' ? '*' : '-'}
									</span>
									<span class="text-[var(--color-tron-text)]">{defect.type}</span>
									<span class="text-[var(--color-tron-text-secondary)]">- {defect.location}</span>
								</div>
							{/each}
						</div>
					{/if}
				</div>
			{:else}
				<div class="flex flex-col items-center justify-center rounded-lg border border-dashed border-[var(--color-tron-border)] py-20">
					<p class="text-sm text-[var(--color-tron-text-secondary)]">Click a row to view details</p>
				</div>
			{/if}
		</div>
	</div>
</div>
