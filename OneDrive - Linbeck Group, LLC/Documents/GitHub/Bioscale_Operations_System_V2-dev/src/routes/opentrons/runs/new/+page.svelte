<script lang="ts">
	import { goto } from '$app/navigation';

	let { data } = $props();

	type RuntimeParam = {
		displayName: string;
		variableName: string;
		description: string;
		type: string;
		default: boolean | number | string;
		min?: number;
		max?: number;
		choices?: { displayName: string; value: string | number }[];
	};

	let step = $state<'robot' | 'params' | 'preview'>('robot');
	let selectedRobotId = $state(data.preselectedRobotId ?? '');
	let paramValues = $state<Record<string, boolean | number | string>>({});
	let creating = $state(false);
	let createError = $state('');

	// Initialize parameter values from defaults
	$effect(() => {
		if (data.analysis?.runTimeParameters) {
			const defaults: Record<string, boolean | number | string> = {};
			for (const p of data.analysis.runTimeParameters as RuntimeParam[]) {
				defaults[p.variableName] = p.default;
			}
			paramValues = defaults;
		}
	});

	// Skip robot step if preselected
	$effect(() => {
		if (data.preselectedRobotId && data.preselectedProtocolId) {
			step = data.analysis?.runTimeParameters?.length ? 'params' : 'preview';
		}
	});

	const parameters = $derived((data.analysis?.runTimeParameters ?? []) as RuntimeParam[]);

	async function handleCreate() {
		if (!selectedRobotId || !data.preselectedProtocolId) return;
		creating = true;
		createError = '';

		try {
			const res = await fetch(`/api/opentrons-lab/robots/${selectedRobotId}/runs`, {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({
					protocolId: data.preselectedProtocolId,
					runTimeParameterValues: Object.keys(paramValues).length > 0 ? paramValues : undefined
				})
			});

			if (!res.ok) {
				const body = await res.json().catch(() => ({ message: 'Failed to create run' }));
				throw new Error(body.message || `HTTP ${res.status}`);
			}

			const run = await res.json();
			// eslint-disable-next-line svelte/no-navigation-without-resolve
			goto(`/opentrons/runs/${run.id}?robotId=${selectedRobotId}`);
		} catch (e) {
			createError = e instanceof Error ? e.message : 'Failed to create run';
		} finally {
			creating = false;
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
		<span class="text-[var(--color-tron-text)]">Start Setup</span>
	</nav>

	<h1 class="text-2xl font-bold text-[var(--color-tron-text)]">
		Run Setup
		{#if data.protocol?.metadata?.protocolName}
			— {data.protocol.metadata.protocolName}
		{/if}
	</h1>

	<!-- Step Indicator -->
	<div class="flex items-center gap-4 text-sm">
		{#each ['robot', 'params', 'preview'] as s, i (s)}
			<div class="flex items-center gap-2">
				<span class="flex h-6 w-6 items-center justify-center rounded-full text-xs {step === s
					? 'bg-[var(--color-tron-cyan)] text-black'
					: 'bg-[var(--color-tron-bg-secondary)] text-[var(--color-tron-text-secondary)]'}"
				>
					{i + 1}
				</span>
				<span class="{step === s ? 'text-[var(--color-tron-text)]' : 'text-[var(--color-tron-text-secondary)]'}">
					{s === 'robot' ? 'Choose Robot' : s === 'params' ? 'Parameters' : 'Review & Run'}
				</span>
			</div>
			{#if i < 2}
				<div class="h-px w-8 bg-[var(--color-tron-border)]"></div>
			{/if}
		{/each}
	</div>

	<!-- Step 1: Choose Robot -->
	{#if step === 'robot'}
		<div class="space-y-3">
			<p class="text-sm text-[var(--color-tron-text-secondary)]">Select a robot to run the protocol on:</p>
			{#each data.robots as robot (robot.robotId)}
				<button
					onclick={() => {
						selectedRobotId = robot.robotId;
						step = parameters.length > 0 ? 'params' : 'preview';
					}}
					disabled={!robot.lastHealthOk}
					class="flex w-full items-center gap-4 rounded-lg border border-[var(--color-tron-border)] p-4 text-left transition-colors hover:border-[var(--color-tron-cyan)] disabled:cursor-not-allowed disabled:opacity-50"
				>
					<div class="h-3 w-3 rounded-full {robot.lastHealthOk ? 'bg-green-400' : 'bg-red-400'}"></div>
					<div class="flex-1">
						<h3 class="text-sm font-medium text-[var(--color-tron-text)]">{robot.name}</h3>
						<span class="text-xs text-[var(--color-tron-text-secondary)]">{robot.ip}</span>
					</div>
					{#if !robot.lastHealthOk}
						<span class="text-xs text-red-400">Offline</span>
					{/if}
				</button>
			{/each}
		</div>

	<!-- Step 2: Parameters -->
	{:else if step === 'params'}
		<div class="space-y-4">
			{#if parameters.length === 0}
				<p class="text-sm text-[var(--color-tron-text-secondary)]">No configurable parameters. Proceeding to review.</p>
			{:else}
				<p class="text-sm text-[var(--color-tron-text-secondary)]">Configure run parameters:</p>
				<div class="space-y-4">
					{#each parameters as param (param.variableName)}
						<div class="rounded-lg border border-[var(--color-tron-border)] p-4">
							<label class="mb-1 block text-sm font-medium text-[var(--color-tron-text)]" for="param-{param.variableName}">
								{param.displayName}
							</label>
							{#if param.description}
								<p class="mb-2 text-xs text-[var(--color-tron-text-secondary)]">{param.description}</p>
							{/if}

							{#if param.type === 'bool'}
								<button
									id="param-{param.variableName}"
									onclick={() => { paramValues[param.variableName] = !paramValues[param.variableName]; }}
									class="relative h-6 w-11 rounded-full transition-colors {paramValues[param.variableName]
										? 'bg-[var(--color-tron-cyan)]'
										: 'bg-[var(--color-tron-border)]'}"
								>
									<span
										class="absolute top-0.5 h-5 w-5 rounded-full bg-white transition-transform {paramValues[param.variableName]
											? 'left-[22px]'
											: 'left-0.5'}"
									></span>
								</button>
								<span class="ml-2 text-sm text-[var(--color-tron-text)]">
									{paramValues[param.variableName] ? 'On' : 'Off'}
								</span>
							{:else if param.choices?.length}
								<select
									id="param-{param.variableName}"
									value={paramValues[param.variableName]}
									onchange={(e) => {
										const val = (e.target as HTMLSelectElement).value;
										paramValues[param.variableName] = typeof param.default === 'number' ? Number(val) : val;
									}}
									class="tron-input w-full px-3 py-2 text-sm"
								>
									{#each param.choices as choice (choice.value)}
										<option value={choice.value}>{choice.displayName}</option>
									{/each}
								</select>
							{:else if param.type === 'int' || param.type === 'float'}
								<input
									id="param-{param.variableName}"
									type="number"
									value={paramValues[param.variableName]}
									min={param.min}
									max={param.max}
									step={param.type === 'float' ? '0.1' : '1'}
									oninput={(e) => {
										const val = (e.target as HTMLInputElement).value;
										paramValues[param.variableName] = param.type === 'int' ? parseInt(val) : parseFloat(val);
									}}
									class="tron-input w-full px-3 py-2 text-sm"
								/>
								{#if param.min !== undefined && param.max !== undefined}
									<p class="mt-1 text-xs text-[var(--color-tron-text-secondary)]">
										Range: {param.min} – {param.max}
									</p>
								{/if}
							{:else}
								<input
									id="param-{param.variableName}"
									type="text"
									value={paramValues[param.variableName]}
									oninput={(e) => { paramValues[param.variableName] = (e.target as HTMLInputElement).value; }}
									class="tron-input w-full px-3 py-2 text-sm"
								/>
							{/if}
						</div>
					{/each}
				</div>
			{/if}

			<div class="flex justify-between">
				<button
					onclick={() => { step = 'robot'; }}
					class="rounded px-4 py-2 text-sm text-[var(--color-tron-text-secondary)] transition-colors hover:text-[var(--color-tron-text)]"
				>
					Back
				</button>
				<button
					onclick={() => { step = 'preview'; }}
					class="rounded bg-[var(--color-tron-cyan)] px-4 py-2 text-sm font-medium text-black"
				>
					Confirm Values
				</button>
			</div>
		</div>

	<!-- Step 3: Review & Run -->
	{:else if step === 'preview'}
		<div class="space-y-4">
			<!-- Summary -->
			<div class="rounded-lg border border-[var(--color-tron-border)] p-4">
				<h3 class="mb-2 text-sm font-medium text-[var(--color-tron-text)]">Run Summary</h3>
				<div class="grid grid-cols-2 gap-2 text-sm">
					<span class="text-[var(--color-tron-text-secondary)]">Protocol</span>
					<span class="text-[var(--color-tron-text)]">
						{data.protocol?.metadata?.protocolName ?? 'Unknown'}
					</span>
					<span class="text-[var(--color-tron-text-secondary)]">Robot</span>
					<span class="text-[var(--color-tron-text)]">
						{data.robots.find((r) => r.robotId === selectedRobotId)?.name ?? selectedRobotId}
					</span>
				</div>
			</div>

			<!-- Parameter values -->
			{#if parameters.length > 0}
				<div class="rounded-lg border border-[var(--color-tron-border)] p-4">
					<h3 class="mb-2 text-sm font-medium text-[var(--color-tron-text)]">Parameters</h3>
					<div class="space-y-1">
						{#each parameters as param (param.variableName)}
							<div class="flex justify-between text-sm">
								<span class="text-[var(--color-tron-text-secondary)]">{param.displayName}</span>
								<span class="text-[var(--color-tron-text)]">
									{#if param.type === 'bool'}
										{paramValues[param.variableName] ? 'On' : 'Off'}
									{:else}
										{paramValues[param.variableName]}
									{/if}
								</span>
							</div>
						{/each}
					</div>
				</div>
			{/if}

			<!-- Commands preview -->
			{#if data.analysis?.commands && data.analysis.commands.length > 0}
				<div class="rounded-lg border border-[var(--color-tron-border)] p-4">
					<h3 class="mb-2 text-sm font-medium text-[var(--color-tron-text)]">
						Run Preview ({data.analysis.commands.length} steps)
					</h3>
					<div class="max-h-48 space-y-1 overflow-y-auto pr-2">
						{#each data.analysis.commands.slice(0, 30) as cmd, i (i)}
							<div class="flex gap-3 text-xs">
								<span class="w-6 flex-shrink-0 text-right text-[var(--color-tron-text-secondary)]">{i + 1}.</span>
								<span class="text-[var(--color-tron-text)]">{cmd.commandType}</span>
							</div>
						{/each}
						{#if data.analysis.commands.length > 30}
							<p class="pt-1 text-center text-xs text-[var(--color-tron-text-secondary)]">
								... and {data.analysis.commands.length - 30} more
							</p>
						{/if}
					</div>
				</div>
			{/if}

			{#if createError}
				<p class="text-sm text-[var(--color-tron-error)]">{createError}</p>
			{/if}

			<div class="flex justify-between">
				<button
					onclick={() => { step = parameters.length > 0 ? 'params' : 'robot'; }}
					class="rounded px-4 py-2 text-sm text-[var(--color-tron-text-secondary)] transition-colors hover:text-[var(--color-tron-text)]"
				>
					Back
				</button>
				<button
					onclick={handleCreate}
					disabled={creating || !selectedRobotId}
					class="rounded bg-[var(--color-tron-cyan)] px-6 py-2 text-sm font-medium text-black transition-opacity disabled:opacity-50"
				>
					{creating ? 'Creating Run...' : 'Start Run'}
				</button>
			</div>
		</div>
	{/if}
</div>
