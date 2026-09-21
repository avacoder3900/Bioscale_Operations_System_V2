<script lang="ts">
	// ARM-01 §8.1 — arm connection health.
	//
	// Renders the Pi's own preflight verdict rather than re-deriving it here.
	// The Pi's `diagnosis` string already names the concrete fix ("Update
	// LEADER_PORT=... and restart the server"); re-implementing that logic in
	// TypeScript would guarantee the two drift.
	import { invalidateAll } from '$app/navigation';

	interface PreflightCheck {
		ok: boolean;
		detail: string;
		configured?: string;
		value?: boolean;
	}
	interface Candidate {
		port: string;
		serial_number: string;
		expected_role: string | null;
	}
	interface Preflight {
		ok: boolean;
		service: string;
		version: string;
		checks: Record<string, PreflightCheck | undefined>;
		candidates?: Candidate[];
		diagnosis?: string;
	}

	let {
		preflight = null,
		preflightError = null,
		baseUrl = null,
		lastConnected = null,
		variant = 'full'
	}: {
		preflight?: Preflight | null;
		preflightError?: string | null;
		baseUrl?: string | null;
		/** ISO timestamp of the most recent SUCCESSFUL reach, from the connection log. */
		lastConnected?: string | null;
		/**
		 * 'full' is the desktop side panel; 'compact' is the single status line
		 * shown under the page title on narrow screens. Both are driven by the
		 * same derived state below so they can never disagree.
		 */
		variant?: 'full' | 'compact';
	} = $props();

	let refreshing = $state(false);

	const reachable = $derived(preflight !== null);
	const dryRun = $derived(preflight?.checks?.dry_run?.value);
	// dry_run.ok is always true on the Pi (it's a config choice, not a fault),
	// so liveMotion keys off the value and treats "unknown" as not-live.
	const liveMotion = $derived(reachable && dryRun === false);

	// NB: do not name this `state` — `$state` would then parse as a store
	// subscription rather than the rune, and svelte-check rejects it.
	const panelState = $derived(!reachable ? 'unreachable' : preflight?.ok ? 'ok' : 'degraded');
	const dotColor = $derived(
		panelState === 'ok' ? '#22c55e' : panelState === 'degraded' ? '#f59e0b' : '#ef4444'
	);
	const label = $derived(
		panelState === 'ok' ? 'ONLINE' : panelState === 'degraded' ? 'NEEDS ATTENTION' : 'UNREACHABLE'
	);

	const portRows = $derived(
		(['leader_port', 'follower_port'] as const)
			.map((k) => ({ key: k, label: k === 'leader_port' ? 'Leader' : 'Follower', check: preflight?.checks?.[k] }))
			.filter((r) => r.check)
	);

	// Mirrors the CV station list's relativeTime() so "last seen" reads the same
	// way across the two device fleets.
	function relativeTime(iso: string | null): string {
		if (!iso) return 'never';
		const ms = Date.now() - new Date(iso).getTime();
		if (Number.isNaN(ms) || ms < 0) return 'just now';
		const secs = Math.floor(ms / 1000);
		if (secs < 60) return `${secs}s ago`;
		const mins = Math.floor(secs / 60);
		if (mins < 60) return `${mins}m ago`;
		const hrs = Math.floor(mins / 60);
		if (hrs < 24) return `${hrs}h ago`;
		return `${Math.floor(hrs / 24)}d ago`;
	}

	async function refresh() {
		refreshing = true;
		try {
			await invalidateAll();
		} finally {
			refreshing = false;
		}
	}
</script>

{#if variant === 'compact'}
	<!--
		Narrow screens only. The full panel is a lot of vertical space to spend
		before the controls, so phones get the verdict on one line instead.
	-->
	<div
		class="flex flex-wrap items-center gap-x-3 gap-y-1 rounded border px-3 py-2"
		style="border-color: var(--color-tron-border); background: var(--color-tron-surface);"
	>
		<span class="inline-flex items-center gap-2 text-xs" style="color: var(--color-tron-text)">
			<span class="inline-block h-2 w-2 rounded-full" style="background: {dotColor}"></span>
			{label}
		</span>

		{#if liveMotion}
			<span
				class="rounded px-1.5 py-0.5 text-[10px] font-semibold"
				style="background: rgba(239,68,68,0.15); color: #ef4444;"
			>
				⚠ LIVE MOTION
			</span>
		{:else if dryRun === true}
			<span
				class="rounded px-1.5 py-0.5 text-[10px] font-semibold"
				style="background: rgba(34,197,94,0.15); color: #22c55e;"
			>
				DRY RUN
			</span>
		{/if}

		<span class="text-[10px]" style="color: var(--color-tron-text-secondary)">
			last connected {relativeTime(lastConnected)}
		</span>
	</div>
{:else}
	<section
		class="rounded border p-3 sm:p-4"
		style="border-color: var(--color-tron-border); background: var(--color-tron-surface);"
	>
	<div class="flex flex-wrap items-center justify-between gap-2">
		<h2 class="text-sm font-semibold tracking-wide" style="color: var(--color-tron-text)">
			ARM CONNECTION
		</h2>
		<button
			type="button"
			onclick={refresh}
			disabled={refreshing}
			class="min-h-[44px] rounded border px-3 text-xs disabled:opacity-50"
			style="border-color: var(--color-tron-border); color: var(--color-tron-text-secondary)"
		>
			{refreshing ? 'Refreshing…' : 'Refresh'}
		</button>
	</div>

	<div class="mt-3 flex flex-wrap items-center gap-x-3 gap-y-2">
		<span class="inline-flex items-center gap-2 text-sm" style="color: var(--color-tron-text)">
			<span class="inline-block h-2.5 w-2.5 rounded-full" style="background: {dotColor}"></span>
			{label}
		</span>

		{#if reachable}
			<span class="text-xs" style="color: var(--color-tron-text-secondary)">
				{preflight?.service} v{preflight?.version}
			</span>

			{#if dryRun === true}
				<span
					class="rounded px-2 py-0.5 text-xs font-semibold"
					style="background: rgba(34,197,94,0.15); color: #22c55e;"
				>
					DRY RUN
				</span>
			{:else if liveMotion}
				<span
					class="rounded px-2 py-0.5 text-xs font-semibold"
					style="background: rgba(239,68,68,0.15); color: #ef4444;"
				>
					⚠ LIVE MOTION
				</span>
			{/if}
		{/if}
	</div>

	{#if baseUrl}
		<p class="mt-1 break-all text-xs" style="color: var(--color-tron-text-secondary)">
			{baseUrl}
		</p>
	{/if}

	{#if !reachable}
		<div
			class="mt-3 rounded border p-2 text-xs"
			style="border-color: #ef4444; background: rgba(239,68,68,0.08); color: var(--color-tron-text)"
		>
			<p class="font-semibold">Cannot reach the robot arm.</p>
			<p class="mt-1 break-all" style="color: var(--color-tron-text-secondary)">
				{preflightError}
			</p>
			<p class="mt-1" style="color: var(--color-tron-text-secondary)">
				Check ROBOT_ARM_BASE_URL and ROBOT_ARM_API_KEY, and that the robot-arm service is running
				on the Pi.
			</p>
		</div>
	{:else}
		<!-- Stacked label/value on phones, two-column from sm up. -->
		<dl class="mt-3 grid grid-cols-1 gap-x-6 gap-y-2 sm:grid-cols-2">
			{#each portRows as row (row.key)}
				<div class="flex items-start justify-between gap-2 sm:justify-start">
					<dt class="text-xs" style="color: var(--color-tron-text-secondary)">{row.label}</dt>
					<dd class="text-right text-xs sm:text-left" style="color: var(--color-tron-text)">
						<span style="color: {row.check?.ok ? '#22c55e' : '#ef4444'}">
							{row.check?.ok ? '✓' : '✗'}
						</span>
						<span class="ml-1 break-all">{row.check?.configured ?? '—'}</span>
					</dd>
				</div>
			{/each}
		</dl>

		{#if preflight?.candidates?.length}
			<div class="mt-3">
				<p class="text-xs font-semibold" style="color: var(--color-tron-text-secondary)">
					Detected boards
				</p>
				<ul class="mt-1 space-y-1">
					{#each preflight.candidates as c (c.port)}
						<li class="break-all text-xs" style="color: var(--color-tron-text-secondary)">
							{c.port} · {c.serial_number}{c.expected_role ? ` · ${c.expected_role}` : ''}
						</li>
					{/each}
				</ul>
			</div>
		{/if}

		{#if !preflight?.ok && preflight?.diagnosis}
			<div
				class="mt-3 rounded border p-2 text-xs"
				style="border-color: #f59e0b; background: rgba(245,158,11,0.08); color: var(--color-tron-text)"
			>
				⚠ {preflight.diagnosis}
			</div>
		{/if}
	{/if}

	<!--
		Sourced from the persisted connection log, not from this render — so it
		still answers "when did this last work?" while the arm is down.
	-->
	<p
		class="mt-3 border-t pt-2 text-xs"
		style="border-color: var(--color-tron-border); color: var(--color-tron-text-secondary)"
	>
		Last connected <span style="color: var(--color-tron-text)">{relativeTime(lastConnected)}</span>
	</p>
	</section>
{/if}
