<script lang="ts">
	let { data, form } = $props();

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
	let ports = $derived(data.portStatus);

	let leaderReady = $derived(!!ports?.leader.present);
	let followerReady = $derived(!!ports?.follower.present);
	let bothReady = $derived(leaderReady && followerReady && !connectError);

	let showAdvanced = $state(false);
	let showRecord = $state(false);
	let showReplay = $state(false);

	function statusColor(status: string): string {
		if (status === 'running' || status === 'pending') return 'text-yellow-400';
		if (status === 'completed') return 'text-green-400';
		if (status === 'failed') return 'text-red-400';
		if (status === 'cancelled') return 'text-gray-400';
		return 'text-[var(--color-tron-text-secondary)]';
	}

	function formatTime(iso: string | null | undefined): string {
		if (!iso) return '—';
		const d = new Date(iso);
		const date = d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
		const time = d
			.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', hour12: true })
			.replace(' ', '')
			.toLowerCase();
		return `${date}, ${time}`;
	}

	function portPillStyle(p: { present: boolean; in_use: boolean } | undefined): string {
		if (!p) return 'border-gray-500/40 bg-gray-900/20 text-gray-400';
		if (p.in_use) return 'border-yellow-500/50 bg-yellow-900/20 text-yellow-300';
		if (p.present) return 'border-green-500/50 bg-green-900/20 text-green-300';
		return 'border-red-500/50 bg-red-900/20 text-red-300';
	}

	function portPillLabel(p: { present: boolean; in_use: boolean } | undefined): string {
		if (!p) return 'unknown';
		if (p.in_use) return 'in use';
		if (p.present) return 'connected';
		return 'not detected';
	}
</script>

<div class="mx-auto max-w-6xl space-y-6 p-4">
	<div class="flex items-center justify-between">
		<h1 class="text-2xl font-bold" style="color: var(--color-tron-cyan)">Robot Arm</h1>
		<div class="flex items-center gap-2">
			<a
				href="/manufacturing/robot-arm/calibrate"
				class="rounded border border-[var(--color-tron-border)] px-3 py-1.5 text-xs font-medium transition-colors hover:border-[var(--color-tron-cyan)] hover:text-[var(--color-tron-cyan)]"
				style="color: var(--color-tron-text)"
			>
				Calibrate →
			</a>
			<a
				href="/manufacturing/robot-arm/runs"
				class="rounded border border-[var(--color-tron-border)] px-3 py-1.5 text-xs font-medium transition-colors hover:border-[var(--color-tron-cyan)] hover:text-[var(--color-tron-cyan)]"
				style="color: var(--color-tron-text)"
			>
				Full run log →
			</a>
		</div>
	</div>

	<!-- Port status pills -->
	<div class="flex flex-wrap gap-3">
		<div
			class="flex items-center gap-2 rounded-full border px-4 py-2 text-sm font-medium {portPillStyle(
				ports?.leader
			)}"
		>
			<span
				class="inline-block h-2 w-2 rounded-full {ports?.leader.in_use
					? 'bg-yellow-400'
					: ports?.leader.present
						? 'bg-green-400'
						: 'bg-red-400'}"
			></span>
			<span>Leader</span>
			<span class="font-mono text-xs opacity-70"
				>{ports?.leader.port || '—'}</span
			>
			<span class="text-xs opacity-80">· {portPillLabel(ports?.leader)}</span>
		</div>
		<div
			class="flex items-center gap-2 rounded-full border px-4 py-2 text-sm font-medium {portPillStyle(
				ports?.follower
			)}"
		>
			<span
				class="inline-block h-2 w-2 rounded-full {ports?.follower.in_use
					? 'bg-yellow-400'
					: ports?.follower.present
						? 'bg-green-400'
						: 'bg-red-400'}"
			></span>
			<span>Follower</span>
			<span class="font-mono text-xs opacity-70"
				>{ports?.follower.port || '—'}</span
			>
			<span class="text-xs opacity-80">· {portPillLabel(ports?.follower)}</span>
		</div>
	</div>

	<!-- Port-mismatch diagnosis (host can self-suggest the fix when COM
	     numbers don't match config). Hidden when ports line up. -->
	{#if ports?.diagnosis}
		<div class="rounded border border-yellow-500/40 bg-yellow-900/10 p-3 text-sm">
			<p class="font-medium text-yellow-400">Port mismatch</p>
			<p class="mt-1 text-xs text-yellow-200/80">{ports.diagnosis}</p>
		</div>
	{/if}

	<!-- Connect-error banner (only if Pi unreachable) -->
	{#if connectError || !ports}
		<div class="rounded border border-red-500/40 bg-red-900/10 p-3 text-sm">
			<p class="font-medium text-red-400">Cannot reach robot-arm server</p>
			{#if connectError}
				<p class="mt-1 text-xs" style="color: var(--color-tron-text-secondary)">
					{connectError}
				</p>
			{/if}
			<p class="mt-1 text-xs" style="color: var(--color-tron-text-secondary)">
				Check that ROBOT_ARM_BASE_URL is set in BIMS .env and the server is running.
			</p>
		</div>
	{/if}

	<!-- Form result -->
	{#if form?.success}
		<div class="rounded border border-green-500/40 bg-green-900/10 p-3 text-sm text-green-300">
			{form.success}
			{#if 'runId' in form && form.runId}
				<a
					href="/manufacturing/robot-arm/runs/{form.runId}"
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

	<!-- Hero: GO or STOP -->
	{#if active}
		<div
			class="rounded-xl border-2 border-yellow-500/60 bg-yellow-900/10 p-6 text-center shadow-lg"
		>
			<p class="text-xs uppercase tracking-widest text-yellow-400">Session active</p>
			<p class="mt-1 text-2xl font-bold capitalize" style="color: var(--color-tron-text)">
				{active.kind} running
			</p>
			<p
				class="mt-1 font-mono text-xs"
				style="color: var(--color-tron-text-secondary)"
			>
				{active.run_id}
			</p>
			<form method="POST" action="?/stop" class="mt-4">
				<button
					type="submit"
					class="w-full max-w-sm rounded-lg border-2 border-red-500 bg-red-900/40 px-6 py-4 text-2xl font-bold text-red-200 shadow-lg transition-all hover:bg-red-900/60 active:scale-95"
				>
					STOP
				</button>
			</form>
			<p class="mt-3 text-xs" style="color: var(--color-tron-text-secondary)">
				Stops the loop on the server and disables follower torque.
			</p>
		</div>
	{:else}
		<div
			class="rounded-xl border-2 border-[var(--color-tron-cyan)]/40 bg-[var(--color-tron-surface)] p-6 text-center"
		>
			<p
				class="text-xs uppercase tracking-widest"
				style="color: var(--color-tron-text-secondary)"
			>
				Leader → Follower teleop
			</p>
			<p class="mt-1 text-lg font-semibold" style="color: var(--color-tron-text)">
				Backdrive the leader. Follower mirrors live at 10&nbsp;Hz.
			</p>
			<form method="POST" action="?/startTeleop" class="mt-4">
				{#if showAdvanced}
					<div class="mb-3 grid grid-cols-2 gap-3 text-left text-xs">
						<label style="color: var(--color-tron-text-secondary)">
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
						<label style="color: var(--color-tron-text-secondary)">
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
					</div>
				{/if}
				<button
					type="submit"
					disabled={!bothReady}
					class="w-full max-w-sm rounded-lg border-2 border-[var(--color-tron-cyan)] bg-[var(--color-tron-cyan)]/10 px-6 py-4 text-3xl font-bold shadow-lg transition-all hover:bg-[var(--color-tron-cyan)]/25 active:scale-95 disabled:cursor-not-allowed disabled:border-gray-600 disabled:bg-gray-900/30 disabled:text-gray-500 disabled:shadow-none"
					style={bothReady ? 'color: var(--color-tron-cyan)' : ''}
				>
					GO
				</button>
			</form>
			<button
				type="button"
				onclick={() => (showAdvanced = !showAdvanced)}
				class="mt-3 text-xs underline transition-colors hover:text-[var(--color-tron-cyan)]"
				style="color: var(--color-tron-text-secondary)"
			>
				{showAdvanced ? 'Hide options' : 'Advanced options'}
			</button>
			{#if !bothReady && !connectError && ports}
				<p class="mt-2 text-xs text-red-400">
					{!leaderReady && !followerReady
						? 'Both COM ports not detected on server.'
						: !leaderReady
							? `Leader port ${ports.leader.port} not detected.`
							: `Follower port ${ports.follower.port} not detected.`}
				</p>
			{/if}
		</div>
	{/if}

	<!-- Secondary: Record / Replay -->
	{#if !active}
		<div class="grid grid-cols-1 gap-4 md:grid-cols-2">
			<!-- Record -->
			<div class="rounded-lg border border-[var(--color-tron-border)] bg-[var(--color-tron-surface)] p-4">
				<button
					type="button"
					onclick={() => (showRecord = !showRecord)}
					class="flex w-full items-center justify-between text-left"
				>
					<div>
						<h3 class="font-semibold" style="color: var(--color-tron-cyan)">Record run</h3>
						<p class="text-xs" style="color: var(--color-tron-text-secondary)">
							Teleop and capture frames for replay later.
						</p>
					</div>
					<span
						class="text-lg transition-transform {showRecord ? 'rotate-90' : ''}"
						style="color: var(--color-tron-text-secondary)">›</span
					>
				</button>
				{#if showRecord}
					<form method="POST" action="?/startRecord" class="mt-3 space-y-2">
						<label class="block text-xs" style="color: var(--color-tron-text-secondary)">
							Run name
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
						<input type="hidden" name="rate_hz" value="10" />
						<button
							type="submit"
							disabled={!bothReady}
							class="w-full rounded border border-[var(--color-tron-cyan)]/50 bg-[var(--color-tron-cyan)]/10 px-3 py-2 text-sm font-medium transition-colors hover:bg-[var(--color-tron-cyan)]/20 disabled:cursor-not-allowed disabled:opacity-40"
							style="color: var(--color-tron-cyan)">Start recording</button
						>
					</form>
				{/if}
			</div>

			<!-- Replay -->
			<div class="rounded-lg border border-[var(--color-tron-border)] bg-[var(--color-tron-surface)] p-4">
				<button
					type="button"
					onclick={() => (showReplay = !showReplay)}
					class="flex w-full items-center justify-between text-left"
				>
					<div>
						<h3 class="font-semibold" style="color: var(--color-tron-cyan)">Replay saved run</h3>
						<p class="text-xs" style="color: var(--color-tron-text-secondary)">
							{data.piRecordings.length} recording{data.piRecordings.length === 1 ? '' : 's'} on server.
						</p>
					</div>
					<span
						class="text-lg transition-transform {showReplay ? 'rotate-90' : ''}"
						style="color: var(--color-tron-text-secondary)">›</span
					>
				</button>
				{#if showReplay}
					<form method="POST" action="?/startReplay" class="mt-3 space-y-2">
						<label class="block text-xs" style="color: var(--color-tron-text-secondary)">
							Recording
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
							disabled={!bothReady || data.piRecordings.length === 0}
							class="w-full rounded border border-[var(--color-tron-cyan)]/50 bg-[var(--color-tron-cyan)]/10 px-3 py-2 text-sm font-medium transition-colors hover:bg-[var(--color-tron-cyan)]/20 disabled:cursor-not-allowed disabled:opacity-40"
							style="color: var(--color-tron-cyan)">Start replay</button
						>
					</form>
				{/if}
			</div>
		</div>
	{/if}

	<!-- Arms (collapsed-feel: just below the action area) -->
	<section>
		<h2
			class="mb-3 text-sm font-bold uppercase tracking-wider"
			style="color: var(--color-tron-text-secondary)"
		>
			Registered arms
		</h2>
		{#if data.arms.length === 0}
			<p class="text-sm" style="color: var(--color-tron-text-secondary)">
				No arms registered yet. Run the seed script to populate.
			</p>
		{:else}
			<div class="grid grid-cols-1 gap-4 sm:grid-cols-2">
				{#each data.arms as arm (arm._id)}
					<div
						class="rounded-lg border border-[var(--color-tron-border)] bg-[var(--color-tron-surface)] p-4"
					>
						<div class="flex items-baseline justify-between">
							<h3 class="text-lg font-semibold capitalize" style="color: var(--color-tron-text)">
								{arm.role}
							</h3>
							<span class="text-xs" style="color: var(--color-tron-text-secondary)">
								{arm.modelName} · {arm.voltage}V
							</span>
						</div>
						<dl
							class="mt-2 grid grid-cols-2 gap-x-3 gap-y-1 text-xs"
							style="color: var(--color-tron-text-secondary)"
						>
							<dt>Serial</dt>
							<dd style="color: var(--color-tron-text)">{arm.serialNumber}</dd>
							<dt>Port</dt>
							<dd style="color: var(--color-tron-text)">{arm.comPort ?? '—'}</dd>
							<dt>Firmware</dt>
							<dd style="color: var(--color-tron-text)">{arm.firmwareVersion ?? '—'}</dd>
						</dl>
					</div>
				{/each}
			</div>
		{/if}
	</section>

	<!-- Recent runs -->
	<section>
		<h2
			class="mb-3 text-sm font-bold uppercase tracking-wider"
			style="color: var(--color-tron-text-secondary)"
		>
			Recent runs
		</h2>
		{#if data.recentRuns.length === 0}
			<p class="text-sm" style="color: var(--color-tron-text-secondary)">No runs recorded yet.</p>
		{:else}
			<div class="overflow-hidden rounded-lg border border-[var(--color-tron-border)]">
				<table class="w-full text-sm">
					<thead
						class="border-b border-[var(--color-tron-border)] bg-[var(--color-tron-surface)] text-left text-xs uppercase tracking-wider"
						style="color: var(--color-tron-text-secondary)"
					>
						<tr>
							<th class="px-3 py-2">Type</th>
							<th class="px-3 py-2">Status</th>
							<th class="px-3 py-2">Triggered by</th>
							<th class="px-3 py-2">Started</th>
							<th class="px-3 py-2">Ended</th>
						</tr>
					</thead>
					<tbody style="color: var(--color-tron-text)">
						{#each data.recentRuns as run (run._id)}
							<tr class="border-b border-[var(--color-tron-border)]/50 last:border-b-0">
								<td class="px-3 py-2">
									<a
										href="/manufacturing/robot-arm/runs/{run._id}"
										class="hover:underline"
										style="color: var(--color-tron-cyan)">{run.type}</a
									>
								</td>
								<td class="px-3 py-2 {statusColor(run.status)}">{run.status}</td>
								<td class="px-3 py-2">{run.triggeredBy?.username ?? '—'}</td>
								<td class="px-3 py-2 text-xs" style="color: var(--color-tron-text-secondary)">
									{formatTime(run.startedAt)}
								</td>
								<td class="px-3 py-2 text-xs" style="color: var(--color-tron-text-secondary)">
									{formatTime(run.endedAt)}
								</td>
							</tr>
						{/each}
					</tbody>
				</table>
			</div>
		{/if}
	</section>
</div>
