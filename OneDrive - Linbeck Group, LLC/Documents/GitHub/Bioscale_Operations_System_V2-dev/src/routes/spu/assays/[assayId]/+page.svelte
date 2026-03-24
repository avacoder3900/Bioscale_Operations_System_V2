<script lang="ts">
	import { enhance } from '$app/forms';
	import { invalidateAll } from '$app/navigation';
	import VersionHistory from '$lib/components/assay/VersionHistory.svelte';

	let { data, form } = $props();

	let activeTab = $state<'overview' | 'bcode' | 'cartridges' | 'results' | 'versions'>('overview');
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
