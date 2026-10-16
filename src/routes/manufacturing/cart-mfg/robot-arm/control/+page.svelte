<script lang="ts">
	import RobotArmConnectionPanel from '$lib/components/RobotArmConnectionPanel.svelte';
	import RobotArmControlBar from '$lib/components/RobotArmControlBar.svelte';
	import { enhance } from '$app/forms';

	let { data, form } = $props();

	// Solenoid pulse controls. 1000 ms default: long enough for a cartridge to
	// fall clear, short enough for an intermittent-duty coil. The Pi caps at 2000.
	let pulseMs = $state(1000);
	let gapMs = $state(500);
	let gpioBusy = $state(false);
	const gpioEnhance = () => {
		gpioBusy = true;
		return async ({ update }: { update: (opts?: { reset?: boolean }) => Promise<void> }) => {
			await update({ reset: false });
			gpioBusy = false;
		};
	};

	// Recording trash. Delete moves a recording to R2 for 30 days; Recover
	// brings it back to the Pi. Only the daily cron removes trash permanently.
	let showTrash = $state(false);
	let recordingBusy = $state(false);
	const deletedRecordings = $derived(data.deletedRecordings ?? []);
	const recordingEnhance = () => {
		recordingBusy = true;
		return async ({ update }: { update: (opts?: { reset?: boolean }) => Promise<void> }) => {
			await update({ reset: false });
			recordingBusy = false;
		};
	};
	function daysLeft(iso: string): number {
		return Math.max(0, Math.ceil((new Date(iso).getTime() - Date.now()) / 86_400_000));
	}

	// ARM-01 §7.4 — this build is accepted against dry-run only, so the Start
	// control refuses to submit when the Pi reports live motion. The server
	// re-checks at submit time; this is the UI half of the same gate.
	const dryRun = $derived(data.preflight?.checks?.dry_run?.value);
	const armReachable = $derived(data.preflight != null);
	const taskStartBlocked = $derived(!armReachable || dryRun !== true || data.holder != null);
	const taskBlockReason = $derived(
		!armReachable
			? 'The arm is unreachable — check the connection panel.'
			: dryRun !== true
				? 'Run Task is validated for dry-run only (ARM-01 §7.4). The arm is in live motion: set DRY_RUN=true in ~/robot-arm/.env on the Pi and restart the robot-arm service to re-enable it.'
				: data.holder != null
					? 'The arm is already running something. If the session bar reads STALE, that run was never closed out and will keep blocking this until it is resolved.'
					: ''
	);

	let selectedTask = $state('');
	const selectedTaskMeta = $derived(
		(data.tasks ?? []).find((t: { name: string }) => t.name === selectedTask) ?? null
	);

	// `active` and `activeError` now arrive pre-separated from the server, so the
	// hand-written union guards this page used to carry are gone.
	const active = $derived(data.active ?? null);

	function logTime(iso: string): string {
		return new Date(iso).toLocaleString();
	}
</script>

<div class="mx-auto max-w-7xl space-y-6">
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

	<!--
		Narrow screens get the connection verdict as a single line here; the full
		panel is desktop-only, so phones don't spend half a screen on it before
		reaching the controls.
	-->
	<div class="lg:hidden">
		<RobotArmConnectionPanel
			variant="compact"
			preflight={data.preflight}
			preflightError={data.preflightError}
			baseUrl={data.armBaseUrl}
			lastConnected={data.lastConnected}
		/>
	</div>

	<div class="lg:grid lg:grid-cols-[minmax(0,1fr)_20rem] lg:items-start lg:gap-6">
		<!-- Main column: controls first -->
		<div class="min-w-0 space-y-6">
			<!--
				ARM-01 §8 — the single session indicator, sitting directly above the
				controls it governs. This replaces both the old control bar position
				and the separate inline banner that used to duplicate it.
			-->
			<RobotArmControlBar
				holder={data.holder}
				active={data.active}
				connectError={data.activeError}
				currentUserId={data.currentUserId}
			/>

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

			<!-- Teleop / Record / Replay — the controls used most, so they lead -->
			<div class="grid grid-cols-1 gap-4 md:grid-cols-3">
				<!-- Teleop -->
				<form
					method="POST"
					action="?/startTeleop"
					class="space-y-3 rounded-lg border border-[var(--color-tron-border)] bg-[var(--color-tron-surface)] p-4"
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
							value="30"
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
					class="space-y-3 rounded-lg border border-[var(--color-tron-border)] bg-[var(--color-tron-surface)] p-4"
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
							value="30"
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
					class="space-y-3 rounded-lg border border-[var(--color-tron-border)] bg-[var(--color-tron-surface)] p-4"
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

			<!--
				Solenoids on the arm Pi's GPIO (cartridge chute). Pins are named by BCM
				number for now. One shared pulse length feeds all three buttons; the
				sequence button adds a gap between the two pins. Not disabled during a
				session on purpose: manual testing fires these while teleop runs.
			-->
			<section
				class="rounded border p-3 sm:p-4"
				style="border-color: var(--color-tron-border); background: var(--color-tron-surface);"
			>
				<h2 class="text-sm font-semibold tracking-wide" style="color: var(--color-tron-text)">
					SOLENOIDS (GPIO)
				</h2>
				<p class="mt-1 text-xs" style="color: var(--color-tron-text-secondary)">
					Energize a solenoid for the pulse length, then release. The Pi caps a pulse at 2000 ms.
				</p>

				<div class="mt-3 grid grid-cols-1 gap-4 md:grid-cols-[12rem_minmax(0,1fr)]">
					<div class="space-y-3">
						<label class="block text-xs" style="color: var(--color-tron-text-secondary)">
							Pulse (ms)
							<input
								type="number"
								bind:value={pulseMs}
								min="20"
								max="2000"
								step="10"
								class="mt-1 w-full rounded border border-[var(--color-tron-border)] bg-black/40 px-2 py-1 text-sm"
								style="color: var(--color-tron-text)"
							/>
						</label>
						<label class="block text-xs" style="color: var(--color-tron-text-secondary)">
							Gap between pins (ms, sequence only)
							<input
								type="number"
								bind:value={gapMs}
								min="0"
								max="5000"
								step="50"
								class="mt-1 w-full rounded border border-[var(--color-tron-border)] bg-black/40 px-2 py-1 text-sm"
								style="color: var(--color-tron-text)"
							/>
						</label>
					</div>

					<div class="grid grid-cols-1 gap-3 sm:grid-cols-3">
						<form method="POST" action="?/pulseGpio" use:enhance={gpioEnhance}>
							<input type="hidden" name="pin" value="17" />
							<input type="hidden" name="pulse_ms" value={pulseMs} />
							<button
								type="submit"
								disabled={!armReachable || gpioBusy}
								class="min-h-[44px] w-full rounded border border-[var(--color-tron-cyan)]/50 bg-[var(--color-tron-cyan)]/10 px-3 py-1.5 text-sm font-medium transition-colors hover:bg-[var(--color-tron-cyan)]/20 disabled:cursor-not-allowed disabled:opacity-40"
								style="color: var(--color-tron-cyan)"
							>
								Pulse GPIO 17
							</button>
						</form>
						<form method="POST" action="?/pulseGpio" use:enhance={gpioEnhance}>
							<input type="hidden" name="pin" value="27" />
							<input type="hidden" name="pulse_ms" value={pulseMs} />
							<button
								type="submit"
								disabled={!armReachable || gpioBusy}
								class="min-h-[44px] w-full rounded border border-[var(--color-tron-cyan)]/50 bg-[var(--color-tron-cyan)]/10 px-3 py-1.5 text-sm font-medium transition-colors hover:bg-[var(--color-tron-cyan)]/20 disabled:cursor-not-allowed disabled:opacity-40"
								style="color: var(--color-tron-cyan)"
							>
								Pulse GPIO 27
							</button>
						</form>
						<form method="POST" action="?/pulseSequence" use:enhance={gpioEnhance}>
							<input type="hidden" name="pulse_ms" value={pulseMs} />
							<input type="hidden" name="gap_ms" value={gapMs} />
							<button
								type="submit"
								disabled={!armReachable || gpioBusy}
								class="min-h-[44px] w-full rounded px-3 py-1.5 text-sm font-semibold disabled:cursor-not-allowed disabled:opacity-40"
								style="background: rgba(56,189,248,0.15); color: var(--color-tron-cyan); border: 1px solid var(--color-tron-cyan);"
							>
								GPIO 17 then 27
							</button>
						</form>
					</div>
				</div>
				{#if gpioBusy}
					<p class="mt-2 text-xs" style="color: #f59e0b">
						Pulsing... the Pi holds the pin for the full length before answering.
					</p>
				{:else if !armReachable}
					<p class="mt-2 text-xs" style="color: #f59e0b">
						The arm Pi is unreachable, so the solenoids cannot be driven.
					</p>
				{/if}
			</section>

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
									{#if selectedTaskMeta.version}
										<span class="ml-1 font-mono">v{selectedTaskMeta.version}</span>
									{/if}
								</p>
							{/if}
						</div>

						<div>
							<label for="lot_id" class="block text-xs" style="color: var(--color-tron-text-secondary)"
								>Lot (optional)</label
							>
							<input
								type="text"
								id="lot_id"
								name="lot_id"
								class="mt-1 min-h-[44px] w-full rounded border bg-transparent px-2 text-sm sm:w-auto sm:min-w-[22rem]"
								style="border-color: var(--color-tron-border); color: var(--color-tron-text)"
							/>
						</div>

						<button
							type="submit"
							disabled={taskStartBlocked || !selectedTask}
							class="min-h-[44px] w-full rounded px-4 text-sm font-semibold disabled:opacity-40 sm:w-auto"
							style="background: rgba(56,189,248,0.15); color: var(--color-tron-cyan); border: 1px solid var(--color-tron-cyan);"
						>
							Start task
						</button>
						{#if taskStartBlocked}
							<span class="block text-xs" style="color: #f59e0b">{taskBlockReason}</span>
						{/if}
					</form>
				{/if}
			</section>

			<!-- Recordings table, with the 30-day trash -->
			<section>
				<div class="mb-2 flex flex-wrap items-center justify-between gap-2">
					<h2
						class="text-sm font-bold uppercase tracking-wider"
						style="color: var(--color-tron-text-secondary)"
					>
						Recordings On Pi ({data.piRecordings.length})
					</h2>
					<button
						type="button"
						onclick={() => (showTrash = !showTrash)}
						class="min-h-[36px] rounded border border-[var(--color-tron-cyan)]/50 bg-[var(--color-tron-cyan)]/10 px-3 py-1 text-xs font-medium transition-colors hover:bg-[var(--color-tron-cyan)]/20"
						style="color: var(--color-tron-cyan)"
						aria-expanded={showTrash}
					>
						{showTrash ? 'Hide' : 'Recover Recordings'} ({deletedRecordings.length})
					</button>
				</div>

				{#if showTrash}
					<div
						class="mb-3 overflow-hidden rounded border border-[var(--color-tron-border)] bg-[var(--color-tron-surface)]"
					>
						<p
							class="border-b border-[var(--color-tron-border)] px-3 py-2 text-xs"
							style="color: var(--color-tron-text-secondary)"
						>
							Deleted recordings are kept for 30 days, then removed automatically.
						</p>
						{#if deletedRecordings.length === 0}
							<p class="px-3 py-2 text-xs" style="color: var(--color-tron-text-secondary)">
								Nothing in the trash.
							</p>
						{:else}
							<table class="w-full text-xs">
								<thead
									class="border-b border-[var(--color-tron-border)] text-left uppercase tracking-wider"
									style="color: var(--color-tron-text-secondary)"
								>
									<tr>
										<th class="px-3 py-2">Name</th>
										<th class="px-3 py-2">Deleted</th>
										<th class="px-3 py-2">Days left</th>
										<th class="px-3 py-2"></th>
									</tr>
								</thead>
								<tbody style="color: var(--color-tron-text)">
									{#each deletedRecordings as t (t._id)}
										<tr class="border-b border-[var(--color-tron-border)]/50 last:border-b-0">
											<td class="px-3 py-2 font-mono">{t.name}</td>
											<td class="px-3 py-2" style="color: var(--color-tron-text-secondary)">
												{new Date(t.deletedAt).toLocaleString()}
												{#if t.deletedBy?.username}· {t.deletedBy.username}{/if}
											</td>
											<td class="px-3 py-2" style="color: var(--color-tron-text-secondary)">
												{daysLeft(t.expiresAt)}
											</td>
											<td class="px-3 py-2 text-right">
												<form method="POST" action="?/recoverRecording" use:enhance={recordingEnhance}>
													<input type="hidden" name="id" value={t._id} />
													<button
														type="submit"
														disabled={!armReachable || recordingBusy}
														class="rounded border border-[var(--color-tron-cyan)]/50 px-2 py-1 text-xs transition-colors hover:bg-[var(--color-tron-cyan)]/20 disabled:cursor-not-allowed disabled:opacity-40"
														style="color: var(--color-tron-cyan)"
													>
														Recover
													</button>
												</form>
											</td>
										</tr>
									{/each}
								</tbody>
							</table>
						{/if}
					</div>
				{/if}

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
									<th class="w-10 px-3 py-2"><span class="sr-only">Delete</span></th>
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
										<td class="px-3 py-1 text-right">
											<form
												method="POST"
												action="?/deleteRecording"
												use:enhance={recordingEnhance}
												onsubmit={(e) => {
													if (!confirm(`Delete "${r.name}"? It can be recovered for 30 days.`)) e.preventDefault();
												}}
											>
												<input type="hidden" name="name" value={r.name} />
												<input type="hidden" name="modified" value={r.modified} />
												<button
													type="submit"
													disabled={!!active || recordingBusy}
													title={active ? 'Stop the active session before deleting' : `Delete ${r.name}`}
													aria-label="Delete {r.name}"
													class="inline-flex h-8 w-8 items-center justify-center rounded transition-colors hover:bg-red-500/15 disabled:cursor-not-allowed disabled:opacity-40"
													style="color: #ef4444"
												>
													<svg viewBox="0 0 24 24" class="h-4 w-4" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
														<path d="M3 6h18" />
														<path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
														<path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6" />
														<path d="M10 11v6M14 11v6" />
													</svg>
												</button>
											</form>
										</td>
									</tr>
								{/each}
							</tbody>
						</table>
					</div>
				{/if}
			</section>

			<!-- Connection log -->
			<section>
				<h2
					class="mb-2 text-sm font-bold uppercase tracking-wider"
					style="color: var(--color-tron-text-secondary)"
				>
					Connection log
				</h2>
				{#if (data.connectionLog ?? []).length === 0}
					<p class="text-sm" style="color: var(--color-tron-text-secondary)">
						No connection history yet — the first observation was just recorded.
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
									<th class="px-3 py-2">When</th>
									<th class="px-3 py-2">Result</th>
									<th class="px-3 py-2">Detail</th>
								</tr>
							</thead>
							<tbody style="color: var(--color-tron-text)">
								{#each data.connectionLog as row (row._id)}
									<tr class="border-b border-[var(--color-tron-border)]/50 last:border-b-0">
										<td class="whitespace-nowrap px-3 py-2 font-mono">{logTime(row.createdAt)}</td>
										<td class="px-3 py-2">
											<span style="color: {row.success ? '#22c55e' : '#ef4444'}">
												{row.success ? '● reachable' : '● unreachable'}
											</span>
										</td>
										<td class="break-all px-3 py-2" style="color: var(--color-tron-text-secondary)">
											{#if row.success}
												{row.eventData?.reason === 'change' ? 'recovered' : 'still up'}
											{:else}
												{row.errorMessage || 'unreachable'}
											{/if}
										</td>
									</tr>
								{/each}
							</tbody>
						</table>
					</div>
					<p class="mt-2 text-xs" style="color: var(--color-tron-text-secondary)">
						Recorded when this page is loaded — on every change of state, and at most hourly
						while it is steady. A gap means nobody was watching, not that the arm was up.
					</p>
				{/if}
			</section>
		</div>

		<!-- Desktop side panel: connection health stays visible while you work -->
		<aside class="hidden lg:sticky lg:top-4 lg:block">
			<RobotArmConnectionPanel
				preflight={data.preflight}
				preflightError={data.preflightError}
				baseUrl={data.armBaseUrl}
				lastConnected={data.lastConnected}
			/>
		</aside>
	</div>
</div>
