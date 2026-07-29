<script lang="ts">
	import RobotArmConnectionPanel from '$lib/components/RobotArmConnectionPanel.svelte';
	import RobotArmControlBar from '$lib/components/RobotArmControlBar.svelte';

	let { data, form } = $props();

	// ARM-01 §7.4 — this build is accepted against dry-run only, so the Start
	// control refuses to submit when the Pi reports live motion. The server
	// re-checks at submit time; this is the UI half of the same gate.
	const dryRun = $derived(data.preflight?.checks?.dry_run?.value);
	const armReachable = $derived(data.preflight != null);
	const taskStartBlocked = $derived(!armReachable || dryRun !== true || data.holder != null);
	const taskBlockReason = $derived(
		!armReachable
			? 'The arm is unreachable.'
			: dryRun !== true
				? 'The arm is not in DRY_RUN — live motion is out of scope for this build.'
				: data.holder != null
					? 'The arm is already running something.'
					: ''
	);

	let selectedTask = $state('');
	const selectedTaskMeta = $derived(
		(data.tasks ?? []).find((t: { name: string }) => t.name === selectedTask) ?? null
	);

	type ActiveSession = { run_id: string; kind: string };
	type ConnectError = { error: string };

	function isActive(v: unknown): v is ActiveSession {
		return !!v && typeof v === 'object' && 'run_id' in v;
	}
	function isError(v: unknown): v is ConnectError {
		return !!v && typeof v === 'object' && 'error' in v;
	}

	let active = $derived(isActive(data.active) ? data.active : null);
	let connectError = $derived(isError(data.active) ? data.active.error : null);
</script>

<div class="mx-auto max-w-5xl space-y-6 p-4">
	<div class="flex items-center justify-between">
		<h1 class="text-2xl font-bold" style="color: var(--color-tron-cyan)">
			Robot Arm — Remote Control
		</h1>
		<a
			href="/manufacturing/cart-mfg"
			class="text-xs transition-colors hover:text-[var(--color-tron-cyan)]"
			style="color: var(--color-tron-text-secondary)"
		>
			← back
		</a>
	</div>

	<!-- ARM-01 S3 — connection health, ahead of the controls that depend on it -->
	<RobotArmConnectionPanel
		preflight={data.preflight}
		preflightError={data.preflightError}
		baseUrl={data.armBaseUrl}
	/>

	<!-- ARM-01 S8 — who holds the arm + always-live stop -->
	<RobotArmControlBar holder={data.holder} currentUserId={data.currentUserId} />

	<!-- ARM-01 S5 — run a named task from the Pi's registry -->
	<section
		class="rounded border p-3 sm:p-4"
		style="border-color: var(--color-tron-border); background: var(--color-tron-surface);"
	>
		<h2 class="text-sm font-semibold tracking-wide" style="color: var(--color-tron-text)">
			RUN TASK
		</h2>

		{#if (data.tasks ?? []).length === 0}
			<p class="mt-2 text-xs" style="color: var(--color-tron-text-secondary)">
				No tasks available — the arm is unreachable or its registry is empty.
			</p>
		{:else}
			<form method="POST" action="?/startTask" class="mt-3 space-y-3">
				<div>
					<label
						for="task_name"
						class="block text-xs"
						style="color: var(--color-tron-text-secondary)">Task</label
					>
					<select
						id="task_name"
						name="task_name"
						bind:value={selectedTask}
						required
						class="mt-1 min-h-[44px] w-full rounded border bg-transparent px-2 text-sm sm:w-auto sm:min-w-[22rem]"
						style="border-color: var(--color-tron-border); color: var(--color-tron-text)"
					>
						<option value="" disabled>Select a task…</option>
						{#each data.tasks as t (t.name)}
							<option value={t.name}>{t.name}</option>
						{/each}
					</select>
					{#if selectedTaskMeta}
						<p class="mt-1 text-xs" style="color: var(--color-tron-text-secondary)">
							{selectedTaskMeta.description ?? ''}
							{#if selectedTaskMeta.version}<span class="ml-1">v{selectedTaskMeta.version}</span>{/if}
						</p>
					{/if}
				</div>

				<div>
					<label for="lot_id" class="block text-xs" style="color: var(--color-tron-text-secondary)"
						>Lot <span class="opacity-60">(optional)</span></label
					>
					<input
						id="lot_id"
						name="lot_id"
						type="text"
						class="mt-1 min-h-[44px] w-full rounded border bg-transparent px-2 text-sm sm:w-64"
						style="border-color: var(--color-tron-border); color: var(--color-tron-text)"
					/>
				</div>

				<div class="flex flex-wrap items-center gap-3">
					<button
						type="submit"
						disabled={taskStartBlocked || !selectedTask}
						class="min-h-[44px] w-full rounded px-4 text-sm font-semibold disabled:opacity-40 sm:w-auto"
						style="background: rgba(56,189,248,0.15); color: var(--color-tron-cyan); border: 1px solid var(--color-tron-cyan);"
					>
						Start task
					</button>
					{#if taskStartBlocked}
						<span class="text-xs" style="color: var(--color-tron-text-secondary)"
							>{taskBlockReason}</span
						>
					{/if}
				</div>
			</form>
		{/if}
	</section>

	<!-- Connection / active session banner -->
	{#if connectError}
		<div class="rounded border border-red-500/40 bg-red-900/10 p-3 text-sm">
			<p class="font-medium text-red-400">Cannot reach robot-arm Pi</p>
			<p class="mt-1 text-xs" style="color: var(--color-tron-text-secondary)">{connectError}</p>
			<p class="mt-1 text-xs" style="color: var(--color-tron-text-secondary)">
				Check that ROBOT_ARM_BASE_URL is set in BIMS .env and the Pi is up.
			</p>
		</div>
	{:else if active}
		<div class="rounded border border-yellow-500/40 bg-yellow-900/10 p-3 text-sm">
			<p style="color: var(--color-tron-text)">
				<span class="font-medium text-yellow-400">{active.kind}</span> session active
				<span class="ml-2 font-mono text-xs" style="color: var(--color-tron-text-secondary)"
					>{active.run_id}</span
				>
			</p>
			<form method="POST" action="?/stop" class="mt-2">
				<button
					type="submit"
					class="rounded border border-red-500/50 bg-red-900/20 px-3 py-1 text-xs font-medium text-red-300 hover:bg-red-900/40"
					>Stop session</button
				>
			</form>
		</div>
	{:else}
		<div
			class="rounded border border-[var(--color-tron-border)] bg-[var(--color-tron-surface)] p-3 text-sm"
			style="color: var(--color-tron-text-secondary)"
		>
			No active session. Start one below.
		</div>
	{/if}

	<!-- Form result -->
	{#if form?.success}
		<div class="rounded border border-green-500/40 bg-green-900/10 p-3 text-sm text-green-300">
			{form.success}
			{#if 'runId' in form && form.runId}
				<a
					href="/manufacturing/cart-mfg/robot-arm/runs/{form.runId}"
					class="ml-2 underline"
					style="color: var(--color-tron-cyan)">view run →</a
				>
			{/if}
		</div>
	{:else if form?.error}
		<div class="rounded border border-red-500/40 bg-red-900/10 p-3 text-sm text-red-300">
			{form.error}
		</div>
	{/if}

	<!-- Three-column action grid -->
	<div class="grid grid-cols-1 gap-4 md:grid-cols-3">
		<!-- Teleop -->
		<form
			method="POST"
			action="?/startTeleop"
			class="rounded-lg border border-[var(--color-tron-border)] bg-[var(--color-tron-surface)] p-4 space-y-3"
		>
			<div>
				<h2 class="font-semibold" style="color: var(--color-tron-cyan)">Teleop</h2>
				<p class="text-xs" style="color: var(--color-tron-text-secondary)">
					Leader-to-follower mirror.
				</p>
			</div>
			<label class="block text-xs" style="color: var(--color-tron-text-secondary)">
				Rate (Hz)
				<input
					type="number"
					name="rate_hz"
					value="10"
					min="1"
					max="60"
					class="mt-1 w-full rounded border border-[var(--color-tron-border)] bg-black/40 px-2 py-1 text-sm"
					style="color: var(--color-tron-text)"
				/>
			</label>
			<label class="block text-xs" style="color: var(--color-tron-text-secondary)">
				Duration (s, blank = until stopped)
				<input
					type="number"
					name="duration_s"
					placeholder="e.g. 60"
					min="1"
					class="mt-1 w-full rounded border border-[var(--color-tron-border)] bg-black/40 px-2 py-1 text-sm"
					style="color: var(--color-tron-text)"
				/>
			</label>
			<button
				type="submit"
				disabled={!!active}
				class="w-full rounded border border-[var(--color-tron-cyan)]/50 bg-[var(--color-tron-cyan)]/10 px-3 py-1.5 text-sm font-medium transition-colors hover:bg-[var(--color-tron-cyan)]/20 disabled:cursor-not-allowed disabled:opacity-40"
				style="color: var(--color-tron-cyan)">Start teleop</button
			>
		</form>

		<!-- Record -->
		<form
			method="POST"
			action="?/startRecord"
			class="rounded-lg border border-[var(--color-tron-border)] bg-[var(--color-tron-surface)] p-4 space-y-3"
		>
			<div>
				<h2 class="font-semibold" style="color: var(--color-tron-cyan)">Record</h2>
				<p class="text-xs" style="color: var(--color-tron-text-secondary)">
					Teleop + capture frames to JSONL.
				</p>
			</div>
			<label class="block text-xs" style="color: var(--color-tron-text-secondary)">
				Name
				<input
					type="text"
					name="name"
					placeholder="e.g. movementtest1"
					required
					class="mt-1 w-full rounded border border-[var(--color-tron-border)] bg-black/40 px-2 py-1 text-sm"
					style="color: var(--color-tron-text)"
				/>
			</label>
			<label class="block text-xs" style="color: var(--color-tron-text-secondary)">
				Rate (Hz)
				<input
					type="number"
					name="rate_hz"
					value="10"
					min="1"
					max="60"
					class="mt-1 w-full rounded border border-[var(--color-tron-border)] bg-black/40 px-2 py-1 text-sm"
					style="color: var(--color-tron-text)"
				/>
			</label>
			<label class="block text-xs" style="color: var(--color-tron-text-secondary)">
				Duration (s, blank = until stopped)
				<input
					type="number"
					name="duration_s"
					placeholder="e.g. 30"
					min="1"
					class="mt-1 w-full rounded border border-[var(--color-tron-border)] bg-black/40 px-2 py-1 text-sm"
					style="color: var(--color-tron-text)"
				/>
			</label>
			<button
				type="submit"
				disabled={!!active}
				class="w-full rounded border border-[var(--color-tron-cyan)]/50 bg-[var(--color-tron-cyan)]/10 px-3 py-1.5 text-sm font-medium transition-colors hover:bg-[var(--color-tron-cyan)]/20 disabled:cursor-not-allowed disabled:opacity-40"
				style="color: var(--color-tron-cyan)">Start recording</button
			>
		</form>

		<!-- Replay -->
		<form
			method="POST"
			action="?/startReplay"
			class="rounded-lg border border-[var(--color-tron-border)] bg-[var(--color-tron-surface)] p-4 space-y-3"
		>
			<div>
				<h2 class="font-semibold" style="color: var(--color-tron-cyan)">Replay</h2>
				<p class="text-xs" style="color: var(--color-tron-text-secondary)">
					Drive follower from a recording. Leader is not used.
				</p>
			</div>
			<label class="block text-xs" style="color: var(--color-tron-text-secondary)">
				Recording (Pi path)
				<select
					name="source"
					required
					class="mt-1 w-full rounded border border-[var(--color-tron-border)] bg-black/40 px-2 py-1 text-sm"
					style="color: var(--color-tron-text)"
				>
					<option value="">— pick one —</option>
					{#each data.piRecordings as r (r.path)}
						<option value={r.path}>{r.name}</option>
					{/each}
				</select>
			</label>
			<label class="block text-xs" style="color: var(--color-tron-text-secondary)">
				Loops
				<input
					type="number"
					name="loops"
					value="1"
					min="1"
					max="100"
					class="mt-1 w-full rounded border border-[var(--color-tron-border)] bg-black/40 px-2 py-1 text-sm"
					style="color: var(--color-tron-text)"
				/>
			</label>
			<button
				type="submit"
				disabled={!!active || data.piRecordings.length === 0}
				class="w-full rounded border border-[var(--color-tron-cyan)]/50 bg-[var(--color-tron-cyan)]/10 px-3 py-1.5 text-sm font-medium transition-colors hover:bg-[var(--color-tron-cyan)]/20 disabled:cursor-not-allowed disabled:opacity-40"
				style="color: var(--color-tron-cyan)">Start replay</button
			>
		</form>
	</div>

	<!-- Recordings table -->
	<section>
		<h2
			class="mb-2 text-sm font-bold uppercase tracking-wider"
			style="color: var(--color-tron-text-secondary)"
		>
			Recordings on Pi ({data.piRecordings.length})
		</h2>
		{#if data.piRecordings.length === 0}
			<p class="text-sm" style="color: var(--color-tron-text-secondary)">
				No recordings on the Pi yet.
			</p>
		{:else}
			<div
				class="overflow-hidden rounded border border-[var(--color-tron-border)] bg-[var(--color-tron-surface)]"
			>
				<table class="w-full text-xs">
					<thead
						class="border-b border-[var(--color-tron-border)] text-left uppercase tracking-wider"
						style="color: var(--color-tron-text-secondary)"
					>
						<tr>
							<th class="px-3 py-2">Name</th>
							<th class="px-3 py-2">Size</th>
							<th class="px-3 py-2">Modified</th>
						</tr>
					</thead>
					<tbody style="color: var(--color-tron-text)">
						{#each data.piRecordings as r (r.path)}
							<tr class="border-b border-[var(--color-tron-border)]/50 last:border-b-0">
								<td class="px-3 py-2 font-mono">{r.name}</td>
								<td class="px-3 py-2" style="color: var(--color-tron-text-secondary)">
									{(r.size_bytes / 1024).toFixed(1)} KB
								</td>
								<td class="px-3 py-2" style="color: var(--color-tron-text-secondary)">
									{new Date(r.modified).toLocaleString()}
								</td>
							</tr>
						{/each}
					</tbody>
				</table>
			</div>
		{/if}
	</section>
</div>
