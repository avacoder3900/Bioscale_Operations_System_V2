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
</script>

<div class="mx-auto max-w-6xl space-y-8 p-4">
	<div class="flex items-center justify-between">
		<h1 class="text-2xl font-bold" style="color: var(--color-tron-cyan)">Robot Arm</h1>
		<a
			href="/manufacturing/robot-arm/runs"
			class="rounded border border-[var(--color-tron-border)] px-3 py-1.5 text-xs font-medium transition-colors hover:border-[var(--color-tron-cyan)] hover:text-[var(--color-tron-cyan)]"
			style="color: var(--color-tron-text)"
		>
			Full run log →
		</a>
	</div>

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

	<!-- Quick controls -->
	<section>
		<h2
			class="mb-3 text-sm font-bold uppercase tracking-wider"
			style="color: var(--color-tron-text-secondary)"
		>
			Controls
		</h2>
		<div class="grid grid-cols-1 gap-4 md:grid-cols-3">
			<!-- Teleop -->
			<form
				method="POST"
				action="?/startTeleop"
				class="space-y-3 rounded-lg border border-[var(--color-tron-border)] bg-[var(--color-tron-surface)] p-4"
			>
				<div>
					<h3 class="font-semibold" style="color: var(--color-tron-cyan)">Leader → Follower</h3>
					<p class="text-xs" style="color: var(--color-tron-text-secondary)">
						Backdrive the leader; follower mirrors live.
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
					disabled={!!active || !!connectError}
					class="w-full rounded border border-[var(--color-tron-cyan)]/50 bg-[var(--color-tron-cyan)]/10 px-3 py-2 text-sm font-medium transition-colors hover:bg-[var(--color-tron-cyan)]/20 disabled:cursor-not-allowed disabled:opacity-40"
					style="color: var(--color-tron-cyan)">Start teleop</button
				>
			</form>

			<!-- Record -->
			<form
				method="POST"
				action="?/startRecord"
				class="space-y-3 rounded-lg border border-[var(--color-tron-border)] bg-[var(--color-tron-surface)] p-4"
			>
				<div>
					<h3 class="font-semibold" style="color: var(--color-tron-cyan)">Record run</h3>
					<p class="text-xs" style="color: var(--color-tron-text-secondary)">
						Teleop + capture frames to JSONL.
					</p>
				</div>
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
					disabled={!!active || !!connectError}
					class="w-full rounded border border-[var(--color-tron-cyan)]/50 bg-[var(--color-tron-cyan)]/10 px-3 py-2 text-sm font-medium transition-colors hover:bg-[var(--color-tron-cyan)]/20 disabled:cursor-not-allowed disabled:opacity-40"
					style="color: var(--color-tron-cyan)">Start recording</button
				>
			</form>

			<!-- Replay -->
			<form
				method="POST"
				action="?/startReplay"
				class="space-y-3 rounded-lg border border-[var(--color-tron-border)] bg-[var(--color-tron-surface)] p-4"
			>
				<div>
					<h3 class="font-semibold" style="color: var(--color-tron-cyan)">Replay saved run</h3>
					<p class="text-xs" style="color: var(--color-tron-text-secondary)">
						Drive follower from a recording.
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
					disabled={!!active || !!connectError || data.piRecordings.length === 0}
					class="w-full rounded border border-[var(--color-tron-cyan)]/50 bg-[var(--color-tron-cyan)]/10 px-3 py-2 text-sm font-medium transition-colors hover:bg-[var(--color-tron-cyan)]/20 disabled:cursor-not-allowed disabled:opacity-40"
					style="color: var(--color-tron-cyan)">Start replay</button
				>
			</form>
		</div>
	</section>

	<!-- Arms -->
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

	<!-- Datasets summary -->
	<section>
		<h2
			class="mb-3 text-sm font-bold uppercase tracking-wider"
			style="color: var(--color-tron-text-secondary)"
		>
			Datasets
		</h2>
		<p class="text-sm" style="color: var(--color-tron-text-secondary)">
			{data.datasetCount} recorded session{data.datasetCount === 1 ? '' : 's'} on disk.
		</p>
	</section>
</div>
