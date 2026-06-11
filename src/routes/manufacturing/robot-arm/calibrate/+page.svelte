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
</script>

<div class="mx-auto max-w-5xl space-y-6 p-4">
	<div class="flex items-center justify-between">
		<h1 class="text-2xl font-bold" style="color: var(--color-tron-cyan)">
			Robot Arm — Sync Zero Calibration
		</h1>
		<a
			href="/manufacturing/robot-arm"
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
				<a href="/manufacturing/robot-arm/control" class="underline">control page</a>
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
</div>
