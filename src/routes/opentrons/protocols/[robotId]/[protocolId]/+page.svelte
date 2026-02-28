<script lang="ts">
	let { data } = $props();

	let activeTab = $state<'parameters' | 'hardware' | 'labware' | 'liquids'>('parameters');
	let deleting = $state(false);

	const protocolName = $derived(
		data.protocol?.metadata?.protocolName ??
			data.dbRecord?.protocolName ??
			'Unknown Protocol'
	);

	const apiLevel = $derived(data.protocol?.metadata?.apiLevel ?? 'Unknown');
	const author = $derived(data.protocol?.metadata?.author ?? '');
	const description = $derived(data.protocol?.metadata?.description ?? '');
	const createdAt = $derived(data.protocol?.createdAt ?? data.dbRecord?.updatedAt ?? '');
	const analysisStatus = $derived(
		data.analysis?.status ?? data.protocol?.analysisStatus ?? data.dbRecord?.analysisStatus ?? 'pending'
	);

	const parameters = $derived(data.analysis?.runTimeParameters ?? []);
	const pipettes = $derived(data.analysis?.pipettes ?? []);
	const labware = $derived(data.analysis?.labware ?? []);
	const liquids = $derived(data.analysis?.liquids ?? []);
	const commands = $derived(data.analysis?.commands ?? []);

	function formatDate(iso: string): string {
		if (!iso) return 'N/A';
		const d = new Date(iso);
		return `${d.getMonth() + 1}/${d.getDate()}/${String(d.getFullYear()).slice(2)} ${d.getHours()}:${String(d.getMinutes()).padStart(2, '0')}`;
	}

	function formatParamDefault(param: typeof parameters[0]): string {
		if (param.type === 'bool') return param.default ? 'On' : 'Off';
		if (param.choices?.length) {
			const match = param.choices.find((c) => c.value === param.default);
			return match?.displayName ?? String(param.default);
		}
		return String(param.default);
	}

	function formatParamRange(param: typeof parameters[0]): string {
		if (param.type === 'bool') return 'On/Off';
		if (param.choices?.length) {
			return param.choices.map((c) => c.displayName).join(', ');
		}
		if (param.min !== undefined && param.max !== undefined) {
			return `${param.min}–${param.max}`;
		}
		return '—';
	}

	// Aggregate labware counts
	const labwareSummary = $derived(() => {
		const counts: Record<string, { name: string; count: number }> = {};
		for (const lw of labware) {
			const name = lw.displayName || lw.loadName;
			const existing = counts[name];
			if (existing) {
				existing.count++;
			} else {
				counts[name] = { name, count: 1 };
			}
		}
		return Object.values(counts);
	});

	async function handleDelete() {
		if (!confirm('Delete this protocol from the robot? This cannot be undone.')) return;
		deleting = true;
		try {
			const res = await fetch(`/api/opentrons-lab/robots/${data.robotId}/protocols/${data.protocolId}`, {
				method: 'DELETE'
			});
			if (!res.ok) {
				const body = await res.json().catch(() => ({ message: 'Delete failed' }));
				throw new Error(body.message || `HTTP ${res.status}`);
			}
			window.location.href = '/opentrons';
		} catch (e) {
			alert(e instanceof Error ? e.message : 'Delete failed');
			deleting = false;
		}
	}
</script>

<div class="space-y-6">
	<!-- Breadcrumb -->
	<nav class="flex items-center gap-2 text-sm text-[var(--color-tron-text-secondary)]">
		<!-- eslint-disable svelte/no-navigation-without-resolve -->
		<a href="/opentrons" class="transition-colors hover:text-[var(--color-tron-cyan)]">Protocols</a>
		<!-- eslint-enable svelte/no-navigation-without-resolve -->
		<span>/</span>
		<span class="text-[var(--color-tron-text)]">{protocolName}</span>
	</nav>

	<!-- Header -->
	<div class="flex items-start justify-between">
		<div>
			<h1 class="text-2xl font-bold text-[var(--color-tron-text)]">{protocolName}</h1>
			<div class="mt-2 flex items-center gap-4 text-sm text-[var(--color-tron-text-secondary)]">
				<span>
					Creation Method:
					<span class="text-[var(--color-tron-text)]">Python API {apiLevel}</span>
				</span>
				<span>
					Last Updated:
					<span class="text-[var(--color-tron-text)]">{formatDate(createdAt)}</span>
				</span>
				<span>
					Analysis:
					<span class="rounded px-1.5 py-0.5 text-xs {analysisStatus === 'completed'
						? 'bg-green-900/40 text-green-400'
						: analysisStatus === 'failed'
							? 'bg-red-900/40 text-red-400'
							: 'bg-yellow-900/40 text-yellow-400'}"
					>
						{analysisStatus}
					</span>
				</span>
			</div>
			{#if author}
				<p class="mt-1 text-sm text-[var(--color-tron-text-secondary)]">
					Author: <span class="text-[var(--color-tron-text)]">{author}</span>
				</p>
			{/if}
			{#if description}
				<p class="mt-2 text-sm text-[var(--color-tron-text-secondary)]">{description}</p>
			{/if}
		</div>
		<div class="flex items-center gap-3">
			<!-- eslint-disable svelte/no-navigation-without-resolve -->
			<a
				href="/opentrons/runs/new?robotId={data.robotId}&protocolId={data.protocolId}"
				class="rounded-md bg-[var(--color-tron-cyan)] px-4 py-2 text-sm font-medium text-black transition-opacity hover:opacity-90 {data.robotOffline ? 'pointer-events-none opacity-50' : ''}"
			>
				Start setup
			</a>
			<!-- eslint-enable svelte/no-navigation-without-resolve -->
			<button
				onclick={handleDelete}
				disabled={deleting || data.robotOffline}
				class="rounded-md border border-[var(--color-tron-border)] px-3 py-2 text-sm text-[var(--color-tron-text-secondary)] transition-colors hover:border-red-500 hover:text-red-400 disabled:opacity-50"
			>
				{deleting ? 'Deleting...' : 'Delete'}
			</button>
		</div>
	</div>

	{#if data.robotOffline}
		<div class="rounded-md border border-yellow-700 bg-yellow-900/20 px-4 py-3 text-sm text-yellow-400">
			Robot is offline. Showing cached data from the database.
		</div>
	{/if}

	<!-- Main content: Deck view + Tabs -->
	<div class="grid grid-cols-1 gap-6 lg:grid-cols-3">
		<!-- Left panel: Deck View -->
		<div class="rounded-lg border border-[var(--color-tron-border)] p-4">
			<h3 class="mb-3 text-sm font-medium text-[var(--color-tron-text-secondary)]">Deck Map</h3>
			<div class="mx-auto grid w-fit grid-cols-3 gap-1.5">
				{#each [10, 11, 12, 7, 8, 9, 4, 5, 6, 1, 2, 3] as slot (slot)}
					{@const occupied = labware.some((lw) => lw.location?.slotName === String(slot))}
					<div
						class="flex h-12 w-14 items-center justify-center rounded border text-xs font-medium {occupied
							? 'border-[var(--color-tron-cyan)] bg-[var(--color-tron-cyan)]/10 text-[var(--color-tron-cyan)]'
							: 'border-[var(--color-tron-border)] text-[var(--color-tron-text-secondary)]'}"
					>
						{slot}
					</div>
				{/each}
			</div>
			<p class="mt-3 text-center text-xs text-[var(--color-tron-text-secondary)]">
				Robot: <span class="text-[var(--color-tron-text)]">{data.robotName}</span>
			</p>
		</div>

		<!-- Right panel: Tabs -->
		<div class="lg:col-span-2">
			<!-- Tab navigation -->
			<div class="flex border-b border-[var(--color-tron-border)]">
				{#each ['parameters', 'hardware', 'labware', 'liquids'] as tab (tab)}
					<button
						onclick={() => { activeTab = tab as typeof activeTab; }}
						class="px-4 py-2.5 text-sm font-medium transition-colors {activeTab === tab
							? 'border-b-2 border-[var(--color-tron-cyan)] text-[var(--color-tron-cyan)]'
							: 'text-[var(--color-tron-text-secondary)] hover:text-[var(--color-tron-text)]'}"
					>
						{tab.charAt(0).toUpperCase() + tab.slice(1)}
						{#if tab === 'parameters' && parameters.length > 0}
							<span class="ml-1 text-xs opacity-60">({parameters.length})</span>
						{/if}
					</button>
				{/each}
			</div>

			<!-- Tab content -->
			<div class="py-4">
				{#if activeTab === 'parameters'}
					{#if parameters.length === 0}
						<p class="text-sm text-[var(--color-tron-text-secondary)]">
							No configurable parameters for this protocol.
						</p>
					{:else}
						<div class="mb-3 rounded-md border border-blue-800/50 bg-blue-900/20 px-3 py-2 text-xs text-blue-400">
							Listed values are view-only. Start setup to customize values.
						</div>
						<table class="w-full text-sm">
							<thead>
								<tr class="border-b border-[var(--color-tron-border)] text-left text-xs text-[var(--color-tron-text-secondary)]">
									<th class="pb-2 pr-4 font-medium">Name</th>
									<th class="pb-2 pr-4 font-medium">Default Value</th>
									<th class="pb-2 font-medium">Range</th>
								</tr>
							</thead>
							<tbody>
								{#each parameters as param (param.variableName)}
									<tr class="border-b border-[var(--color-tron-border)]/50">
										<td class="py-2.5 pr-4">
											<span class="text-[var(--color-tron-text)]">{param.displayName}</span>
											{#if param.description}
												<span
													class="ml-1 inline-flex h-4 w-4 cursor-help items-center justify-center rounded-full border border-[var(--color-tron-border)] text-[10px] text-[var(--color-tron-text-secondary)]"
													title={param.description}
												>
													i
												</span>
											{/if}
										</td>
										<td class="py-2.5 pr-4 text-[var(--color-tron-text)]">
											{formatParamDefault(param)}
										</td>
										<td class="py-2.5 text-[var(--color-tron-text-secondary)]">
											{formatParamRange(param)}
										</td>
									</tr>
								{/each}
							</tbody>
						</table>
					{/if}

				{:else if activeTab === 'hardware'}
					<table class="w-full text-sm">
						<thead>
							<tr class="border-b border-[var(--color-tron-border)] text-left text-xs text-[var(--color-tron-text-secondary)]">
								<th class="pb-2 pr-4 font-medium">Location</th>
								<th class="pb-2 font-medium">Hardware</th>
							</tr>
						</thead>
						<tbody>
							<tr class="border-b border-[var(--color-tron-border)]/50">
								<td class="py-2.5 pr-4 text-[var(--color-tron-text-secondary)]">Robot</td>
								<td class="py-2.5 text-[var(--color-tron-text)]">OT-2</td>
							</tr>
							{#each pipettes as pip (pip.mount)}
								<tr class="border-b border-[var(--color-tron-border)]/50">
									<td class="py-2.5 pr-4 text-[var(--color-tron-text-secondary)]">
										{pip.mount.charAt(0).toUpperCase() + pip.mount.slice(1)} Mount
									</td>
									<td class="py-2.5 text-[var(--color-tron-text)]">{pip.pipetteName}</td>
								</tr>
							{/each}
							{#if pipettes.length === 0}
								<tr class="border-b border-[var(--color-tron-border)]/50">
									<td class="py-2.5 pr-4 text-[var(--color-tron-text-secondary)]">Left Mount</td>
									<td class="py-2.5 text-[var(--color-tron-text-secondary)]">Empty</td>
								</tr>
								<tr class="border-b border-[var(--color-tron-border)]/50">
									<td class="py-2.5 pr-4 text-[var(--color-tron-text-secondary)]">Right Mount</td>
									<td class="py-2.5 text-[var(--color-tron-text-secondary)]">Empty</td>
								</tr>
							{/if}
						</tbody>
					</table>

				{:else if activeTab === 'labware'}
					{#if labwareSummary().length === 0}
						<p class="text-sm text-[var(--color-tron-text-secondary)]">
							No labware information available.
						</p>
					{:else}
						<table class="w-full text-sm">
							<thead>
								<tr class="border-b border-[var(--color-tron-border)] text-left text-xs text-[var(--color-tron-text-secondary)]">
									<th class="pb-2 pr-4 font-medium">Labware Name</th>
									<th class="pb-2 font-medium">Quantity</th>
								</tr>
							</thead>
							<tbody>
								{#each labwareSummary() as item (item.name)}
									<tr class="border-b border-[var(--color-tron-border)]/50">
										<td class="py-2.5 pr-4 text-[var(--color-tron-text)]">{item.name}</td>
										<td class="py-2.5 text-[var(--color-tron-text)]">{item.count}</td>
									</tr>
								{/each}
							</tbody>
						</table>
					{/if}

				{:else if activeTab === 'liquids'}
					{#if liquids.length === 0}
						<p class="text-sm text-[var(--color-tron-text-secondary)]">
							No liquid information available.
						</p>
					{:else}
						<table class="w-full text-sm">
							<thead>
								<tr class="border-b border-[var(--color-tron-border)] text-left text-xs text-[var(--color-tron-text-secondary)]">
									<th class="pb-2 pr-4 font-medium">Liquid</th>
									<th class="pb-2 font-medium">Description</th>
								</tr>
							</thead>
							<tbody>
								{#each liquids as liquid (liquid.displayName)}
									<tr class="border-b border-[var(--color-tron-border)]/50">
										<td class="py-2.5 pr-4">
											<span class="flex items-center gap-2">
												<span
													class="h-3 w-3 rounded-full"
													style="background-color: {liquid.displayColor || '#6b7280'}"
												></span>
												<span class="text-[var(--color-tron-text)]">{liquid.displayName}</span>
											</span>
										</td>
										<td class="py-2.5 text-[var(--color-tron-text-secondary)]">
											{liquid.description || '—'}
										</td>
									</tr>
								{/each}
							</tbody>
						</table>
					{/if}
				{/if}
			</div>
		</div>
	</div>

	<!-- Run Preview (commands summary) -->
	{#if commands.length > 0}
		<div class="rounded-lg border border-[var(--color-tron-border)] p-4">
			<h3 class="mb-3 text-sm font-medium text-[var(--color-tron-text)]">
				Protocol Steps Preview
				<span class="ml-1 text-xs text-[var(--color-tron-text-secondary)]">
					({commands.length} commands)
				</span>
			</h3>
			<div class="max-h-64 space-y-1 overflow-y-auto pr-2">
				{#each commands.slice(0, 50) as cmd, i (i)}
					<div class="flex gap-3 text-xs">
						<span class="w-8 flex-shrink-0 text-right text-[var(--color-tron-text-secondary)]">
							{i + 1}.
						</span>
						<span class="text-[var(--color-tron-text)]">
							{cmd.commandType}
							{#if cmd.params?.loadName}
								— {cmd.params.loadName}
							{:else if cmd.params?.pipetteId}
								— pipette {cmd.params.pipetteId}
							{/if}
						</span>
					</div>
				{/each}
				{#if commands.length > 50}
					<p class="pt-2 text-center text-xs text-[var(--color-tron-text-secondary)]">
						... and {commands.length - 50} more commands
					</p>
				{/if}
			</div>
		</div>
	{/if}
</div>
