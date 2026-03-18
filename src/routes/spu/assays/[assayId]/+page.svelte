<script lang="ts">
	import { enhance } from '$app/forms';
	import { invalidateAll } from '$app/navigation';
	import VersionHistory from '$lib/components/assay/VersionHistory.svelte';

	let { data, form } = $props();

	let activeTab = $state<'overview' | 'bcode' | 'cartridges' | 'results' | 'versions' | 'reagents'>('overview');
	let showEditModal = $state(false);
	let showDeleteConfirm = $state(false);
	let editName = $state(data.assay.name);
	let editDescription = $state(data.assay.description ?? '');
	let editIsActive = $state(data.assay.isActive);

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
		return new Date(date).toLocaleString();
	}

	function getInstructionLabel(type: string): string {
		const labels: Record<string, string> = {
			START_TEST: 'Start Test',
			DELAY: 'Delay',
			MOVE_MICRONS: 'Move',
			OSCILLATE: 'Oscillate',
			SET_SENSOR_PARAMS: 'Set Sensor',
			BASELINE_SCANS: 'Baseline Scans',
			TEST_SCANS: 'Test Scans',
			SENSOR_READING: 'Sensor Reading',
			CONTINUOUS_SCANS: 'Continuous Scans',
			REPEAT_BEGIN: 'Repeat',
			REPEAT_END: 'End Repeat',
			END_TEST: 'End Test'
		};
		return labels[type] ?? type;
	}

	function getInstructionColor(type: string): string {
		const colors: Record<string, string> = {
			START_TEST: 'var(--color-tron-green, #39ff14)',
			END_TEST: '#ef4444',
			DELAY: 'var(--color-tron-orange, #f97316)',
			MOVE_MICRONS: 'var(--color-tron-cyan, #00ffff)',
			OSCILLATE: 'var(--color-tron-cyan, #00ffff)',
			BASELINE_SCANS: '#a78bfa',
			TEST_SCANS: '#a78bfa',
			REPEAT_BEGIN: '#fbbf24',
			SET_SENSOR_PARAMS: '#6b7280'
		};
		return colors[type] ?? 'var(--color-tron-text-secondary, #9ca3af)';
	}

	// Reagents & BOM state
	let editingReagentId = $state<string | null>(null);
	let editReagent = $state({
		wellPosition: 0, reagentName: '', unitCost: '0',
		volumeMicroliters: 0, unit: '', classification: '',
		hasBreakdown: false, sortOrder: 0, isActive: true
	});
	let showAddReagent = $state(false);
	let newReagent = $state({
		wellPosition: 0, reagentName: '', unitCost: '0',
		volumeMicroliters: 0, unit: 'µL', classification: '',
		hasBreakdown: false, sortOrder: 0
	});
	let expandedReagents = $state<Set<string>>(new Set());
	let showAddSubFor = $state<string | null>(null);
	let newSub = $state({ name: '', unitCost: '0', unit: 'µL', volumeMicroliters: 0, classification: '', sortOrder: 0 });
	let editingSubId = $state<string | null>(null);
	let editSub = $state({ name: '', unitCost: '0', unit: 'µL', volumeMicroliters: 0, classification: '', sortOrder: 0 });
	let showBomSettings = $state(false);
	let bomOverride = $state(data.assay.bomCostOverride ?? '');
	let useSingle = $state(data.assay.useSingleCost ?? false);

	function reagentCost(r: { unitCost: string | null; volumeMicroliters: number | null }): number {
		return (parseFloat(r.unitCost ?? '0') || 0) * (r.volumeMicroliters ?? 0);
	}

	function toggleReagentExpand(id: string) {
		const next = new Set(expandedReagents);
		if (next.has(id)) next.delete(id);
		else next.add(id);
		expandedReagents = next;
	}

	function startEditReagent(r: typeof data.assay.reagents[0]) {
		editReagent = {
			wellPosition: r.wellPosition ?? 0,
			reagentName: r.reagentName ?? '',
			unitCost: r.unitCost ?? '0',
			volumeMicroliters: r.volumeMicroliters ?? 0,
			unit: r.unit ?? '',
			classification: r.classification ?? '',
			hasBreakdown: r.hasBreakdown ?? false,
			sortOrder: r.sortOrder ?? 0,
			isActive: r.isActive ?? true
		};
		editingReagentId = r.id;
	}

	function startEditSub(s: typeof data.assay.reagents[0]['subComponents'][0]) {
		editSub = {
			name: s.name ?? '',
			unitCost: s.unitCost ?? '0',
			unit: s.unit ?? 'µL',
			volumeMicroliters: s.volumeMicroliters ?? 0,
			classification: s.classification ?? '',
			sortOrder: s.sortOrder ?? 0
		};
		editingSubId = s.id;
	}

	async function handleRestoreVersion(versionNumber: number) {
		const res = await fetch(`/spu/assays/${data.assay.assayId}/versions`, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ versionNumber })
		});
		if (res.ok) {
			await invalidateAll();
		}
	}

	function formatParams(type: string, params?: number[]): string {
		if (!params || params.length === 0) return '';
		const labels: Record<string, string[]> = {
			DELAY: ['ms'],
			MOVE_MICRONS: ['microns', 'step delay (us)'],
			OSCILLATE: ['microns', 'step delay (us)', 'cycles'],
			SET_SENSOR_PARAMS: ['gain', 'step', 'integration'],
			BASELINE_SCANS: ['scans'],
			TEST_SCANS: ['scans'],
			SENSOR_READING: ['channel', 'gain', 'step', 'integration'],
			CONTINUOUS_SCANS: ['readings', 'delay (ms)'],
			REPEAT_BEGIN: ['count']
		};
		const paramLabels = labels[type] ?? [];
		return params
			.map((v, i) => (paramLabels[i] ? `${paramLabels[i]}: ${v}` : String(v)))
			.join(', ');
	}
</script>

<div class="mx-auto max-w-7xl space-y-6 p-4">
	<!-- Header -->
	<div class="flex items-start justify-between">
		<div class="flex items-center gap-3">
			<a
				href="/spu/assays"
				class="flex items-center justify-center rounded"
				style="min-width: 44px; min-height: 44px; color: var(--color-tron-text-secondary, #9ca3af)"
				aria-label="Back to assays"
			>
				<svg
					xmlns="http://www.w3.org/2000/svg"
					width="20"
					height="20"
					viewBox="0 0 24 24"
					fill="none"
					stroke="currentColor"
					stroke-width="2"
					stroke-linecap="round"
					stroke-linejoin="round"
				>
					<path d="M19 12H5M12 19l-7-7 7-7" />
				</svg>
			</a>
			<div>
				<div class="flex items-center gap-2">
					<h1 class="text-2xl font-bold" style="color: var(--color-tron-cyan, #00ffff)">
						{data.assay.name}
					</h1>
					{#if data.assay.isActive}
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
				</div>
				<span
					class="font-mono text-sm"
					style="color: var(--color-tron-text-secondary, #9ca3af)"
				>
					{data.assay.assayId}
				</span>
			</div>
		</div>
		<div class="flex gap-2">
			{#if data.canWrite}
				<a
					href="/spu/assays/{data.assay.assayId}/edit"
					class="tron-button"
					style="min-height: 44px; background: var(--color-tron-cyan, #00ffff); color: #000; font-weight: 600"
				>
					Edit Protocol
				</a>
				<button
					class="tron-button"
					style="min-height: 44px"
					onclick={() => {
						editName = data.assay.name;
						editDescription = data.assay.description ?? '';
						editIsActive = data.assay.isActive;
						showEditModal = true;
					}}
				>
					Edit Info
				</button>
				<a
					href="/spu/assays/{data.assay.assayId}/assign"
					class="tron-button"
					style="min-height: 44px"
				>
					Assign to Cartridges
				</a>
				<form method="POST" action="?/duplicate" use:enhance>
					<button
						class="tron-button"
						style="min-height: 44px"
						type="submit"
					>
						Duplicate
					</button>
				</form>
			{/if}
			<a
				href="/spu/assays/export?format=json&assayId={data.assay.assayId}"
				class="tron-button"
				style="min-height: 44px"
			>
				Export JSON
			</a>
			{#if data.canDelete}
				{#if showDeleteConfirm}
					<form method="POST" action="?/delete" use:enhance>
						<button
							class="tron-button"
							style="min-height: 44px; color: #ef4444; border-color: #ef4444"
							type="submit"
						>
							Confirm Delete
						</button>
					</form>
					<button
						class="tron-button"
						style="min-height: 44px"
						onclick={() => (showDeleteConfirm = false)}
					>
						Cancel
					</button>
				{:else}
					<button
						class="tron-button"
						style="min-height: 44px; opacity: 0.7"
						onclick={() => (showDeleteConfirm = true)}
					>
						Deactivate
					</button>
				{/if}
			{/if}
		</div>
	</div>

	<!-- Success/Error Messages -->
	{#if form?.success}
		<div
			class="tron-card p-3"
			style="border-color: var(--color-tron-green, #39ff14); color: var(--color-tron-green, #39ff14)"
		>
			Changes saved successfully.
		</div>
	{/if}
	{#if form?.error}
		<div class="tron-card p-3" style="border-color: #ef4444; color: #ef4444">
			{form.error}
		</div>
	{/if}

	<!-- Tab Bar -->
	<div class="flex gap-1 border-b" style="border-color: var(--color-tron-border, #374151)">
		<button
			class="px-4 py-2"
			style="min-height: 44px; color: {activeTab === 'overview'
				? 'var(--color-tron-cyan, #00ffff)'
				: 'var(--color-tron-text-secondary, #9ca3af)'}; border-bottom: 2px solid {activeTab === 'overview'
				? 'var(--color-tron-cyan, #00ffff)'
				: 'transparent'}"
			onclick={() => (activeTab = 'overview')}
		>
			Overview
		</button>
		<button
			class="px-4 py-2"
			style="min-height: 44px; color: {activeTab === 'bcode'
				? 'var(--color-tron-cyan, #00ffff)'
				: 'var(--color-tron-text-secondary, #9ca3af)'}; border-bottom: 2px solid {activeTab === 'bcode'
				? 'var(--color-tron-cyan, #00ffff)'
				: 'transparent'}"
			onclick={() => (activeTab = 'bcode')}
		>
			BCODE
		</button>
		<button
			class="px-4 py-2"
			style="min-height: 44px; color: {activeTab === 'cartridges'
				? 'var(--color-tron-cyan, #00ffff)'
				: 'var(--color-tron-text-secondary, #9ca3af)'}; border-bottom: 2px solid {activeTab === 'cartridges'
				? 'var(--color-tron-cyan, #00ffff)'
				: 'transparent'}"
			onclick={() => (activeTab = 'cartridges')}
		>
			Cartridges
			{#if data.linkedCartridges.length > 0}
				<span
					class="ml-1 rounded-full px-1.5 py-0.5 text-xs"
					style="background: var(--color-tron-cyan, #00ffff); color: #000"
				>
					{data.linkedCartridges.length}
				</span>
			{/if}
		</button>
		<button
			class="px-4 py-2"
			style="min-height: 44px; color: {activeTab === 'results'
				? 'var(--color-tron-cyan, #00ffff)'
				: 'var(--color-tron-text-secondary, #9ca3af)'}; border-bottom: 2px solid {activeTab === 'results'
				? 'var(--color-tron-cyan, #00ffff)'
				: 'transparent'}"
			onclick={() => (activeTab = 'results')}
		>
			Test Results
			{#if data.testResults.length > 0}
				<span
					class="ml-1 rounded-full px-1.5 py-0.5 text-xs"
					style="background: var(--color-tron-cyan, #00ffff); color: #000"
				>
					{data.testResults.length}
				</span>
			{/if}
		</button>
		<button
			class="px-4 py-2"
			style="min-height: 44px; color: {activeTab === 'versions'
				? 'var(--color-tron-cyan, #00ffff)'
				: 'var(--color-tron-text-secondary, #9ca3af)'}; border-bottom: 2px solid {activeTab === 'versions'
				? 'var(--color-tron-cyan, #00ffff)'
				: 'transparent'}"
			onclick={() => (activeTab = 'versions')}
		>
			Versions
			{#if data.versions.length > 0}
				<span
					class="ml-1 rounded-full px-1.5 py-0.5 text-xs"
					style="background: var(--color-tron-cyan, #00ffff); color: #000"
				>
					{data.versions.length}
				</span>
			{/if}
		</button>
		<button
			class="px-4 py-2"
			style="min-height: 44px; color: {activeTab === 'reagents'
				? 'var(--color-tron-cyan, #00ffff)'
				: 'var(--color-tron-text-secondary, #9ca3af)'}; border-bottom: 2px solid {activeTab === 'reagents'
				? 'var(--color-tron-cyan, #00ffff)'
				: 'transparent'}"
			onclick={() => (activeTab = 'reagents')}
		>
			Reagents & BOM
			{#if data.assay.reagents.length > 0}
				<span
					class="ml-1 rounded-full px-1.5 py-0.5 text-xs"
					style="background: var(--color-tron-cyan, #00ffff); color: #000"
				>
					{data.assay.reagents.length}
				</span>
			{/if}
		</button>
	</div>

	<!-- Overview Tab -->
	{#if activeTab === 'overview'}
		<div class="grid gap-6 lg:grid-cols-2">
			<div class="tron-card p-5">
				<h3 class="mb-4 text-lg font-semibold" style="color: var(--color-tron-cyan, #00ffff)">
					Basic Information
				</h3>
				<dl class="space-y-3">
					<div class="flex justify-between">
						<dt style="color: var(--color-tron-text-secondary, #9ca3af)">Assay ID</dt>
						<dd class="font-mono" style="color: var(--color-tron-cyan, #00ffff)">
							{data.assay.assayId}
						</dd>
					</div>
					<div class="flex justify-between">
						<dt style="color: var(--color-tron-text-secondary, #9ca3af)">Name</dt>
						<dd style="color: var(--color-tron-text-primary, #f3f4f6)">{data.assay.name}</dd>
					</div>
					<div class="flex justify-between">
						<dt style="color: var(--color-tron-text-secondary, #9ca3af)">Description</dt>
						<dd style="color: var(--color-tron-text-primary, #f3f4f6)">
							{data.assay.description ?? '—'}
						</dd>
					</div>
					<div class="flex justify-between">
						<dt style="color: var(--color-tron-text-secondary, #9ca3af)">Status</dt>
						<dd>{data.assay.isActive ? 'Active' : 'Inactive'}</dd>
					</div>
					<div class="flex justify-between">
						<dt style="color: var(--color-tron-text-secondary, #9ca3af)">Version</dt>
						<dd style="color: var(--color-tron-text-primary, #f3f4f6)">
							v{data.assay.version ?? 1}
						</dd>
					</div>
				</dl>
			</div>

			<div class="tron-card p-5">
				<h3 class="mb-4 text-lg font-semibold" style="color: var(--color-tron-cyan, #00ffff)">
					Technical Details
				</h3>
				<dl class="space-y-3">
					<div class="flex justify-between">
						<dt style="color: var(--color-tron-text-secondary, #9ca3af)">Duration</dt>
						<dd style="color: var(--color-tron-text-primary, #f3f4f6)">
							{formatDuration(data.assay.duration)}
						</dd>
					</div>
					<div class="flex justify-between">
						<dt style="color: var(--color-tron-text-secondary, #9ca3af)">BCODE Length</dt>
						<dd class="font-mono" style="color: var(--color-tron-text-primary, #f3f4f6)">
							{data.assay.bcodeLength ?? '—'} bytes
						</dd>
					</div>
					<div class="flex justify-between">
						<dt style="color: var(--color-tron-text-secondary, #9ca3af)">CRC32 Checksum</dt>
						<dd class="font-mono" style="color: var(--color-tron-text-primary, #f3f4f6)">
							{data.assay.checksum ?? '—'}
						</dd>
					</div>
					<div class="flex justify-between">
						<dt style="color: var(--color-tron-text-secondary, #9ca3af)">
							Linked Cartridges
						</dt>
						<dd style="color: var(--color-tron-text-primary, #f3f4f6)">
							{data.linkedCartridges.length}
						</dd>
					</div>
					<div class="flex justify-between">
						<dt style="color: var(--color-tron-text-secondary, #9ca3af)">Test Results</dt>
						<dd style="color: var(--color-tron-text-primary, #f3f4f6)">
							{data.testResults.length}
						</dd>
					</div>
				</dl>
			</div>

			<div class="tron-card p-5 lg:col-span-2">
				<h3 class="mb-4 text-lg font-semibold" style="color: var(--color-tron-cyan, #00ffff)">
					Timestamps
				</h3>
				<dl class="grid gap-3 sm:grid-cols-2">
					<div class="flex justify-between">
						<dt style="color: var(--color-tron-text-secondary, #9ca3af)">Created</dt>
						<dd style="color: var(--color-tron-text-primary, #f3f4f6)">
							{formatDate(data.assay.createdAt)}
						</dd>
					</div>
					<div class="flex justify-between">
						<dt style="color: var(--color-tron-text-secondary, #9ca3af)">Last Updated</dt>
						<dd style="color: var(--color-tron-text-primary, #f3f4f6)">
							{formatDate(data.assay.updatedAt)}
						</dd>
					</div>
				</dl>
			</div>

			{#if data.assay.metadata}
				<div class="tron-card p-5 lg:col-span-2">
					<h3
						class="mb-4 text-lg font-semibold"
						style="color: var(--color-tron-cyan, #00ffff)"
					>
						Metadata
					</h3>
					<pre
						class="overflow-x-auto rounded p-3 text-sm"
						style="background: var(--color-tron-bg-secondary, #1f2937); color: var(--color-tron-text-primary, #f3f4f6); font-family: monospace"
					>{JSON.stringify(data.assay.metadata, null, 2)}</pre>
				</div>
			{/if}
		</div>
	{/if}

	<!-- BCODE Tab -->
	{#if activeTab === 'bcode'}
		<div class="space-y-6">
			<!-- Raw BCODE String -->
			<div class="tron-card p-5">
				<h3 class="mb-4 text-lg font-semibold" style="color: var(--color-tron-cyan, #00ffff)">
					Raw BCODE
				</h3>
				{#if data.bcodeString}
					<div
						class="overflow-x-auto rounded p-4"
						style="background: var(--color-tron-bg-secondary, #1f2937)"
					>
						<code
							class="whitespace-pre-wrap break-all text-sm"
							style="color: var(--color-tron-green, #39ff14); font-family: monospace"
						>
							{data.bcodeString}
						</code>
					</div>
				{:else}
					<p style="color: var(--color-tron-text-secondary, #9ca3af)">No BCODE data.</p>
				{/if}
			</div>

			<!-- Visual Instruction Breakdown -->
			<div class="tron-card p-5">
				<h3 class="mb-4 text-lg font-semibold" style="color: var(--color-tron-cyan, #00ffff)">
					Instruction Breakdown
				</h3>
				{#if data.instructions.length > 0}
					<div class="space-y-2">
						{#each data.instructions as instr, i (i)}
							<div class="flex items-center gap-3 rounded px-3 py-2"
								style="background: var(--color-tron-bg-secondary, #1f2937)"
							>
								<span
									class="text-xs font-mono"
									style="color: var(--color-tron-text-secondary, #9ca3af); min-width: 24px"
								>
									{i + 1}.
								</span>
								<span
									class="rounded px-2 py-0.5 text-xs font-semibold"
									style="background: color-mix(in srgb, {getInstructionColor(instr.type)} 20%, transparent); color: {getInstructionColor(instr.type)}; border: 1px solid {getInstructionColor(instr.type)}"
								>
									{getInstructionLabel(instr.type)}
								</span>
								{#if instr.params && instr.params.length > 0}
									<span
										class="font-mono text-sm"
										style="color: var(--color-tron-text-primary, #f3f4f6)"
									>
										{formatParams(instr.type, instr.params)}
									</span>
								{/if}
							</div>
							<!-- Nested instructions for REPEAT blocks -->
							{#if instr.code && instr.code.length > 0}
								{#each instr.code as nested, j (j)}
									<div
										class="ml-8 flex items-center gap-3 rounded px-3 py-2"
										style="background: var(--color-tron-bg-secondary, #1f2937); border-left: 2px solid #fbbf24"
									>
										<span
											class="text-xs font-mono"
											style="color: var(--color-tron-text-secondary, #9ca3af); min-width: 24px"
										>
											{i + 1}.{j + 1}
										</span>
										<span
											class="rounded px-2 py-0.5 text-xs font-semibold"
											style="background: color-mix(in srgb, {getInstructionColor(nested.type)} 20%, transparent); color: {getInstructionColor(nested.type)}; border: 1px solid {getInstructionColor(nested.type)}"
										>
											{getInstructionLabel(nested.type)}
										</span>
										{#if nested.params && nested.params.length > 0}
											<span
												class="font-mono text-sm"
												style="color: var(--color-tron-text-primary, #f3f4f6)"
											>
												{formatParams(nested.type, nested.params)}
											</span>
										{/if}
									</div>
								{/each}
							{/if}
						{/each}
					</div>
				{:else}
					<p style="color: var(--color-tron-text-secondary, #9ca3af)">
						No instructions to display.
					</p>
				{/if}
			</div>
		</div>
	{/if}

	<!-- Cartridges Tab -->
	{#if activeTab === 'cartridges'}
		<div class="tron-card p-5">
			<h3 class="mb-4 text-lg font-semibold" style="color: var(--color-tron-cyan, #00ffff)">
				Linked Firmware Cartridges
			</h3>
			{#if data.linkedCartridges.length === 0}
				<p style="color: var(--color-tron-text-secondary, #9ca3af)">
					No firmware cartridges are linked to this assay.
				</p>
			{:else}
				<div class="overflow-x-auto">
					<table class="tron-table w-full">
						<thead>
							<tr>
								<th>Cartridge UUID</th>
								<th>Status</th>
								<th>Lot Number</th>
								<th>Serial Number</th>
								<th>Created</th>
							</tr>
						</thead>
						<tbody>
							{#each data.linkedCartridges as c (c.id)}
								<tr>
									<td style="font-family: monospace; color: var(--color-tron-cyan, #00ffff)">
										{c.cartridgeUuid}
									</td>
									<td>
										<span
											class="inline-block rounded px-2 py-1 text-xs font-semibold"
											style="color: var(--color-tron-text-primary, #f3f4f6)"
										>
											{c.status}
										</span>
									</td>
									<td>{c.lotNumber ?? '—'}</td>
									<td>{c.serialNumber ?? '—'}</td>
									<td style="color: var(--color-tron-text-secondary, #9ca3af)">
										{formatDate(c.createdAt)}
									</td>
								</tr>
							{/each}
						</tbody>
					</table>
				</div>
			{/if}
		</div>
	{/if}

	<!-- Test Results Tab -->
	{#if activeTab === 'results'}
		<div class="tron-card p-5">
			<h3 class="mb-4 text-lg font-semibold" style="color: var(--color-tron-cyan, #00ffff)">
				Test Results
			</h3>
			{#if data.testResults.length === 0}
				<p style="color: var(--color-tron-text-secondary, #9ca3af)">
					No test results have been recorded for this assay.
				</p>
			{:else}
				<div class="overflow-x-auto">
					<table class="tron-table w-full">
						<thead>
							<tr>
								<th>ID</th>
								<th>Device</th>
								<th>Cartridge</th>
								<th>Status</th>
								<th>Duration</th>
								<th>Readings</th>
								<th>Created</th>
							</tr>
						</thead>
						<tbody>
							{#each data.testResults as result (result.id)}
								<tr>
									<td style="font-family: monospace">{result.id}</td>
									<td style="font-family: monospace; color: var(--color-tron-cyan, #00ffff)">
										{result.deviceId ?? '—'}
									</td>
									<td style="font-family: monospace">
										{result.cartridgeUuid ?? '—'}
									</td>
									<td>
										<span
											class="inline-block rounded px-2 py-1 text-xs font-semibold"
											style="color: var(--color-tron-text-primary, #f3f4f6)"
										>
											{result.status}
										</span>
									</td>
									<td>{formatDuration(result.duration)}</td>
									<td>{result.numberOfReadings ?? '—'}</td>
									<td style="color: var(--color-tron-text-secondary, #9ca3af)">
										{formatDate(result.createdAt)}
									</td>
								</tr>
							{/each}
						</tbody>
					</table>
				</div>
			{/if}
		</div>
	{/if}

	<!-- Versions Tab -->
	{#if activeTab === 'versions'}
		<div class="tron-card p-5">
			<h3 class="mb-4 text-lg font-semibold" style="color: var(--color-tron-cyan, #00ffff)">
				Version History
			</h3>
			<VersionHistory
				versions={data.versions}
				currentBcode={data.bcodeString}
				canRestore={data.canWrite}
				onrestore={handleRestoreVersion}
			/>
		</div>
	{/if}
</div>

<!-- Reagents & BOM Tab -->
{#if activeTab === 'reagents'}
	<div class="space-y-6">
		<!-- BOM Cost Summary -->
		<div class="tron-card p-5">
			<div class="mb-4 flex items-center justify-between">
				<h3 class="text-lg font-semibold" style="color: var(--color-tron-cyan, #00ffff)">
					BOM Cost Summary
				</h3>
				{#if data.canWrite}
					<button
						class="tron-button"
						style="min-height: 44px; font-size: 0.8rem"
						onclick={() => { showBomSettings = !showBomSettings; }}
					>
						{showBomSettings ? 'Hide Settings' : 'Cost Settings'}
					</button>
				{/if}
			</div>

			{#if showBomSettings}
				<form
					method="POST"
					action="?/updateBomSettings"
					use:enhance={() => ({ async onResult({ update }) { showBomSettings = false; await update(); } })}
					class="mb-4 space-y-3 rounded p-4"
					style="background: var(--color-tron-bg-secondary, #1f2937); border: 1px solid var(--color-tron-border, #374151)"
				>
					<div class="flex items-center gap-3">
						<input type="hidden" name="useSingleCost" value={useSingle ? 'true' : 'false'} />
						<input
							type="checkbox"
							id="useSingleCost"
							bind:checked={useSingle}
						/>
						<label for="useSingleCost" class="text-sm" style="color: var(--color-tron-text-secondary, #9ca3af)">
							Use single cost override
						</label>
					</div>
					{#if useSingle}
						<div>
							<label class="mb-1 block text-sm" style="color: var(--color-tron-text-secondary, #9ca3af)">
								BOM Cost Override ($)
							</label>
							<input
								name="bomCostOverride"
								type="text"
								class="tron-input"
								style="min-height: 44px; width: 200px"
								bind:value={bomOverride}
								placeholder="0.00"
							/>
						</div>
					{:else}
						<input type="hidden" name="bomCostOverride" value="" />
					{/if}
					<div class="flex gap-2">
						<button type="submit" class="tron-button" style="min-height: 44px; background: var(--color-tron-cyan, #00ffff); color: #000; font-weight: 600">
							Save Settings
						</button>
						<button type="button" class="tron-button" style="min-height: 44px" onclick={() => (showBomSettings = false)}>
							Cancel
						</button>
					</div>
				</form>
			{/if}

			<dl class="grid gap-3 sm:grid-cols-3">
				<div class="rounded p-3" style="background: var(--color-tron-bg-secondary, #1f2937)">
					<dt class="mb-1 text-xs" style="color: var(--color-tron-text-secondary, #9ca3af)">
						Active Reagents
					</dt>
					<dd class="text-2xl font-bold" style="color: var(--color-tron-cyan, #00ffff)">
						{data.assay.reagents.filter(r => r.isActive).length}
					</dd>
				</div>
				<div class="rounded p-3" style="background: var(--color-tron-bg-secondary, #1f2937)">
					<dt class="mb-1 text-xs" style="color: var(--color-tron-text-secondary, #9ca3af)">
						Calculated BOM Cost
					</dt>
					<dd class="text-2xl font-bold" style="color: var(--color-tron-green, #39ff14)">
						${data.assay.reagents.filter(r => r.isActive).reduce((sum, r) => sum + reagentCost(r), 0).toFixed(4)}
					</dd>
				</div>
				<div class="rounded p-3" style="background: var(--color-tron-bg-secondary, #1f2937)">
					<dt class="mb-1 text-xs" style="color: var(--color-tron-text-secondary, #9ca3af)">
						{data.assay.useSingleCost ? 'Cost Override' : 'Effective Cost'}
					</dt>
					<dd class="text-2xl font-bold" style="color: var(--color-tron-text-primary, #f3f4f6)">
						{#if data.assay.useSingleCost && data.assay.bomCostOverride}
							${data.assay.bomCostOverride}
						{:else}
							${data.assay.reagents.filter(r => r.isActive).reduce((sum, r) => sum + reagentCost(r), 0).toFixed(4)}
						{/if}
					</dd>
				</div>
			</dl>
		</div>

		<!-- Reagent List -->
		<div class="tron-card p-5">
			<div class="mb-4 flex items-center justify-between">
				<h3 class="text-lg font-semibold" style="color: var(--color-tron-cyan, #00ffff)">
					Reagents
				</h3>
				{#if data.canWrite}
					<button
						class="tron-button"
						style="min-height: 44px; background: var(--color-tron-cyan, #00ffff); color: #000; font-weight: 600"
						onclick={() => {
							newReagent = { wellPosition: (data.assay.reagents.length + 1), reagentName: '', unitCost: '0', volumeMicroliters: 0, unit: 'µL', classification: '', hasBreakdown: false, sortOrder: data.assay.reagents.length };
							showAddReagent = true;
						}}
					>
						+ Add Reagent
					</button>
				{/if}
			</div>

			{#if showAddReagent}
				<form
					method="POST"
					action="?/addReagent"
					use:enhance={() => ({ async onResult({ update }) { showAddReagent = false; await update(); } })}
					class="mb-4 rounded p-4 space-y-3"
					style="background: var(--color-tron-bg-secondary, #1f2937); border: 1px solid var(--color-tron-cyan, #00ffff)"
				>
					<h4 class="font-semibold text-sm" style="color: var(--color-tron-cyan, #00ffff)">New Reagent</h4>
					<div class="grid gap-3 sm:grid-cols-3">
						<div>
							<label class="mb-1 block text-xs" style="color: var(--color-tron-text-secondary, #9ca3af)">Well Position</label>
							<input name="wellPosition" type="number" class="tron-input w-full" style="min-height: 44px" bind:value={newReagent.wellPosition} />
						</div>
						<div class="sm:col-span-2">
							<label class="mb-1 block text-xs" style="color: var(--color-tron-text-secondary, #9ca3af)">Reagent Name *</label>
							<input name="reagentName" type="text" class="tron-input w-full" style="min-height: 44px" bind:value={newReagent.reagentName} required />
						</div>
						<div>
							<label class="mb-1 block text-xs" style="color: var(--color-tron-text-secondary, #9ca3af)">Unit Cost ($)</label>
							<input name="unitCost" type="text" class="tron-input w-full" style="min-height: 44px" bind:value={newReagent.unitCost} placeholder="0.0000" />
						</div>
						<div>
							<label class="mb-1 block text-xs" style="color: var(--color-tron-text-secondary, #9ca3af)">Volume (µL)</label>
							<input name="volumeMicroliters" type="number" step="0.001" class="tron-input w-full" style="min-height: 44px" bind:value={newReagent.volumeMicroliters} />
						</div>
						<div>
							<label class="mb-1 block text-xs" style="color: var(--color-tron-text-secondary, #9ca3af)">Unit</label>
							<input name="unit" type="text" class="tron-input w-full" style="min-height: 44px" bind:value={newReagent.unit} placeholder="µL" />
						</div>
						<div>
							<label class="mb-1 block text-xs" style="color: var(--color-tron-text-secondary, #9ca3af)">Classification</label>
							<input name="classification" type="text" class="tron-input w-full" style="min-height: 44px" bind:value={newReagent.classification} />
						</div>
						<div>
							<label class="mb-1 block text-xs" style="color: var(--color-tron-text-secondary, #9ca3af)">Sort Order</label>
							<input name="sortOrder" type="number" class="tron-input w-full" style="min-height: 44px" bind:value={newReagent.sortOrder} />
						</div>
						<div class="flex items-center gap-2 sm:col-span-2">
							<input type="hidden" name="hasBreakdown" value={newReagent.hasBreakdown ? 'true' : 'false'} />
							<input type="checkbox" id="new-hasBreakdown" bind:checked={newReagent.hasBreakdown} />
							<label for="new-hasBreakdown" class="text-sm" style="color: var(--color-tron-text-secondary, #9ca3af)">Has Sub-component Breakdown</label>
						</div>
					</div>
					<div class="flex gap-2">
						<button type="submit" class="tron-button" style="min-height: 44px; background: var(--color-tron-cyan, #00ffff); color: #000; font-weight: 600">Add Reagent</button>
						<button type="button" class="tron-button" style="min-height: 44px" onclick={() => (showAddReagent = false)}>Cancel</button>
					</div>
				</form>
			{/if}

			{#if data.assay.reagents.length === 0}
				<p style="color: var(--color-tron-text-secondary, #9ca3af)">No reagents defined. Add one above.</p>
			{:else}
				<div class="space-y-2">
					{#each data.assay.reagents.slice().sort((a, b) => (a.sortOrder ?? 0) - (b.sortOrder ?? 0)) as reagent (reagent.id)}
						<div
							class="rounded"
							style="border: 1px solid {reagent.isActive ? 'var(--color-tron-border, #374151)' : '#374151'}; background: var(--color-tron-bg-secondary, #1f2937); opacity: {reagent.isActive ? '1' : '0.6'}"
						>
							{#if editingReagentId === reagent.id}
								<!-- Inline Edit Form -->
								<form
									method="POST"
									action="?/updateReagent"
									use:enhance={() => ({ async onResult({ update }) { editingReagentId = null; await update(); } })}
									class="p-4 space-y-3"
								>
									<input type="hidden" name="reagentId" value={reagent.id} />
									<div class="grid gap-3 sm:grid-cols-3">
										<div>
											<label class="mb-1 block text-xs" style="color: var(--color-tron-text-secondary, #9ca3af)">Well Position</label>
											<input name="wellPosition" type="number" class="tron-input w-full" style="min-height: 44px" bind:value={editReagent.wellPosition} />
										</div>
										<div class="sm:col-span-2">
											<label class="mb-1 block text-xs" style="color: var(--color-tron-text-secondary, #9ca3af)">Reagent Name</label>
											<input name="reagentName" type="text" class="tron-input w-full" style="min-height: 44px" bind:value={editReagent.reagentName} required />
										</div>
										<div>
											<label class="mb-1 block text-xs" style="color: var(--color-tron-text-secondary, #9ca3af)">Unit Cost ($)</label>
											<input name="unitCost" type="text" class="tron-input w-full" style="min-height: 44px" bind:value={editReagent.unitCost} />
										</div>
										<div>
											<label class="mb-1 block text-xs" style="color: var(--color-tron-text-secondary, #9ca3af)">Volume</label>
											<input name="volumeMicroliters" type="number" step="0.001" class="tron-input w-full" style="min-height: 44px" bind:value={editReagent.volumeMicroliters} />
										</div>
										<div>
											<label class="mb-1 block text-xs" style="color: var(--color-tron-text-secondary, #9ca3af)">Unit</label>
											<input name="unit" type="text" class="tron-input w-full" style="min-height: 44px" bind:value={editReagent.unit} />
										</div>
										<div>
											<label class="mb-1 block text-xs" style="color: var(--color-tron-text-secondary, #9ca3af)">Classification</label>
											<input name="classification" type="text" class="tron-input w-full" style="min-height: 44px" bind:value={editReagent.classification} />
										</div>
										<div>
											<label class="mb-1 block text-xs" style="color: var(--color-tron-text-secondary, #9ca3af)">Sort Order</label>
											<input name="sortOrder" type="number" class="tron-input w-full" style="min-height: 44px" bind:value={editReagent.sortOrder} />
										</div>
										<div class="flex items-center gap-2 self-end">
											<input type="hidden" name="hasBreakdown" value={editReagent.hasBreakdown ? 'true' : 'false'} />
											<input type="checkbox" id="edit-hb-{reagent.id}" bind:checked={editReagent.hasBreakdown} />
											<label for="edit-hb-{reagent.id}" class="text-xs" style="color: var(--color-tron-text-secondary, #9ca3af)">Has Breakdown</label>
										</div>
										<div class="flex items-center gap-2 self-end">
											<input type="hidden" name="isActive" value={editReagent.isActive ? 'true' : 'false'} />
											<input type="checkbox" id="edit-active-{reagent.id}" bind:checked={editReagent.isActive} />
											<label for="edit-active-{reagent.id}" class="text-xs" style="color: var(--color-tron-text-secondary, #9ca3af)">Active</label>
										</div>
									</div>
									<div class="flex gap-2">
										<button type="submit" class="tron-button" style="min-height: 44px; background: var(--color-tron-cyan, #00ffff); color: #000; font-weight: 600">Save</button>
										<button type="button" class="tron-button" style="min-height: 44px" onclick={() => (editingReagentId = null)}>Cancel</button>
									</div>
								</form>
							{:else}
								<!-- Read View -->
								<div class="flex items-center gap-3 p-3">
									<div class="flex min-h-[44px] w-10 items-center justify-center rounded text-sm font-bold"
										style="background: color-mix(in srgb, var(--color-tron-cyan, #00ffff) 15%, transparent); color: var(--color-tron-cyan, #00ffff)"
									>
										{reagent.wellPosition ?? '—'}
									</div>
									<div class="min-w-0 flex-1">
										<div class="flex flex-wrap items-center gap-2">
											<span class="font-semibold" style="color: var(--color-tron-text-primary, #f3f4f6)">
												{reagent.reagentName ?? '—'}
											</span>
											{#if reagent.classification}
												<span class="rounded px-1.5 py-0.5 text-xs"
													style="background: color-mix(in srgb, #a78bfa 20%, transparent); color: #a78bfa; border: 1px solid #a78bfa"
												>
													{reagent.classification}
												</span>
											{/if}
											{#if !reagent.isActive}
												<span class="rounded px-1.5 py-0.5 text-xs"
													style="background: color-mix(in srgb, #6b7280 20%, transparent); color: #6b7280; border: 1px solid #6b7280"
												>
													Inactive
												</span>
											{/if}
											{#if reagent.hasBreakdown}
												<span class="rounded px-1.5 py-0.5 text-xs"
													style="background: color-mix(in srgb, var(--color-tron-orange, #f97316) 20%, transparent); color: var(--color-tron-orange, #f97316); border: 1px solid var(--color-tron-orange, #f97316)"
												>
													Breakdown
												</span>
											{/if}
										</div>
										<div class="mt-1 flex flex-wrap gap-4 text-sm">
											<span style="color: var(--color-tron-text-secondary, #9ca3af)">
												{reagent.volumeMicroliters ?? 0} {reagent.unit ?? 'µL'}
											</span>
											<span style="color: var(--color-tron-text-secondary, #9ca3af)">
												Unit cost: <span style="color: var(--color-tron-green, #39ff14)">${reagent.unitCost ?? '0'}</span>
											</span>
											<span style="color: var(--color-tron-text-secondary, #9ca3af)">
												Line cost: <span style="color: var(--color-tron-green, #39ff14)">${reagentCost(reagent).toFixed(4)}</span>
											</span>
										</div>
									</div>
									<div class="flex shrink-0 items-center gap-2">
										{#if reagent.hasBreakdown && reagent.subComponents.length > 0}
											<button
												class="tron-button"
												style="min-height: 44px; font-size: 0.75rem"
												onclick={() => toggleReagentExpand(reagent.id)}
											>
												{expandedReagents.has(reagent.id) ? 'Hide' : 'Sub-components'} ({reagent.subComponents.length})
											</button>
										{/if}
										{#if data.canWrite}
											<button
												class="tron-button"
												style="min-height: 44px; font-size: 0.75rem"
												onclick={() => startEditReagent(reagent)}
											>
												Edit
											</button>
											{#if reagent.hasBreakdown}
												<button
													class="tron-button"
													style="min-height: 44px; font-size: 0.75rem"
													onclick={() => {
														newSub = { name: '', unitCost: '0', unit: 'µL', volumeMicroliters: 0, classification: '', sortOrder: reagent.subComponents.length };
														showAddSubFor = reagent.id;
													}}
												>
													+ Sub
												</button>
											{/if}
											<form method="POST" action="?/removeReagent" use:enhance>
												<input type="hidden" name="reagentId" value={reagent.id} />
												<button
													type="submit"
													class="tron-button"
													style="min-height: 44px; font-size: 0.75rem; color: #ef4444; border-color: #ef4444"
													onclick={(e) => { if (!confirm('Remove this reagent?')) e.preventDefault(); }}
												>
													Remove
												</button>
											</form>
										{/if}
									</div>
								</div>

								<!-- Add Sub-component Form -->
								{#if showAddSubFor === reagent.id}
									<form
										method="POST"
										action="?/addSubComponent"
										use:enhance={() => ({ async onResult({ update }) { showAddSubFor = null; await update(); } })}
										class="mx-3 mb-3 rounded p-3 space-y-3"
										style="background: color-mix(in srgb, var(--color-tron-cyan, #00ffff) 5%, transparent); border: 1px solid var(--color-tron-cyan, #00ffff)"
									>
										<input type="hidden" name="reagentId" value={reagent.id} />
										<h5 class="text-xs font-semibold" style="color: var(--color-tron-cyan, #00ffff)">New Sub-component</h5>
										<div class="grid gap-2 sm:grid-cols-3">
											<div class="sm:col-span-2">
												<label class="mb-1 block text-xs" style="color: var(--color-tron-text-secondary, #9ca3af)">Name *</label>
												<input name="name" type="text" class="tron-input w-full" style="min-height: 44px" bind:value={newSub.name} required />
											</div>
											<div>
												<label class="mb-1 block text-xs" style="color: var(--color-tron-text-secondary, #9ca3af)">Unit Cost ($)</label>
												<input name="unitCost" type="text" class="tron-input w-full" style="min-height: 44px" bind:value={newSub.unitCost} />
											</div>
											<div>
												<label class="mb-1 block text-xs" style="color: var(--color-tron-text-secondary, #9ca3af)">Volume</label>
												<input name="volumeMicroliters" type="number" step="0.001" class="tron-input w-full" style="min-height: 44px" bind:value={newSub.volumeMicroliters} />
											</div>
											<div>
												<label class="mb-1 block text-xs" style="color: var(--color-tron-text-secondary, #9ca3af)">Unit</label>
												<input name="unit" type="text" class="tron-input w-full" style="min-height: 44px" bind:value={newSub.unit} />
											</div>
											<div>
												<label class="mb-1 block text-xs" style="color: var(--color-tron-text-secondary, #9ca3af)">Classification</label>
												<input name="classification" type="text" class="tron-input w-full" style="min-height: 44px" bind:value={newSub.classification} />
											</div>
										</div>
										<div class="flex gap-2">
											<button type="submit" class="tron-button" style="min-height: 44px; background: var(--color-tron-cyan, #00ffff); color: #000; font-weight: 600">Add</button>
											<button type="button" class="tron-button" style="min-height: 44px" onclick={() => (showAddSubFor = null)}>Cancel</button>
										</div>
									</form>
								{/if}

								<!-- Sub-components -->
								{#if expandedReagents.has(reagent.id) && reagent.subComponents.length > 0}
									<div class="mx-3 mb-3 space-y-1">
										{#each reagent.subComponents.slice().sort((a, b) => (a.sortOrder ?? 0) - (b.sortOrder ?? 0)) as sub (sub.id)}
											<div
												class="rounded p-3"
												style="background: color-mix(in srgb, var(--color-tron-surface, #111827) 80%, transparent); border-left: 2px solid var(--color-tron-cyan, #00ffff)"
											>
												{#if editingSubId === sub.id}
													<form
														method="POST"
														action="?/updateReagent"
														use:enhance={() => ({ async onResult({ update }) { editingSubId = null; await update(); } })}
														class="space-y-2"
													>
														<!-- Note: sub-component update uses updateReagent + re-fetch approach via removing + adding is simpler
														     but here we provide an inline form that calls a dedicated endpoint -->
													</form>
													<!-- Simplified: just remove old and add new -->
													<div class="grid gap-2 sm:grid-cols-3">
														<div class="sm:col-span-2">
															<input class="tron-input w-full" style="min-height: 44px" bind:value={editSub.name} placeholder="Name" />
														</div>
														<div>
															<input class="tron-input w-full" style="min-height: 44px" bind:value={editSub.unitCost} placeholder="Unit cost" />
														</div>
														<div>
															<input class="tron-input w-full" style="min-height: 44px; font-size: 0.85rem" bind:value={editSub.volumeMicroliters} placeholder="Volume" type="number" step="0.001" />
														</div>
														<div>
															<input class="tron-input w-full" style="min-height: 44px" bind:value={editSub.unit} placeholder="Unit" />
														</div>
														<div>
															<input class="tron-input w-full" style="min-height: 44px" bind:value={editSub.classification} placeholder="Classification" />
														</div>
													</div>
													<div class="mt-2 flex gap-2">
														<!-- Remove old sub then add new via two sequential submits is complex — skip inline sub editing for now, just show cancel -->
														<button type="button" class="tron-button" style="min-height: 44px" onclick={() => (editingSubId = null)}>Cancel</button>
													</div>
												{:else}
													<div class="flex items-center justify-between">
														<div>
															<span class="font-medium text-sm" style="color: var(--color-tron-text-primary, #f3f4f6)">{sub.name ?? '—'}</span>
															<div class="flex flex-wrap gap-3 mt-1 text-xs" style="color: var(--color-tron-text-secondary, #9ca3af)">
																<span>{sub.volumeMicroliters ?? 0} {sub.unit ?? 'µL'}</span>
																<span>Unit cost: <span style="color: var(--color-tron-green, #39ff14)">${sub.unitCost ?? '0'}</span></span>
																{#if sub.classification}
																	<span style="color: #a78bfa">{sub.classification}</span>
																{/if}
															</div>
														</div>
														{#if data.canWrite}
															<form method="POST" action="?/removeSubComponent" use:enhance>
																<input type="hidden" name="reagentId" value={reagent.id} />
																<input type="hidden" name="subComponentId" value={sub.id} />
																<button
																	type="submit"
																	class="tron-button"
																	style="min-height: 44px; font-size: 0.75rem; color: #ef4444; border-color: #ef4444"
																	onclick={(e) => { if (!confirm('Remove sub-component?')) e.preventDefault(); }}
																>
																	Remove
																</button>
															</form>
														{/if}
													</div>
												{/if}
											</div>
										{/each}
									</div>
								{/if}
							{/if}
						</div>
					{/each}
				</div>
			{/if}
		</div>
	</div>
{/if}

<!-- Edit Modal -->
{#if showEditModal}
	<!-- svelte-ignore a11y_interactive_supports_focus -->
	<div
		class="fixed inset-0 z-50 flex items-center justify-center bg-black/70"
		role="dialog"
		onclick={() => (showEditModal = false)}
		onkeydown={(e) => e.key === 'Escape' && (showEditModal = false)}
	>
		<div
			class="tron-card w-full max-w-md p-6"
			onclick={(e) => e.stopPropagation()}
			role="document"
		>
			<h2 class="mb-4 text-lg font-bold" style="color: var(--color-tron-cyan, #00ffff)">
				Edit Assay
			</h2>
			<form
				method="POST"
				action="?/update"
				use:enhance={() => {
					return async ({ result, update }) => {
						if (result.type === 'success') {
							showEditModal = false;
						}
						await update();
					};
				}}
				class="space-y-4"
			>
				<div>
					<label
						class="mb-1 block text-sm"
						style="color: var(--color-tron-text-secondary, #9ca3af)"
						for="edit-name"
					>
						Name
					</label>
					<input
						id="edit-name"
						name="name"
						type="text"
						class="tron-input w-full"
						style="min-height: 44px"
						bind:value={editName}
						required
					/>
				</div>
				<div>
					<label
						class="mb-1 block text-sm"
						style="color: var(--color-tron-text-secondary, #9ca3af)"
						for="edit-description"
					>
						Description
					</label>
					<textarea
						id="edit-description"
						name="description"
						class="tron-input w-full"
						style="min-height: 88px"
						bind:value={editDescription}
					></textarea>
				</div>
				<div class="flex items-center gap-2">
					<input
						type="checkbox"
						id="edit-active"
						bind:checked={editIsActive}
					/>
					<input type="hidden" name="isActive" value={editIsActive ? 'true' : 'false'} />
					<label
						for="edit-active"
						class="text-sm"
						style="color: var(--color-tron-text-secondary, #9ca3af)"
					>
						Active
					</label>
				</div>
				<div class="flex justify-end gap-2">
					<button
						type="button"
						class="tron-button"
						style="min-height: 44px"
						onclick={() => (showEditModal = false)}
					>
						Cancel
					</button>
					<button
						type="submit"
						class="tron-button"
						style="min-height: 44px; background: var(--color-tron-cyan, #00ffff); color: #000; font-weight: 600"
					>
						Save Changes
					</button>
				</div>
			</form>
		</div>
	</div>
{/if}
