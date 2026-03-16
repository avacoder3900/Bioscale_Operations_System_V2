<script lang="ts">
	let { data } = $props();

	let lightsOn = $state(false);
	let togglingLights = $state(false);

	function formatDate(iso: string | null): string {
		if (!iso) return 'N/A';
		const d = new Date(iso);
		return `${d.getMonth() + 1}/${d.getDate()}/${String(d.getFullYear()).slice(2)} ${d.getHours()}:${String(d.getMinutes()).padStart(2, '0')}`;
	}

	function statusColor(status: string): string {
		switch (status) {
			case 'succeeded': return 'text-green-400';
			case 'failed': return 'text-red-400';
			case 'running': return 'text-blue-400';
			case 'paused': return 'text-yellow-400';
			case 'stopped': return 'text-gray-400';
			default: return 'text-[var(--color-tron-text-secondary)]';
		}
	}

	async function handleIdentify() {
		try {
			await fetch(`/api/opentrons-lab/robots/${data.robot.robotId}/identify`, { method: 'POST' });
		} catch {
			// silently fail
		}
	}

	async function handleHome() {
		if (!confirm('Home all axes? Make sure the deck is clear.')) return;
		try {
			await fetch(`/api/opentrons-lab/robots/${data.robot.robotId}/home`, { method: 'POST' });
		} catch (e) {
			alert(e instanceof Error ? e.message : 'Home failed');
		}
	}

	async function toggleLights() {
		togglingLights = true;
		try {
			const res = await fetch(`/api/opentrons-lab/robots/${data.robot.robotId}/lights`, {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ on: !lightsOn })
			});
			if (res.ok) lightsOn = !lightsOn;
		} catch {
			// silently fail
		} finally {
			togglingLights = false;
		}
	}

	// Fetch initial lights state
	$effect(() => {
		if (data.robotOffline) return;
		fetch(`/api/opentrons-lab/robots/${data.robot.robotId}/lights`)
			.then((r) => r.json())
			.then((d) => { lightsOn = d.on ?? false; })
			.catch(() => {});
	});
</script>

<div class="space-y-6">
	<!-- Breadcrumb -->
	<nav class="flex items-center gap-2 text-sm text-[var(--color-tron-text-secondary)]">
		<!-- eslint-disable svelte/no-navigation-without-resolve -->
		<a href="/opentrons/devices" class="transition-colors hover:text-[var(--color-tron-cyan)]">Devices</a>
		<!-- eslint-enable svelte/no-navigation-without-resolve -->
		<span>/</span>
		<span class="text-[var(--color-tron-text)]">{data.robot.name}</span>
	</nav>

	{#if data.robotOffline}
		<div class="rounded-md border border-yellow-700 bg-yellow-900/20 px-4 py-3 text-sm text-yellow-400">
			Robot is offline. Showing last known data from the database.
		</div>
	{/if}

	<!-- Robot Overview Card -->
	<div class="rounded-lg border border-[var(--color-tron-border)] p-5">
		<div class="flex items-start justify-between">
			<div>
				<div class="flex items-center gap-3">
					<h1 class="text-xl font-bold text-[var(--color-tron-text)]">{data.robot.name}</h1>
					<span class="h-2.5 w-2.5 rounded-full {data.robot.lastHealthOk ? 'bg-green-400' : 'bg-red-400'}"></span>
				</div>
				<div class="mt-2 grid grid-cols-2 gap-x-8 gap-y-1 text-sm">
					<span class="text-[var(--color-tron-text-secondary)]">Model</span>
					<span class="text-[var(--color-tron-text)]">{data.robot.robotModel}</span>

					<span class="text-[var(--color-tron-text-secondary)]">Serial</span>
					<span class="text-[var(--color-tron-text)]">{data.robot.robotSerial ?? 'N/A'}</span>

					<span class="text-[var(--color-tron-text-secondary)]">IP</span>
					<span class="text-[var(--color-tron-text)]">{data.robot.ip}:{data.robot.port}</span>

					<span class="text-[var(--color-tron-text-secondary)]">Firmware</span>
					<span class="text-[var(--color-tron-text)]">{data.robot.firmwareVersion ?? 'N/A'}</span>

					<span class="text-[var(--color-tron-text-secondary)]">API Version</span>
					<span class="text-[var(--color-tron-text)]">{data.robot.apiVersion ?? 'N/A'}</span>

					{#if data.robot.robotSide}
						<span class="text-[var(--color-tron-text-secondary)]">Side</span>
						<span class="text-[var(--color-tron-text)]">{data.robot.robotSide}</span>
					{/if}

					<span class="text-[var(--color-tron-text-secondary)]">Source</span>
					<span class="text-[var(--color-tron-text)]">{data.robot.source}</span>
				</div>
			</div>

			<!-- Quick actions -->
			<div class="flex items-center gap-2">
				<button
					onclick={handleIdentify}
					disabled={data.robotOffline}
					class="rounded border border-[var(--color-tron-border)] px-3 py-1.5 text-xs text-[var(--color-tron-text-secondary)] transition-colors hover:border-[var(--color-tron-cyan)] hover:text-[var(--color-tron-cyan)] disabled:opacity-50"
					title="Blink lights to identify robot"
				>
					Identify
				</button>
				<button
					onclick={handleHome}
					disabled={data.robotOffline}
					class="rounded border border-[var(--color-tron-border)] px-3 py-1.5 text-xs text-[var(--color-tron-text-secondary)] transition-colors hover:border-[var(--color-tron-cyan)] hover:text-[var(--color-tron-cyan)] disabled:opacity-50"
					title="Home all axes"
				>
					Home
				</button>
				<button
					onclick={toggleLights}
					disabled={data.robotOffline || togglingLights}
					class="rounded border border-[var(--color-tron-border)] px-3 py-1.5 text-xs transition-colors disabled:opacity-50 {lightsOn
						? 'border-yellow-600 text-yellow-400'
						: 'text-[var(--color-tron-text-secondary)] hover:border-[var(--color-tron-cyan)] hover:text-[var(--color-tron-cyan)]'}"
					title="Toggle rail lights"
				>
					{lightsOn ? 'Lights On' : 'Lights Off'}
				</button>
			</div>
		</div>
	</div>

	<!-- Instruments & Modules -->
	{#if data.info}
		<div class="grid grid-cols-1 gap-6 md:grid-cols-2">
			<!-- Pipettes -->
			<div class="rounded-lg border border-[var(--color-tron-border)] p-4">
				<h3 class="mb-3 text-sm font-medium text-[var(--color-tron-text)]">Instruments</h3>
				{#if data.info.pipettes.length === 0}
					<p class="text-sm text-[var(--color-tron-text-secondary)]">No pipettes detected.</p>
				{:else}
					<div class="space-y-3">
						{#each data.info.pipettes as pip (pip.mount)}
							<div class="rounded border border-[var(--color-tron-border)]/50 p-3">
								<div class="flex items-center justify-between">
									<span class="text-sm font-medium text-[var(--color-tron-text)]">{pip.name}</span>
									<span class="rounded bg-[var(--color-tron-bg-secondary)] px-1.5 py-0.5 text-xs text-[var(--color-tron-text-secondary)]">
										{pip.mount} mount
									</span>
								</div>
								<div class="mt-1 text-xs text-[var(--color-tron-text-secondary)]">
									Model: {pip.model} | Tip: {pip.has_tip ? 'Attached' : 'None'}
								</div>
							</div>
						{/each}
					</div>
				{/if}
			</div>

			<!-- Modules -->
			<div class="rounded-lg border border-[var(--color-tron-border)] p-4">
				<h3 class="mb-3 text-sm font-medium text-[var(--color-tron-text)]">Modules</h3>
				{#if data.info.modules.length === 0}
					<p class="text-sm text-[var(--color-tron-text-secondary)]">No modules detected.</p>
				{:else}
					<div class="space-y-3">
						{#each data.info.modules as mod (mod.serial)}
							<div class="rounded border border-[var(--color-tron-border)]/50 p-3">
								<div class="flex items-center justify-between">
									<span class="text-sm font-medium text-[var(--color-tron-text)]">{mod.moduleType}</span>
									<span class="rounded bg-[var(--color-tron-bg-secondary)] px-1.5 py-0.5 text-xs text-[var(--color-tron-text-secondary)]">
										{mod.moduleModel}
									</span>
								</div>
								<div class="mt-1 text-xs text-[var(--color-tron-text-secondary)]">
									S/N: {mod.serial} | FW: {mod.firmwareVersion}
								</div>
							</div>
						{/each}
					</div>
				{/if}
			</div>
		</div>
	{/if}

	<!-- Calibration Dashboard -->
	{#if data.calibration}
		<div class="rounded-lg border border-[var(--color-tron-border)] p-4">
			<h3 class="mb-4 text-sm font-medium text-[var(--color-tron-text)]">Calibration</h3>
			<div class="grid grid-cols-1 gap-4 md:grid-cols-3">
				<!-- Deck Calibration -->
				<div class="rounded border border-[var(--color-tron-border)]/50 p-3">
					<h4 class="text-xs font-medium text-[var(--color-tron-text-secondary)]">Deck Calibration</h4>
					<p class="mt-1 text-sm text-[var(--color-tron-text)]">
						{data.calibration.status?.deckCalibration?.status ?? 'Unknown'}
					</p>
				</div>

				<!-- Pipette Offsets -->
				<div class="rounded border border-[var(--color-tron-border)]/50 p-3">
					<h4 class="text-xs font-medium text-[var(--color-tron-text-secondary)]">Pipette Offsets</h4>
					{#if data.calibration.pipetteOffsets.length === 0}
						<p class="mt-1 text-sm text-[var(--color-tron-text-secondary)]">None</p>
					{:else}
						{#each data.calibration.pipetteOffsets as po (po.mount)}
							<div class="mt-1 text-xs">
								<span class="text-[var(--color-tron-text)]">{po.mount} mount</span>
								<span class="text-[var(--color-tron-text-secondary)]">
									[{po.offset.map((v) => v.toFixed(2)).join(', ')}]
								</span>
							</div>
						{/each}
					{/if}
				</div>

				<!-- Tip Lengths -->
				<div class="rounded border border-[var(--color-tron-border)]/50 p-3">
					<h4 class="text-xs font-medium text-[var(--color-tron-text-secondary)]">Tip Length Calibrations</h4>
					{#if data.calibration.tipLengths.length === 0}
						<p class="mt-1 text-sm text-[var(--color-tron-text-secondary)]">None</p>
					{:else}
						{#each data.calibration.tipLengths as tl (tl.tiprack)}
							<div class="mt-1 text-xs">
								<span class="text-[var(--color-tron-text)]">{tl.tipLength.toFixed(2)} mm</span>
								<span class="text-[var(--color-tron-text-secondary)]"> — {tl.tiprack}</span>
							</div>
						{/each}
					{/if}
				</div>
			</div>

			<!-- Labware Calibrations table -->
			{#if data.calibration.labware.length > 0}
				<div class="mt-4">
					<h4 class="mb-2 text-xs font-medium text-[var(--color-tron-text-secondary)]">
						Labware Calibrations ({data.calibration.labware.length})
					</h4>
					<div class="max-h-48 overflow-y-auto">
						<table class="w-full text-xs">
							<thead>
								<tr class="border-b border-[var(--color-tron-border)] text-left text-[var(--color-tron-text-secondary)]">
									<th class="pb-1.5 pr-3 font-medium">Labware</th>
									<th class="pb-1.5 pr-3 font-medium">Slot</th>
									<th class="pb-1.5 font-medium">Offset</th>
								</tr>
							</thead>
							<tbody>
								{#each data.calibration.labware as lw, i (i)}
									<tr class="border-b border-[var(--color-tron-border)]/30">
										<td class="py-1.5 pr-3 text-[var(--color-tron-text)]">{lw.labware.loadName}</td>
										<td class="py-1.5 pr-3 text-[var(--color-tron-text-secondary)]">{lw.labware.parent || '—'}</td>
										<td class="py-1.5 text-[var(--color-tron-text-secondary)]">[{lw.offset.map((v) => v.toFixed(2)).join(', ')}]</td>
									</tr>
								{/each}
							</tbody>
						</table>
					</div>
				</div>
			{/if}
		</div>
	{/if}

	<!-- Recent Runs -->
	{#if data.recentRuns && data.recentRuns.length > 0}
		<div class="rounded-lg border border-[var(--color-tron-border)] p-4">
			<h3 class="mb-3 text-sm font-medium text-[var(--color-tron-text)]">Recent Runs</h3>
			<table class="w-full text-sm">
				<thead>
					<tr class="border-b border-[var(--color-tron-border)] text-left text-xs text-[var(--color-tron-text-secondary)]">
						<th class="pb-2 pr-4 font-medium">Run ID</th>
						<th class="pb-2 pr-4 font-medium">Status</th>
						<th class="pb-2 pr-4 font-medium">Created</th>
						<th class="pb-2 font-medium">Completed</th>
					</tr>
				</thead>
				<tbody>
					{#each data.recentRuns as run (run.id)}
						<tr class="border-b border-[var(--color-tron-border)]/50">
							<td class="py-2 pr-4">
								<!-- eslint-disable svelte/no-navigation-without-resolve -->
								<a
									href="/opentrons/runs/{run.id}?robotId={data.robot.robotId}"
									class="text-[var(--color-tron-cyan)] hover:underline"
								>
									{run.id.slice(0, 8)}...
								</a>
								<!-- eslint-enable svelte/no-navigation-without-resolve -->
							</td>
							<td class="py-2 pr-4 {statusColor(run.status)}">{run.status}</td>
							<td class="py-2 pr-4 text-[var(--color-tron-text-secondary)]">{formatDate(run.createdAt)}</td>
							<td class="py-2 text-[var(--color-tron-text-secondary)]">{formatDate(run.completedAt)}</td>
						</tr>
					{/each}
				</tbody>
			</table>
		</div>
	{/if}
</div>
