<script lang="ts">
	import type { PageData, ActionData } from './$types';

	let { data, form }: { data: PageData; form: ActionData } = $props();

	const calibration = $derived(data.calibration);
	const saved = $derived(
		calibration && !('error' in calibration) ? calibration.saved : null
	);
	const live = $derived(calibration && !('error' in calibration) ? calibration.live : null);
	const deltas = $derived(
		calibration && !('error' in calibration) ? calibration.deltas : null
	);
	const errorMsg = $derived(
		calibration && 'error' in calibration ? calibration.error : null
	);

	function fmtDate(iso: string | undefined): string {
		if (!iso) return '—';
		try {
			return new Date(iso).toLocaleString();
		} catch {
			return iso;
		}
	}

	function fmtDelta(d: number | null | undefined): string {
		if (d === null || d === undefined) return '—';
		if (d === 0) return '0';
		return d > 0 ? `+${d}` : `${d}`;
	}

	function deltaClass(d: number | null | undefined): string {
		if (d === null || d === undefined) return 'text-gray-500';
		const m = Math.abs(d);
		if (m === 0) return 'text-green-300';
		if (m < 50) return 'text-green-300';
		if (m < 200) return 'text-yellow-300';
		return 'text-red-300';
	}

	const jointNames = $derived(
		saved?.joint_names ?? live?.joint_names ?? [
			'shoulder_pan',
			'shoulder_lift',
			'elbow_flex',
			'wrist_flex',
			'wrist_roll',
			'gripper'
		]
	);

	// --- multi-pose joint map ---

	const jointMap = $derived(data.jointMap);
	const map = $derived(jointMap?.map ?? null);
	const fit = $derived(map?.fit ?? null);
	const poses = $derived(map?.poses ?? []);
	const mapLive = $derived(jointMap?.live ?? null);
	const mapError = $derived(jointMap?.live_error ?? null);

	const mapJointNames = $derived(map?.joint_names ?? jointNames);

	/**
	 * Per-joint fit status → operator-facing label. Anything but `ok` means
	 * that joint silently fell back to a 1:1 mirror, so the label has to say
	 * so rather than just showing a colour.
	 */
	function fitLabel(status: string | undefined): string {
		switch (status) {
			case 'ok':
				return 'OK';
			case 'single_pose':
				return 'Offset only (1 pose)';
			case 'insufficient_range':
				return 'Range too small — mirroring';
			case 'implausible_scale':
				return 'Slope rejected — mirroring';
			case 'no_fit':
				return 'No data';
			default:
				return status ?? '—';
		}
	}

	function fitClass(status: string | undefined): string {
		switch (status) {
			case 'ok':
				return 'text-green-300';
			case 'single_pose':
			case 'insufficient_range':
				return 'text-yellow-300';
			case 'implausible_scale':
				return 'text-red-300';
			default:
				return 'text-gray-500';
		}
	}

	function fmtNum(n: number | null | undefined, places = 3): string {
		if (n === null || n === undefined) return '—';
		return n.toFixed(places);
	}

	// A joint is only really calibrated once its slope survived the fit.
	// Array.isArray-guarded rather than just `fit?.`: the payload is an
	// unchecked cast off the wire, and a joint_map.json missing `status`
	// would throw here during SSR — 500-ing the whole page instead of
	// degrading one panel, locking the operator out of the page they'd use
	// to clear the bad map.
	const calibratedCount = $derived(
		Array.isArray(fit?.status) ? fit.status.filter((s) => s === 'ok').length : 0
	);

	// "No map saved" and "couldn't reach the host" both arrive as map === null.
	// Only the first justifies telling the operator teleop is mirroring 1:1.
	const hostUnreachable = $derived(data.reachable === false);

	// --- ARM-WAX tooling (labware JSONs) ---

	const tooling = $derived(
		data.tooling && !('error' in data.tooling) ? data.tooling : null
	);
	const toolingError = $derived(
		data.tooling && 'error' in data.tooling ? data.tooling.error : null
	);
	const missingCount = $derived(
		tooling ? tooling.required.filter((t) => !t.present).length : 0
	);
</script>

<div class="mx-auto max-w-5xl space-y-6 p-4">
	<div class="flex items-center justify-between">
		<h1 class="text-2xl font-bold" style="color: var(--color-tron-cyan)">
			Robot Arm — Sync Zero Calibration
		</h1>
		<a
			href="/manufacturing/cart-mfg/robot-arm/control"
			class="rounded border border-[var(--color-tron-border)] px-3 py-1.5 text-xs font-medium transition-colors hover:border-[var(--color-tron-cyan)] hover:text-[var(--color-tron-cyan)]"
			style="color: var(--color-tron-text)"
		>
			← Back to robot arm
		</a>
	</div>

	<!-- Active-session banner -->
	{#if data.active}
		<div class="rounded border border-yellow-500/40 bg-yellow-900/10 p-3 text-sm">
			<p class="font-medium text-yellow-400">
				Session active: {data.active.kind} ({data.active.run_id})
			</p>
			<p class="mt-1 text-xs text-yellow-200/80">
				Stop the session from the
				<a href="/manufacturing/cart-mfg/robot-arm/control" class="underline">control page</a>
				before capturing — the arm bus is single-owner.
			</p>
		</div>
	{/if}

	<!-- Form result -->
	{#if form && 'success' in form && form.success}
		<div class="rounded border border-green-500/40 bg-green-900/10 p-3 text-sm text-green-300">
			{form.success}
		</div>
	{:else if form && 'error' in form && form.error}
		<div class="rounded border border-red-500/40 bg-red-900/10 p-3 text-sm text-red-300">
			{form.error}
		</div>
	{/if}

	<!-- Fetch error from the host -->
	{#if errorMsg}
		<div class="rounded border border-red-500/40 bg-red-900/10 p-3 text-sm">
			<p class="font-medium text-red-400">Cannot reach robot-arm server</p>
			<p class="mt-1 text-xs" style="color: var(--color-tron-text-secondary)">{errorMsg}</p>
		</div>
	{/if}

	<!-- What is sync zero — short explainer -->
	<div
		class="rounded-lg border border-[var(--color-tron-border)] bg-[var(--color-tron-surface)] p-4 text-sm"
		style="color: var(--color-tron-text-secondary)"
	>
		<p>
			A <span style="color: var(--color-tron-cyan)">sync zero</span> is the matched
			reference pose for leader and follower. Pose both arms in a known shape —
			typically both straight up with the gripper closed — then press
			<span class="font-semibold">Capture</span>. From then on, every teleop and record
			session starts from that calibrated neutral instead of whatever pose the arms
			happen to be in when GO is pressed.
		</p>
		<p class="mt-2">
			Saved on the host at <code class="font-mono text-xs">calibrations/sync_zero.json</code>.
			Survives reboots. Clear it any time to revert to capture-at-start behavior.
		</p>
	</div>

	<!-- Saved zero status -->
	<div
		class="rounded-lg border border-[var(--color-tron-border)] bg-[var(--color-tron-surface)] p-4"
	>
		<h2 class="text-sm font-semibold uppercase tracking-wider" style="color: var(--color-tron-text-secondary)">
			Saved zero
		</h2>
		{#if saved}
			<dl class="mt-2 grid grid-cols-2 gap-x-6 gap-y-1 text-sm">
				<dt style="color: var(--color-tron-text-secondary)">Captured at</dt>
				<dd class="font-mono" style="color: var(--color-tron-text)">
					{fmtDate(saved.captured_at)}
				</dd>
				<dt style="color: var(--color-tron-text-secondary)">Captured by</dt>
				<dd style="color: var(--color-tron-text)">
					{saved.captured_by?.username ?? 'unknown'}
				</dd>
				<dt style="color: var(--color-tron-text-secondary)">Version</dt>
				<dd class="font-mono" style="color: var(--color-tron-text)">{saved.version}</dd>
			</dl>
		{:else}
			<p class="mt-2 text-sm" style="color: var(--color-tron-text-secondary)">
				No sync zero saved. Teleop and record will lock neutrals to whatever pose the
				arms are in when GO is pressed. Capture a zero to make it repeatable.
			</p>
		{/if}
	</div>

	<!-- Live state + deltas -->
	{#if live}
		<div
			class="overflow-hidden rounded-lg border border-[var(--color-tron-border)] bg-[var(--color-tron-surface)]"
		>
			<h2
				class="border-b border-[var(--color-tron-border)] px-4 py-2 text-sm font-semibold uppercase tracking-wider"
				style="color: var(--color-tron-text-secondary)"
			>
				Live positions {saved ? '(deltas vs saved zero)' : ''}
			</h2>
			<table class="w-full text-sm">
				<thead class="text-xs" style="color: var(--color-tron-text-secondary)">
					<tr class="border-b border-[var(--color-tron-border)]">
						<th class="px-3 py-2 text-left">Joint</th>
						<th class="px-3 py-2 text-right">Leader saved</th>
						<th class="px-3 py-2 text-right">Leader live</th>
						<th class="px-3 py-2 text-right">Δ</th>
						<th class="px-3 py-2 text-right">Follower saved</th>
						<th class="px-3 py-2 text-right">Follower live</th>
						<th class="px-3 py-2 text-right">Δ</th>
					</tr>
				</thead>
				<tbody style="color: var(--color-tron-text)">
					{#each jointNames as joint, i (joint)}
						<tr class="border-b border-[var(--color-tron-border)]/40 font-mono text-xs">
							<td class="px-3 py-1.5 font-sans" style="color: var(--color-tron-text-secondary)"
								>{joint}</td
							>
							<td class="px-3 py-1.5 text-right">{saved?.leader_positions[i] ?? '—'}</td>
							<td class="px-3 py-1.5 text-right">{live.leader_positions[i] ?? '—'}</td>
							<td class="px-3 py-1.5 text-right {deltaClass(deltas?.leader[i])}"
								>{fmtDelta(deltas?.leader[i])}</td
							>
							<td class="px-3 py-1.5 text-right">{saved?.follower_positions[i] ?? '—'}</td>
							<td class="px-3 py-1.5 text-right">{live.follower_positions[i] ?? '—'}</td>
							<td class="px-3 py-1.5 text-right {deltaClass(deltas?.follower[i])}"
								>{fmtDelta(deltas?.follower[i])}</td
							>
						</tr>
					{/each}
				</tbody>
			</table>
			<p class="px-4 py-2 text-xs" style="color: var(--color-tron-text-secondary)">
				Refresh the page to re-read positions. Encoder ticks: 0–4095 per joint.
			</p>
		</div>
	{/if}

	<!-- Capture button -->
	<div
		class="rounded-xl border-2 border-[var(--color-tron-cyan)]/40 bg-[var(--color-tron-surface)] p-6 text-center"
	>
		<p class="text-xs uppercase tracking-widest" style="color: var(--color-tron-text-secondary)">
			Pose both arms to a matched reference, then
		</p>
		<form method="POST" action="?/capture" class="mt-4">
			<button
				type="submit"
				disabled={!!data.active}
				class="w-full max-w-sm rounded-lg border-2 border-[var(--color-tron-cyan)] bg-[var(--color-tron-cyan)]/10 px-6 py-4 text-2xl font-bold shadow-lg transition-all hover:bg-[var(--color-tron-cyan)]/25 active:scale-95 disabled:cursor-not-allowed disabled:border-gray-600 disabled:bg-gray-900/30 disabled:text-gray-500 disabled:shadow-none"
				style={!data.active ? 'color: var(--color-tron-cyan)' : ''}
			>
				CAPTURE SYNC ZERO
			</button>
		</form>
		{#if data.active}
			<p class="mt-2 text-xs text-yellow-400">
				Capture is disabled while a session is active.
			</p>
		{/if}
	</div>

	<!-- ================= Multi-pose joint map ================= -->
	<div
		class="space-y-4 rounded-xl border-2 border-[var(--color-tron-cyan)]/40 bg-[var(--color-tron-surface)] p-6"
	>
		<div class="flex items-center justify-between">
			<h2 class="text-lg font-bold" style="color: var(--color-tron-cyan)">
				Joint Map — Multi-Pose Calibration
			</h2>
			<span class="text-xs uppercase tracking-widest" style="color: var(--color-tron-text-secondary)">
				{poses.length} pose{poses.length === 1 ? '' : 's'} · {calibratedCount}/{mapJointNames.length}
				joints fitted
			</span>
		</div>

		<p class="text-xs leading-relaxed" style="color: var(--color-tron-text-secondary)">
			Sync zero above captures a single matched pose, which can only ever produce an
			<em>offset</em>. The leader and follower use different gearing (1/345, 1/191, 1/147), so a
			pure mirror over-travels on some joints. Capturing several poses spread across each
			joint's range lets the host fit a per-joint <em>scale</em> as well. Aim for at least 3
			poses, moved as far apart as the arm comfortably allows — a joint that barely moves
			between poses cannot be fitted and will fall back to mirroring.
		</p>

		{#if mapError}
			<div class="rounded-lg border-2 border-yellow-500/60 bg-yellow-900/20 p-3">
				<p class="text-xs text-yellow-300">Live read unavailable: {mapError}</p>
			</div>
		{/if}

		<!-- Capture pose -->
		<form method="POST" action="?/capturePose" class="text-center">
			<button
				type="submit"
				disabled={!!data.active}
				class="w-full max-w-sm rounded-lg border-2 border-[var(--color-tron-cyan)] bg-[var(--color-tron-cyan)]/10 px-6 py-4 text-xl font-bold shadow-lg transition-all hover:bg-[var(--color-tron-cyan)]/25 active:scale-95 disabled:cursor-not-allowed disabled:border-gray-600 disabled:bg-gray-900/30 disabled:text-gray-500 disabled:shadow-none"
				style={!data.active ? 'color: var(--color-tron-cyan)' : ''}
			>
				CAPTURE POSE
			</button>
			<p class="mt-2 text-xs" style="color: var(--color-tron-text-secondary)">
				Hand-pose both arms to the same physical position, then capture. The follower is held
				briefly during the read and released again, so it stays limp between poses.
			</p>
			{#if data.active}
				<p class="mt-2 text-xs text-yellow-400">
					Capture is disabled while a session is active.
				</p>
			{/if}
		</form>

		<!-- Per-joint fit -->
		{#if fit}
			<div>
				<h3
					class="mb-2 text-xs uppercase tracking-widest"
					style="color: var(--color-tron-text-secondary)"
				>
					Fit — {fit.n_poses} pose{fit.n_poses === 1 ? '' : 's'}, fitted {fmtDate(fit.fitted_at)}
				</h3>
				<table class="w-full text-sm">
					<thead>
						<tr class="border-b" style="border-color: var(--color-tron-border)">
							<th class="py-1 text-left font-normal" style="color: var(--color-tron-text-secondary)"
								>Joint</th
							>
							<th class="py-1 text-right font-normal" style="color: var(--color-tron-text-secondary)"
								>Scale</th
							>
							<th class="py-1 text-right font-normal" style="color: var(--color-tron-text-secondary)"
								>Offset</th
							>
							<th class="py-1 text-right font-normal" style="color: var(--color-tron-text-secondary)"
								>Max resid.</th
							>
							{#if mapLive}
								<th
									class="py-1 text-right font-normal"
									style="color: var(--color-tron-text-secondary)">Tracking err.</th
								>
							{/if}
							<th class="py-1 text-left font-normal" style="color: var(--color-tron-text-secondary)"
								>Status</th
							>
						</tr>
					</thead>
					<tbody>
						{#each mapJointNames as name, i (name)}
							<tr class="border-b" style="border-color: var(--color-tron-border)">
								<td class="py-1.5 font-mono text-xs">{name}</td>
								<td class="py-1.5 text-right font-mono text-xs">{fmtNum(fit.scale[i], 4)}</td>
								<td class="py-1.5 text-right font-mono text-xs">{fmtNum(fit.offset[i], 1)}</td>
								<td class="py-1.5 text-right font-mono text-xs">{fmtNum(fit.residual_max[i], 1)}</td>
								{#if mapLive}
									<td
										class="py-1.5 text-right font-mono text-xs {deltaClass(
											mapLive.tracking_error[i]
										)}">{fmtDelta(mapLive.tracking_error[i])}</td
									>
								{/if}
								<td class="py-1.5 text-xs {fitClass(fit.status[i])}">{fitLabel(fit.status[i])}</td>
							</tr>
						{/each}
					</tbody>
				</table>
				{#if mapLive}
					<p class="mt-2 text-xs" style="color: var(--color-tron-text-secondary)">
						Tracking error is the follower's actual position minus what the current fit predicts.
						An error that grows as you move that joint means its scale is still wrong — capture
						more poses across its travel.
					</p>
				{/if}
			</div>
		{:else if hostUnreachable}
			<p class="text-sm text-yellow-300">
				Calibration state unknown — could not reach the robot-arm host. This does
				<span class="font-semibold">not</span> mean the arm is uncalibrated; a fitted map may
				well be saved on the host.
			</p>
		{:else}
			<p class="text-sm" style="color: var(--color-tron-text-secondary)">
				No joint map saved. Teleop mirrors the leader 1:1.
			</p>
		{/if}

		<!-- Captured poses -->
		{#if poses.length > 0}
			<div>
				<h3
					class="mb-2 text-xs uppercase tracking-widest"
					style="color: var(--color-tron-text-secondary)"
				>
					Captured poses
				</h3>
				<ul class="space-y-1">
					{#each poses as pose (pose.index)}
						<li
							class="flex items-center justify-between rounded border px-3 py-1.5 text-xs"
							style="border-color: var(--color-tron-border)"
						>
							<span class="font-mono">
								#{pose.index} · {fmtDate(pose.captured_at)}
								{#if pose.captured_by?.username}
									· {pose.captured_by.username}
								{/if}
							</span>
							<form method="POST" action="?/deletePose">
								<input type="hidden" name="index" value={pose.index} />
								<button
									type="submit"
									disabled={!!data.active}
									class="underline transition-colors hover:text-red-400 disabled:cursor-not-allowed disabled:text-gray-600 disabled:no-underline"
									style="color: var(--color-tron-text-secondary)"
								>
									Delete
								</button>
							</form>
						</li>
					{/each}
				</ul>
			</div>
		{/if}

		{#if map}
			<form method="POST" action="?/clearMap" class="text-center">
				<button
					type="submit"
					disabled={!!data.active}
					class="text-xs underline transition-colors hover:text-red-400 disabled:cursor-not-allowed disabled:text-gray-600 disabled:no-underline"
					style="color: var(--color-tron-text-secondary)"
				>
					Clear joint map
				</button>
			</form>
		{/if}
	</div>

	<!-- Clear button (secondary) -->
	{#if saved}
		<form method="POST" action="?/clear" class="text-center">
			<button
				type="submit"
				class="text-xs underline transition-colors hover:text-red-400"
				style="color: var(--color-tron-text-secondary)"
			>
				Clear saved sync zero
			</button>
		</form>
	{/if}

	<!-- ============ ARM-WAX tooling (labware JSONs) ============ -->
	<div
		class="rounded-lg border p-4"
		style="border-color: var(--color-tron-border); background: var(--color-tron-surface)"
	>
		<div class="flex items-center justify-between">
			<h2 class="text-sm font-bold uppercase tracking-widest" style="color: var(--color-tron-cyan)">
				ARM-WAX-01 Tooling — Labware JSONs
			</h2>
			{#if tooling}
				<span
					class="rounded border px-2 py-0.5 font-mono text-xs"
					style="border-color: var(--color-tron-border); color: {missingCount === 0
						? 'var(--color-tron-cyan)'
						: 'var(--color-tron-yellow, #eab308)'}"
				>
					{missingCount === 0 ? 'all tooling registered' : `${missingCount} missing`}
				</span>
			{/if}
		</div>
		<p class="mt-1 text-xs" style="color: var(--color-tron-text-secondary)">
			Custom deck fixtures for the arm-fed wax fill. Definitions registered here go into the
			shared labware library and are bundled automatically with every protocol upload, so new
			tooling reaches the OT-2 without code changes.
			<a href="/opentrons/labware" class="underline">Full library →</a>
		</p>

		{#if toolingError}
			<p class="mt-3 text-xs text-red-300">Couldn't load tooling list: {toolingError}</p>
		{:else if tooling}
			<!-- Required tooling status -->
			<table class="mt-3 w-full text-xs">
				<thead>
					<tr class="border-b" style="border-color: var(--color-tron-border)">
						<th class="px-2 py-1 text-left" style="color: var(--color-tron-text-secondary)">Fixture</th>
						<th class="px-2 py-1 text-left" style="color: var(--color-tron-text-secondary)">loadName</th>
						<th class="px-2 py-1 text-left" style="color: var(--color-tron-text-secondary)">Status</th>
						<th class="px-2 py-1"></th>
					</tr>
				</thead>
				<tbody>
					{#each tooling.required as t (t.loadName)}
						<tr class="border-b" style="border-color: var(--color-tron-border)">
							<td class="px-2 py-1.5">{t.label}</td>
							<td class="px-2 py-1.5 font-mono">{t.loadName}</td>
							<td class="px-2 py-1.5">
								{#if t.present}
									<span class="text-green-300">In library v{t.version}</span>
								{:else}
									<span class="text-yellow-300">Missing</span>
								{/if}
							</td>
							<td class="px-2 py-1.5 text-right">
								{#if !t.present && t.bundled}
									<form method="POST" action="?/registerBundled" class="inline">
										<input type="hidden" name="loadName" value={t.loadName} />
										<button
											type="submit"
											class="rounded border px-2 py-0.5 text-xs transition-colors hover:opacity-80"
											style="border-color: var(--color-tron-cyan); color: var(--color-tron-cyan)"
										>
											Register bundled JSON
										</button>
									</form>
								{/if}
							</td>
						</tr>
					{/each}
				</tbody>
			</table>

			<!-- Registered project defs -->
			{#if tooling.defs.length > 0}
				<div class="mt-4">
					<h3
						class="text-xs font-bold uppercase tracking-wider"
						style="color: var(--color-tron-text-secondary)"
					>
						Registered definitions
					</h3>
					<table class="mt-1 w-full text-xs">
						<tbody>
							{#each tooling.defs as d (d.id)}
								<tr class="border-b" style="border-color: var(--color-tron-border)">
									<td class="px-2 py-1.5">{d.displayName}</td>
									<td class="px-2 py-1.5 font-mono">{d.namespace}/{d.loadName} v{d.version}</td>
									<td class="px-2 py-1.5" style="color: var(--color-tron-text-secondary)">
										{d.project ?? 'library (untagged)'}
										{#if d.uploadedBy}· {d.uploadedBy}{/if}
									</td>
									<td class="px-2 py-1.5 text-right">
										<form method="POST" action="?/removeTooling" class="inline">
											<input type="hidden" name="id" value={d.id} />
											<button
												type="submit"
												class="text-xs underline transition-colors hover:text-red-400"
												style="color: var(--color-tron-text-secondary)"
											>
												Remove
											</button>
										</form>
									</td>
								</tr>
							{/each}
						</tbody>
					</table>
				</div>
			{/if}

			<!-- Upload new tooling -->
			<form
				method="POST"
				action="?/uploadTooling"
				enctype="multipart/form-data"
				class="mt-4 flex items-center gap-3"
			>
				<input
					type="file"
					name="labwareFile"
					accept=".json,application/json"
					class="text-xs"
					style="color: var(--color-tron-text-secondary)"
				/>
				<button
					type="submit"
					class="rounded border px-3 py-1 text-xs font-bold uppercase tracking-wider transition-colors hover:opacity-80"
					style="border-color: var(--color-tron-cyan); color: var(--color-tron-cyan)"
				>
					Add tooling JSON
				</button>
			</form>
			<p class="mt-1 text-xs" style="color: var(--color-tron-text-secondary)">
				Opentrons labware definition .json — needs <span class="font-mono">namespace</span> +
				<span class="font-mono">parameters.loadName</span>. Re-uploading the same
				name/version replaces it.
			</p>
		{/if}
	</div>
</div>
