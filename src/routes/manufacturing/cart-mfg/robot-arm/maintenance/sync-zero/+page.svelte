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
				return 'Offset Only (1 Pose)';
			case 'insufficient_range':
				return 'Mirroring: Range Too Small';
			case 'implausible_scale':
				return 'Mirroring: Slope Rejected';
			case 'no_fit':
				return 'No Data';
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
</script>

<div class="mx-auto max-w-5xl space-y-6 p-4">
	<div class="flex items-center justify-between">
		<h1 class="text-base font-semibold" style="color: var(--color-tron-cyan)">
			Sync Zero
		</h1>
		<a
			href="/manufacturing/cart-mfg/robot-arm/maintenance"
			class="rounded border border-[var(--color-tron-border)] px-3 py-1.5 text-xs font-medium transition-colors hover:border-[var(--color-tron-cyan)] hover:text-[var(--color-tron-cyan)]"
			style="color: var(--color-tron-text)"
		>
			← Maintenance
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
				<a href="/manufacturing/cart-mfg/robot-arm/maintenance/control" class="underline">Control Page</a>
				before capturing.
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
			<p class="font-medium text-red-400">Cannot Reach Robot-Arm Server</p>
			<p class="mt-1 text-xs" style="color: var(--color-tron-text-secondary)">{errorMsg}</p>
		</div>
	{/if}

	<!-- What is sync zero — short explainer -->

	<!-- Saved zero status -->
	<div
		class="rounded-lg border border-[var(--color-tron-border)] bg-[var(--color-tron-surface)] p-4"
	>
		<h2 class="text-sm font-semibold uppercase tracking-wider" style="color: var(--color-tron-text-secondary)">
			Saved Zero
		</h2>
		{#if saved}
			<dl class="mt-2 grid grid-cols-2 gap-x-6 gap-y-1 text-sm">
				<dt style="color: var(--color-tron-text-secondary)">Captured At</dt>
				<dd class="font-mono" style="color: var(--color-tron-text)">
					{fmtDate(saved.captured_at)}
				</dd>
				<dt style="color: var(--color-tron-text-secondary)">Captured By</dt>
				<dd style="color: var(--color-tron-text)">
					{saved.captured_by?.username ?? 'Unknown'}
				</dd>
				<dt style="color: var(--color-tron-text-secondary)">Version</dt>
				<dd class="font-mono" style="color: var(--color-tron-text)">{saved.version}</dd>
			</dl>
		{:else}
			<p class="mt-2 text-sm" style="color: var(--color-tron-text-secondary)">
				No Sync Zero Saved
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
				Live Positions
			</h2>
			<table class="w-full text-sm">
				<thead class="text-xs" style="color: var(--color-tron-text-secondary)">
					<tr class="border-b border-[var(--color-tron-border)]">
						<th class="px-3 py-2 text-left">Joint</th>
						<th class="px-3 py-2 text-right">Leader Saved</th>
						<th class="px-3 py-2 text-right">Leader Live</th>
						<th class="px-3 py-2 text-right">Δ</th>
						<th class="px-3 py-2 text-right">Follower Saved</th>
						<th class="px-3 py-2 text-right">Follower Live</th>
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
		</div>
	{/if}

	<!-- Capture button -->
	<div
		class="rounded-xl border-2 border-[var(--color-tron-cyan)]/40 bg-[var(--color-tron-surface)] p-6 text-center"
	>
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
				Disabled: Session Active
			</p>
		{/if}
	</div>

	<!-- ================= Multi-pose joint map ================= -->
	<div
		class="space-y-4 rounded-xl border-2 border-[var(--color-tron-cyan)]/40 bg-[var(--color-tron-surface)] p-6"
	>
		<div class="flex items-center justify-between">
			<h2 class="text-lg font-bold" style="color: var(--color-tron-cyan)">
				Multi-Pose Joint Map
			</h2>
			<span class="text-xs uppercase tracking-widest" style="color: var(--color-tron-text-secondary)">
				{poses.length} Pose{poses.length === 1 ? '' : 's'} · {calibratedCount}/{mapJointNames.length}
				Joints Fitted
			</span>
		</div>

		{#if mapError}
			<div class="rounded-lg border-2 border-yellow-500/60 bg-yellow-900/20 p-3">
				<p class="text-xs text-yellow-300">Live Read Unavailable: {mapError}</p>
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
			{#if data.active}
				<p class="mt-2 text-xs text-yellow-400">
					Disabled: Session Active
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
					Fit — {fit.n_poses} Pose{fit.n_poses === 1 ? '' : 's'}, Fitted {fmtDate(fit.fitted_at)}
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
								>Max Resid.</th
							>
							{#if mapLive}
								<th
									class="py-1 text-right font-normal"
									style="color: var(--color-tron-text-secondary)">Tracking Err.</th
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
			</div>
		{:else if hostUnreachable}
			<p class="text-sm text-yellow-300">
				Calibration State Unknown: Host Unreachable
			</p>
		{:else}
			<p class="text-sm" style="color: var(--color-tron-text-secondary)">
				No Joint Map Saved
			</p>
		{/if}

		<!-- Captured poses -->
		{#if poses.length > 0}
			<div>
				<h3
					class="mb-2 text-xs uppercase tracking-widest"
					style="color: var(--color-tron-text-secondary)"
				>
					Captured Poses
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
					Clear Joint Map
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
				Clear Saved Sync Zero
			</button>
		</form>
	{/if}
</div>
