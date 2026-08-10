<script lang="ts">
	let { data, form } = $props();

	const run = $derived(data.run);

	// Phase → deck-token owner (mirrors DECK_TOKEN server-side).
	const tokenByPhase: Record<string, 'none' | 'arm' | 'ot2'> = {
		created: 'none',
		arm_loading: 'arm',
		loaded: 'none',
		ot2_filling: 'ot2',
		filled: 'none',
		arm_unloading: 'arm',
		complete: 'none',
		failed: 'none',
		aborted: 'none'
	};

	const steps = [
		{ phase: 'created', label: 'Created', action: 'startLoad', button: 'Start arm load' },
		{
			phase: 'arm_loading',
			label: 'Arm loading cartridge',
			action: 'confirmLoaded',
			button: 'Verify arm parked → cartridge seated'
		},
		{ phase: 'loaded', label: 'Cartridge seated', action: 'startFill', button: 'Start OT-2 fill' },
		{
			phase: 'ot2_filling',
			label: 'OT-2 filling wax',
			action: 'confirmFilled',
			button: 'Check OT-2 run finished'
		},
		{ phase: 'filled', label: 'Filled, gantry homed', action: 'startUnload', button: 'Start arm unload' },
		{
			phase: 'arm_unloading',
			label: 'Arm unloading cartridge',
			action: 'complete',
			button: 'Verify arm parked → complete run'
		},
		{ phase: 'complete', label: 'Complete', action: null, button: null }
	];

	const phaseIndex = $derived(steps.findIndex((s) => s.phase === run.phase));
	const isTerminal = $derived(['complete', 'failed', 'aborted'].includes(run.phase));
	const token = $derived(tokenByPhase[run.phase] ?? 'none');

	function fmt(iso: string | null | undefined): string {
		return iso ? new Date(iso).toLocaleString() : '—';
	}
</script>

<div class="mx-auto max-w-5xl space-y-6 p-4">
	<div class="flex items-center justify-between">
		<div>
			<h1 class="text-2xl font-bold" style="color: var(--color-tron-cyan)">
				Arm wax fill — {run.cartridgeId}
			</h1>
			<p class="mt-1 font-mono text-xs" style="color: var(--color-tron-text-secondary)">
				{run._id}
			</p>
		</div>
		<a
			href="/manufacturing/cart-mfg/robot-arm/wax-fill"
			class="text-xs transition-colors hover:text-[var(--color-tron-cyan)]"
			style="color: var(--color-tron-text-secondary)"
		>
			← all arm wax runs
		</a>
	</div>

	{#if form?.error}
		<div class="rounded border border-red-500/50 bg-red-500/10 p-3 text-sm text-red-400">
			{form.error}
		</div>
	{/if}
	{#if run.error}
		<div class="rounded border border-red-500/50 bg-red-500/10 p-3 text-sm text-red-400">
			Run error: {run.error}
		</div>
	{/if}

	<!-- Deck token banner -->
	<div
		class="flex items-center justify-between rounded-lg border p-3 text-sm font-bold uppercase tracking-wider"
		class:border-yellow-500={token !== 'none'}
		class:border-green-500={token === 'none'}
		style="background: var(--color-tron-surface)"
	>
		{#if token === 'arm'}
			<span class="text-yellow-400">⚠ ARM owns the deck — OT-2 must not move</span>
		{:else if token === 'ot2'}
			<span class="text-yellow-400">⚠ OT-2 owns the deck — arm must stay parked</span>
		{:else}
			<span class="text-green-400">Deck free — no machine authorized to move</span>
		{/if}
		<span style="color: var(--color-tron-text-secondary)">phase: {run.phase}</span>
	</div>

	<!-- Step timeline -->
	<section
		class="rounded-lg border border-[var(--color-tron-border)] bg-[var(--color-tron-surface)] p-4"
	>
		<ol class="space-y-3">
			{#each steps as step, i (step.phase)}
				<li class="flex items-center gap-3">
					<span
						class="flex h-6 w-6 shrink-0 items-center justify-center rounded-full border text-xs"
						class:border-green-500={i < phaseIndex || run.phase === 'complete'}
						class:text-green-400={i < phaseIndex || run.phase === 'complete'}
						class:border-cyan-400={i === phaseIndex && !isTerminal}
						class:text-cyan-300={i === phaseIndex && !isTerminal}
						class:border-gray-600={i > phaseIndex}
						class:text-gray-500={i > phaseIndex}
					>
						{#if i < phaseIndex || run.phase === 'complete'}✓{:else}{i + 1}{/if}
					</span>
					<span
						class="flex-1 text-sm"
						style={`color: ${i === phaseIndex ? 'var(--color-tron-text)' : 'var(--color-tron-text-secondary)'}`}
					>
						{step.label}
					</span>
					{#if i === phaseIndex && step.action && !isTerminal}
						{#if step.action === 'startFill'}
							<form method="POST" action="?/startFill" class="flex items-center gap-2">
								{#if data.protocolsError}
									<span class="text-xs text-red-400">{data.protocolsError}</span>
								{/if}
								<select
									name="protocolId"
									required
									class="rounded border border-[var(--color-tron-border)] bg-black/30 p-1.5 text-xs"
									style="color: var(--color-tron-text)"
								>
									{#each data.protocols as p (p.id)}
										<option value={p.id}>{p.name}</option>
									{/each}
								</select>
								<button
									type="submit"
									class="rounded border border-[var(--color-tron-cyan)] px-3 py-1.5 text-xs font-bold hover:bg-[var(--color-tron-cyan)]/10"
									style="color: var(--color-tron-cyan)"
								>
									{step.button}
								</button>
							</form>
						{:else}
							<form method="POST" action={`?/${step.action}`}>
								<button
									type="submit"
									class="rounded border border-[var(--color-tron-cyan)] px-3 py-1.5 text-xs font-bold hover:bg-[var(--color-tron-cyan)]/10"
									style="color: var(--color-tron-cyan)"
								>
									{step.button}
								</button>
							</form>
						{/if}
					{/if}
				</li>
			{/each}
		</ol>
	</section>

	<!-- Details + abort -->
	<div class="grid gap-6 md:grid-cols-2">
		<section
			class="rounded-lg border border-[var(--color-tron-border)] bg-[var(--color-tron-surface)] p-4"
		>
			<h2
				class="mb-2 text-sm font-bold uppercase tracking-wider"
				style="color: var(--color-tron-text-secondary)"
			>
				Cross-references
			</h2>
			<dl class="grid grid-cols-2 gap-y-1 text-xs" style="color: var(--color-tron-text-secondary)">
				<dt>Arm load run</dt>
				<dd class="font-mono" style="color: var(--color-tron-text)">{run.armLoadRunId ?? '—'}</dd>
				<dt>Arm unload run</dt>
				<dd class="font-mono" style="color: var(--color-tron-text)">{run.armUnloadRunId ?? '—'}</dd>
				<dt>OT-2 run</dt>
				<dd class="font-mono" style="color: var(--color-tron-text)">{run.ot2RunId ?? '—'}</dd>
				<dt>Arm parked verified</dt>
				<dd style="color: var(--color-tron-text)">{fmt(run.armParkedVerifiedAt)}</dd>
				<dt>OT-2 homed verified</dt>
				<dd style="color: var(--color-tron-text)">{fmt(run.ot2HomedVerifiedAt)}</dd>
				<dt>Arm tasks</dt>
				<dd class="font-mono" style="color: var(--color-tron-text)">
					{data.taskNames.load} / {data.taskNames.unload}
				</dd>
			</dl>
			<h2
				class="mb-2 mt-4 text-sm font-bold uppercase tracking-wider"
				style="color: var(--color-tron-text-secondary)"
			>
				Parameters
			</h2>
			<pre
				class="overflow-x-auto rounded border border-[var(--color-tron-border)] bg-black/30 p-2 text-xs"
				style="color: var(--color-tron-text)">{JSON.stringify(run.parameters, null, 2)}</pre>
		</section>

		<section
			class="rounded-lg border border-[var(--color-tron-border)] bg-[var(--color-tron-surface)] p-4"
		>
			<h2
				class="mb-2 text-sm font-bold uppercase tracking-wider"
				style="color: var(--color-tron-text-secondary)"
			>
				Event log
			</h2>
			<ul class="max-h-80 space-y-1 overflow-y-auto text-xs">
				{#each [...(run.events ?? [])].reverse() as ev, i (i)}
					<li class="flex gap-2" style="color: var(--color-tron-text-secondary)">
						<span class="shrink-0 font-mono">{fmt(ev.at)}</span>
						<span style="color: var(--color-tron-text)">{ev.type}</span>
						<span>({ev.by})</span>
					</li>
				{/each}
			</ul>

			{#if !isTerminal}
				<form method="POST" action="?/abort" class="mt-4 flex items-center gap-2">
					<input
						name="reason"
						placeholder="abort reason"
						class="flex-1 rounded border border-[var(--color-tron-border)] bg-black/30 p-2 text-xs"
						style="color: var(--color-tron-text)"
					/>
					<button
						type="submit"
						class="rounded border border-red-500 px-3 py-2 text-xs font-bold text-red-400 hover:bg-red-500/10"
					>
						ABORT
					</button>
				</form>
			{/if}
		</section>
	</div>
</div>
