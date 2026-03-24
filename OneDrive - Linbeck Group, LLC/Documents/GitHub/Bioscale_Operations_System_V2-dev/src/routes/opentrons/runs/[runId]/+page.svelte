<script lang="ts">
	import { page } from '$app/stores';

	let { data } = $props();

	let activeTab = $state<'setup' | 'parameters' | 'commands'>('setup');
	let runStatus = $state(data.run.status);
	let runErrors = $state(data.run.errors);
	let elapsedMs = $state(0);
	let commandData = $state<{ commandType: string; status: string; id: string }[]>([]);
	let totalCommands = $state(0);
	let completedCommands = $state(0);
	let polling = $state(false);

	const isActive = $derived(
		runStatus === 'running' || runStatus === 'paused' || runStatus === 'idle'
	);

	const isTerminal = $derived(
		runStatus === 'succeeded' || runStatus === 'failed' || runStatus === 'stopped'
	);

	function statusBadgeClass(status: string): string {
		switch (status) {
			case 'idle': return 'bg-gray-800 text-gray-300';
			case 'running': return 'bg-blue-900/60 text-blue-300';
			case 'paused': return 'bg-yellow-900/60 text-yellow-300';
			case 'finishing': return 'bg-blue-900/60 text-blue-300';
			case 'succeeded': return 'bg-green-900/60 text-green-300';
			case 'failed': return 'bg-red-900/60 text-red-300';
			case 'stopped': return 'bg-gray-800 text-gray-400';
			case 'stop-requested': return 'bg-yellow-900/60 text-yellow-300';
			default: return 'bg-gray-800 text-gray-300';
		}
	}

	function formatElapsed(ms: number): string {
		const totalSec = Math.floor(ms / 1000);
		const h = Math.floor(totalSec / 3600);
		const m = Math.floor((totalSec % 3600) / 60);
		const s = totalSec % 60;
		if (h > 0) return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
		return `${m}:${String(s).padStart(2, '0')}`;
	}

	function formatDate(iso: string | null): string {
		if (!iso) return '—';
		const d = new Date(iso);
		return `${d.getMonth() + 1}/${d.getDate()}/${String(d.getFullYear()).slice(2)} ${d.getHours()}:${String(d.getMinutes()).padStart(2, '0')}`;
	}

	// Poll run state while active
	$effect(() => {
		if (!isActive || isTerminal) return;
		polling = true;

		const interval = setInterval(async () => {
			try {
				const res = await fetch(
					`/api/opentrons-lab/robots/${data.robotId}/runs/${data.run.id}/state`
				);
				if (res.ok) {
					const state = await res.json();
					runStatus = state.status ?? state.data?.status ?? runStatus;
					if (state.data?.errors) runErrors = state.data.errors;
				}
			} catch {
				// polling failures are silent
			}
		}, 3000);

		return () => {
			clearInterval(interval);
			polling = false;
		};
	});

	// Elapsed time counter while running
	$effect(() => {
		if (runStatus !== 'running') return;
		const start = data.run.startedAt ? new Date(data.run.startedAt).getTime() : Date.now();

		const timer = setInterval(() => {
			elapsedMs = Date.now() - start;
		}, 1000);

		return () => clearInterval(timer);
	});

	// Fetch commands on mount
	$effect(() => {
		fetchCommands();
	});

	async function fetchCommands() {
		try {
			const robotId = $page.url.searchParams.get('robotId');
			if (!robotId) return;
			const res = await fetch(
				`/api/opentrons-lab/robots/${robotId}/runs/${data.run.id}`
			);
			if (res.ok) {
				const full = await res.json();
				if (full.commands) {
					commandData = full.commands;
					totalCommands = full.commands.length;
					completedCommands = full.commands.filter(
						(c: { status: string }) => c.status === 'succeeded'
					).length;
				}
			}
		} catch {
			// silent
		}
	}

	async function handleAction(action: 'play' | 'pause' | 'stop') {
		try {
			const res = await fetch(
				`/api/opentrons-lab/robots/${data.robotId}/runs/${data.run.id}/actions`,
				{
					method: 'POST',
					headers: { 'Content-Type': 'application/json' },
					body: JSON.stringify({ action })
				}
			);
			if (!res.ok) {
				const body = await res.json().catch(() => ({ message: 'Action failed' }));
				alert(body.message || `Failed: HTTP ${res.status}`);
			} else {
				// Immediately reflect expected status
				if (action === 'play') runStatus = 'running';
				else if (action === 'pause') runStatus = 'paused';
				else if (action === 'stop') runStatus = 'stop-requested';
			}
		} catch (e) {
			alert(e instanceof Error ? e.message : 'Action failed');
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
		<span class="text-[var(--color-tron-text)]">Run {data.run.id.slice(0, 8)}</span>
	</nav>

	<!-- Header with status -->
	<div class="flex items-start justify-between">
		<div>
			<div class="flex items-center gap-3">
				<h1 class="text-2xl font-bold text-[var(--color-tron-text)]">Run Monitor</h1>
				<span class="rounded-full px-3 py-0.5 text-sm font-medium {statusBadgeClass(runStatus)}">
					{runStatus}
				</span>
				{#if polling}
					<span class="h-2 w-2 animate-pulse rounded-full bg-[var(--color-tron-cyan)]" title="Live polling"></span>
				{/if}
			</div>
			<div class="mt-2 flex items-center gap-4 text-sm text-[var(--color-tron-text-secondary)]">
				<span>Robot: <span class="text-[var(--color-tron-text)]">{data.robotName}</span></span>
				<span>Started: <span class="text-[var(--color-tron-text)]">{formatDate(data.run.startedAt)}</span></span>
				{#if runStatus === 'running'}
					<span>Elapsed: <span class="text-[var(--color-tron-text)]">{formatElapsed(elapsedMs)}</span></span>
				{/if}
				{#if data.run.completedAt}
					<span>Completed: <span class="text-[var(--color-tron-text)]">{formatDate(data.run.completedAt)}</span></span>
				{/if}
			</div>
		</div>

		<!-- Run Controls -->
		<div class="flex items-center gap-2">
			{#if runStatus === 'idle' || runStatus === 'paused'}
				<button
					onclick={() => handleAction('play')}
					class="rounded bg-green-600 px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-green-500"
				>
					{runStatus === 'idle' ? 'Start Run' : 'Resume'}
				</button>
			{/if}
			{#if runStatus === 'running'}
				<button
					onclick={() => handleAction('pause')}
					class="rounded bg-yellow-600 px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-yellow-500"
				>
					Pause
				</button>
			{/if}
			{#if isActive}
				<button
					onclick={() => {
						if (confirm('Stop this run? This cannot be undone.')) handleAction('stop');
					}}
					class="rounded border border-red-600 px-4 py-2 text-sm font-medium text-red-400 transition-colors hover:bg-red-600 hover:text-white"
				>
					Stop
				</button>
			{/if}
			{#if isTerminal}
				<!-- eslint-disable svelte/no-navigation-without-resolve -->
				<a
					href="/opentrons/runs/new?robotId={data.robotId}&protocolId={data.run.protocolId}"
					class="rounded bg-[var(--color-tron-cyan)] px-4 py-2 text-sm font-medium text-black transition-opacity hover:opacity-90"
				>
					Run Again
				</a>
				<!-- eslint-enable svelte/no-navigation-without-resolve -->
			{/if}
		</div>
	</div>

	<!-- Progress bar -->
	{#if totalCommands > 0}
		<div>
			<div class="mb-1 flex items-center justify-between text-xs text-[var(--color-tron-text-secondary)]">
				<span>Progress</span>
				<span>{completedCommands} / {totalCommands} steps</span>
			</div>
			<div class="h-2 overflow-hidden rounded-full bg-[var(--color-tron-border)]">
				<div
					class="h-full rounded-full bg-[var(--color-tron-cyan)] transition-all"
					style="width: {totalCommands > 0 ? (completedCommands / totalCommands) * 100 : 0}%"
				></div>
			</div>
		</div>
	{/if}

	<!-- Errors -->
	{#if runErrors.length > 0}
		<div class="rounded-lg border border-red-700 bg-red-900/20 p-4">
			<h3 class="mb-2 text-sm font-medium text-red-400">Errors</h3>
			<div class="space-y-2">
				{#each runErrors as err, i (i)}
					<div class="text-sm">
						<span class="font-medium text-red-300">{err.errorType}</span>
						<p class="text-red-400/80">{err.detail}</p>
					</div>
				{/each}
			</div>
		</div>
	{/if}

	<!-- Tabs -->
	<div class="flex border-b border-[var(--color-tron-border)]">
		{#each ['setup', 'parameters', 'commands'] as tab (tab)}
			<button
				onclick={() => { activeTab = tab as typeof activeTab; }}
				class="px-4 py-2.5 text-sm font-medium transition-colors {activeTab === tab
					? 'border-b-2 border-[var(--color-tron-cyan)] text-[var(--color-tron-cyan)]'
					: 'text-[var(--color-tron-text-secondary)] hover:text-[var(--color-tron-text)]'}"
			>
				{tab.charAt(0).toUpperCase() + tab.slice(1)}
			</button>
		{/each}
	</div>

	<!-- Tab content -->
	<div>
		{#if activeTab === 'setup'}
			<div class="space-y-4">
				<!-- Pipettes -->
				<div class="rounded-lg border border-[var(--color-tron-border)] p-4">
					<h3 class="mb-2 text-sm font-medium text-[var(--color-tron-text)]">Pipettes</h3>
					{#if data.run.pipettes.length === 0}
						<p class="text-sm text-[var(--color-tron-text-secondary)]">No pipettes assigned.</p>
					{:else}
						{#each data.run.pipettes as pip (pip.mount)}
							<div class="flex items-center justify-between py-1.5 text-sm">
								<span class="text-[var(--color-tron-text)]">{pip.pipetteName}</span>
								<span class="text-[var(--color-tron-text-secondary)]">{pip.mount} mount</span>
							</div>
						{/each}
					{/if}
				</div>

				<!-- Labware -->
				<div class="rounded-lg border border-[var(--color-tron-border)] p-4">
					<h3 class="mb-2 text-sm font-medium text-[var(--color-tron-text)]">Labware</h3>
					{#if data.run.labware.length === 0}
						<p class="text-sm text-[var(--color-tron-text-secondary)]">No labware.</p>
					{:else}
						{#each data.run.labware as lw, i (i)}
							<div class="flex items-center justify-between py-1.5 text-sm">
								<span class="text-[var(--color-tron-text)]">{lw.displayName || lw.loadName}</span>
								<span class="text-[var(--color-tron-text-secondary)]">{lw.loadName}</span>
							</div>
						{/each}
					{/if}
				</div>

				<!-- Modules -->
				{#if data.run.modules.length > 0}
					<div class="rounded-lg border border-[var(--color-tron-border)] p-4">
						<h3 class="mb-2 text-sm font-medium text-[var(--color-tron-text)]">Modules</h3>
						{#each data.run.modules as mod (mod.serialNumber)}
							<div class="flex items-center justify-between py-1.5 text-sm">
								<span class="text-[var(--color-tron-text)]">{mod.model}</span>
								<span class="text-[var(--color-tron-text-secondary)]">S/N: {mod.serialNumber}</span>
							</div>
						{/each}
					</div>
				{/if}
			</div>

		{:else if activeTab === 'parameters'}
			{#if data.run.runTimeParameters && data.run.runTimeParameters.length > 0}
				<table class="w-full text-sm">
					<thead>
						<tr class="border-b border-[var(--color-tron-border)] text-left text-xs text-[var(--color-tron-text-secondary)]">
							<th class="pb-2 pr-4 font-medium">Parameter</th>
							<th class="pb-2 font-medium">Value</th>
						</tr>
					</thead>
					<tbody>
						{#each data.run.runTimeParameters as param (param.displayName)}
							<tr class="border-b border-[var(--color-tron-border)]/50">
								<td class="py-2.5 pr-4 text-[var(--color-tron-text)]">{param.displayName}</td>
								<td class="py-2.5 text-[var(--color-tron-text)]">
									{#if param.type === 'bool'}
										{param.value ? 'On' : 'Off'}
									{:else}
										{param.value ?? param.default}
									{/if}
								</td>
							</tr>
						{/each}
					</tbody>
				</table>
			{:else}
				<p class="text-sm text-[var(--color-tron-text-secondary)]">No parameters for this run.</p>
			{/if}

		{:else if activeTab === 'commands'}
			{#if commandData.length === 0}
				<p class="text-sm text-[var(--color-tron-text-secondary)]">No command data available.</p>
			{:else}
				<div class="max-h-96 space-y-1 overflow-y-auto pr-2">
					{#each commandData as cmd, i (cmd.id)}
						<div class="flex items-center gap-3 rounded px-2 py-1 text-xs {cmd.status === 'running' ? 'bg-blue-900/20' : ''}">
							<span class="w-8 flex-shrink-0 text-right text-[var(--color-tron-text-secondary)]">
								{i + 1}.
							</span>
							<span class="flex-1 text-[var(--color-tron-text)]">{cmd.commandType}</span>
							<span class="text-xs {cmd.status === 'succeeded'
								? 'text-green-400'
								: cmd.status === 'running'
									? 'text-blue-400'
									: cmd.status === 'failed'
										? 'text-red-400'
										: 'text-[var(--color-tron-text-secondary)]'}">
								{cmd.status}
							</span>
						</div>
					{/each}
				</div>
			{/if}
		{/if}
	</div>
</div>
