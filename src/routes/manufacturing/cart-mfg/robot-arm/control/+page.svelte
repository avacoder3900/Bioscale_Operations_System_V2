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

	// ── Camera-verified HOME calibration ──────────────────────────────────
	const home = $derived(data.homeCalibration ?? null);
	// Motion and capture need the arm reachable and nobody on the bus.
	const homeBlocked = $derived(!armReachable || data.holder != null || !!active);
	const homeBlockReason = $derived(
		!armReachable
			? 'The arm is unreachable — check the connection panel.'
			: data.holder != null || active
				? 'The arm is running something — stop it before calibrating or returning home.'
				: ''
	);
	const homeResult = $derived(form && 'homeResult' in form ? (form.homeResult as any) : null);
	const homeJoints = $derived(home ? Object.entries(home.jointSteps as Record<string, number>).sort(([a], [b]) => Number(a) - Number(b)) : []);
	let confirmRecalibrate = $state(false);

	function verdictColor(verdict: string | null | undefined): string {
		return verdict === 'home' ? '#4ade80' : verdict ? '#f59e0b' : 'var(--color-tron-text-secondary)';
	}
	function verdictLabel(verdict: string | null | undefined): string {
		return (
			{
				home: 'AT HOME',
				position_off: 'POSITION OFF',
				camera_mismatch: 'CAMERA MISMATCH',
				position_off_and_camera_mismatch: 'OFF + CAMERA MISMATCH'
			} as Record<string, string>
		)[verdict ?? ''] ?? '—';
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

			{#if form && 'warning' in form && form.warning}
				<div class="rounded border border-amber-500/40 bg-amber-900/10 p-3 text-sm text-amber-300">
					{form.warning}
				</div>
			{:else if form?.success}
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

			<!--
				Arm Calibration — camera-verified HOME. Sits above the session
				controls because it is the recovery path for "the arm did not come
				back to home": the operator parks the arm at zero once, the camera
				and the encoders remember it, and Return to home drives the arm back
				to exactly that picture. Recalibrate only when the camera or the
				setup is moved.
			-->
			<section
				class="rounded border p-3 sm:p-4"
				style="border-color: var(--color-tron-border); background: var(--color-tron-surface);"
			>
				<div class="flex flex-wrap items-start justify-between gap-3">
					<div>
						<h2 class="text-sm font-semibold tracking-wide" style="color: var(--color-tron-text)">
							ARM CALIBRATION — HOME
						</h2>
						<p class="mt-1 text-xs" style="color: var(--color-tron-text-secondary)">
							{#if home}
								Calibrated {logTime(home.capturedAt)}
								{#if home.capturedBy?.username}by {home.capturedBy.username}{/if}
								{#if home.cameraName}· camera <span class="font-mono">{home.cameraName}</span>{:else}· encoders only (no camera reference){/if}
								{#if home.note}· {home.note}{/if}
							{:else}
								Not calibrated. The arm has no camera-verified home yet.
							{/if}
						</p>
					</div>
					{#if home?.lastCheck}
						<div class="text-right text-xs" style="color: var(--color-tron-text-secondary)">
							Last {home.lastCheck.kind === 'return' ? 'return' : 'check'} {logTime(home.lastCheck.at)}
							{#if home.lastCheck.by?.username}by {home.lastCheck.by.username}{/if}
							<div class="font-semibold" style="color: {verdictColor(home.lastCheck.verdict)}">
								{verdictLabel(home.lastCheck.verdict)}
								{#if home.lastCheck.similarity != null}· camera {(home.lastCheck.similarity * 100).toFixed(0)}%{/if}
								{#if home.lastCheck.residualMax != null}· {home.lastCheck.residualMax} steps{/if}
							</div>
						</div>
					{/if}
				</div>

				{#if data.homeCalibrationError}
					<p class="mt-2 text-xs text-red-300">Could not read the calibration: {data.homeCalibrationError}</p>
				{/if}

				<div class="mt-3 grid gap-4 md:grid-cols-[auto_minmax(0,1fr)]">
					<!-- Reference picture (and the latest check beside it) -->
					<div class="flex gap-3">
						<figure class="w-[150px] shrink-0">
							{#if home?.thumbnailDataUrl}
								<img
									src={home.thumbnailDataUrl}
									alt="Camera reference captured at home"
									class="w-full rounded border"
									style="border-color: var(--color-tron-border)"
								/>
							{:else}
								<div
									class="flex aspect-[4/3] w-full items-center justify-center rounded border text-center text-[11px]"
									style="border-color: var(--color-tron-border); color: var(--color-tron-text-secondary)"
								>
									no reference picture
								</div>
							{/if}
							<figcaption class="mt-1 text-center text-[11px]" style="color: var(--color-tron-text-secondary)">
								reference
							</figcaption>
						</figure>
						{#if homeResult?.snapshotDataUrl}
							<figure class="w-[150px] shrink-0">
								<img
									src={homeResult.snapshotDataUrl}
									alt="Camera view during the last check"
									class="w-full rounded border"
									style="border-color: {verdictColor(homeResult.assessment?.verdict)}"
								/>
								<figcaption class="mt-1 text-center text-[11px]" style="color: {verdictColor(homeResult.assessment?.verdict)}">
									now · {verdictLabel(homeResult.assessment?.verdict)}
								</figcaption>
							</figure>
						{/if}
					</div>

					<div class="space-y-3 text-xs" style="color: var(--color-tron-text-secondary)">
						{#if home}
							<div class="flex flex-wrap gap-x-4 gap-y-1 font-mono">
								{#each homeJoints as [sid, steps]}
									<span>
										J{sid} <span style="color: var(--color-tron-text)">{steps}</span>
										{#if homeResult?.residuals && homeResult.residuals[sid] != null}
											<span style="color: {Math.abs(homeResult.residuals[sid]) <= 12 ? '#4ade80' : '#f59e0b'}">
												({homeResult.residuals[sid] > 0 ? '+' : ''}{homeResult.residuals[sid]})
											</span>
										{/if}
									</span>
								{/each}
								{#if home.pose.x_mm != null}
									<span>xyz <span style="color: var(--color-tron-text)">{home.pose.x_mm?.toFixed(0)}, {home.pose.y_mm?.toFixed(0)}, {home.pose.z_mm?.toFixed(0)} mm</span></span>
								{/if}
							</div>
							{#if homeResult?.cameraWarning}
								<p style="color: #f59e0b">{homeResult.cameraWarning}</p>
							{/if}
							{#if homeResult?.moved?.length}
								<p>Moved: {homeResult.moved.map((m: { sid: number; delta: number }) => `J${m.sid} ${m.delta > 0 ? '+' : ''}${m.delta}`).join(', ')}</p>
							{/if}

							<div class="flex flex-wrap items-center gap-2">
								<form method="POST" action="?/returnHome">
									<button
										type="submit"
										disabled={homeBlocked}
										class="min-h-[44px] rounded px-4 text-sm font-semibold disabled:cursor-not-allowed disabled:opacity-40"
										style="background: rgba(56,189,248,0.15); color: var(--color-tron-cyan); border: 1px solid var(--color-tron-cyan);"
										title="The arm will move to the calibrated home, then the camera verifies it"
									>
										Return to home
									</button>
								</form>
								<form method="POST" action="?/checkHome">
									<button
										type="submit"
										disabled={!armReachable}
										class="min-h-[44px] rounded border px-4 text-sm font-medium disabled:cursor-not-allowed disabled:opacity-40"
										style="border-color: var(--color-tron-border); color: var(--color-tron-text)"
										title="No motion: compare the encoders and the camera against the calibration"
									>
										Check without moving
									</button>
								</form>
								{#if !confirmRecalibrate}
									<button
										type="button"
										onclick={() => (confirmRecalibrate = true)}
										disabled={homeBlocked}
										class="min-h-[44px] rounded border px-4 text-sm font-medium disabled:cursor-not-allowed disabled:opacity-40"
										style="border-color: var(--color-tron-border); color: var(--color-tron-text-secondary)"
									>
										Recalibrate…
									</button>
								{/if}
								<form method="POST" action="?/clearHome" onsubmit={(e) => { if (!confirm('Clear the home calibration? Return to home will be unavailable until you recalibrate.')) e.preventDefault(); }}>
									<button
										type="submit"
										class="min-h-[44px] rounded px-3 text-xs disabled:opacity-40"
										style="color: #f87171"
									>
										Clear
									</button>
								</form>
							</div>
							{#if homeBlocked}
								<span class="block" style="color: #f59e0b">{homeBlockReason}</span>
							{/if}
						{/if}

						{#if !home || confirmRecalibrate}
							<form method="POST" action="?/calibrateHome" class="space-y-2 rounded border p-3" style="border-color: var(--color-tron-border); background: rgba(0,0,0,0.25)">
								<ol class="list-decimal space-y-1 pl-4" style="color: var(--color-tron-text)">
									<li>Return the arm to its zero position — use the <a href="/manufacturing/cart-mfg/robot-arm/jog" class="underline" style="color: var(--color-tron-cyan)">Jog</a> tab, or switch torque off and place it by hand.</li>
									<li>Make sure the arm camera can see the arm and nothing is in the way.</li>
									<li>Press <strong>Calibrate home</strong>. The encoders and the camera's picture are stored as the home reference.</li>
								</ol>
								<div class="flex flex-wrap items-end gap-2">
									{#if (data.cameras ?? []).length > 1}
										<label class="block text-xs" style="color: var(--color-tron-text-secondary)">
											Camera
											<select name="camera" class="mt-1 rounded border bg-black/40 px-2 py-1 text-sm" style="border-color: var(--color-tron-border); color: var(--color-tron-text)">
												{#each data.cameras ?? [] as cam}
													<option value={cam.name} selected={cam.name === home?.cameraName}>{cam.name}</option>
												{/each}
											</select>
										</label>
									{/if}
									<label class="block grow text-xs" style="color: var(--color-tron-text-secondary)">
										Note (optional)
										<input name="note" placeholder="e.g. camera moved to new bracket" class="mt-1 w-full rounded border bg-black/40 px-2 py-1 text-sm" style="border-color: var(--color-tron-border); color: var(--color-tron-text)" />
									</label>
									<button
										type="submit"
										disabled={homeBlocked}
										class="min-h-[44px] rounded px-4 text-sm font-semibold disabled:cursor-not-allowed disabled:opacity-40"
										style="background: rgba(56,189,248,0.15); color: var(--color-tron-cyan); border: 1px solid var(--color-tron-cyan);"
									>
										{home ? 'Recalibrate home' : 'Calibrate home'}
									</button>
									{#if confirmRecalibrate}
										<button type="button" onclick={() => (confirmRecalibrate = false)} class="min-h-[44px] px-2 text-xs" style="color: var(--color-tron-text-secondary)">cancel</button>
									{/if}
								</div>
								{#if homeBlocked}
									<span class="block text-xs" style="color: #f59e0b">{homeBlockReason}</span>
								{/if}
								{#if home}
									<p class="text-[11px]" style="color: #f59e0b">Recalibrating replaces the current reference. Only needed if the camera or the arm's setup was moved.</p>
								{/if}
							</form>
						{/if}
					</div>
				</div>
			</section>

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
