<script lang="ts">
	/**
	 * The arm's status card — the one place for "is the arm up, is it holding,
	 * send it home, stop it" on every Robot Arm tab (2026-11 UI redesign).
	 *
	 * Top: the Pi's preflight verdict (rendered, not re-derived: the Pi's
	 * `diagnosis` string already names the concrete fix, and re-implementing
	 * that in TypeScript would guarantee the two drift), then the always-on
	 * rows — Pi heat / Wi-Fi + servo temperatures, Torque, Return to home,
	 * Stop arm. Connection details (ports, boards, base URL, last connected)
	 * fold away under a disclosure since they only matter when something is
	 * wrong.
	 */
	import { invalidateAll } from '$app/navigation';
	import type { ArmThermal } from '$lib/server/robot-arm-client';
	import PiThermalChip from './robot-arm/PiThermalChip.svelte';
	import ReturnHomeControl from './robot-arm/ReturnHomeControl.svelte';
	import StopArmControl from './robot-arm/StopArmControl.svelte';
	import TorqueControl from './robot-arm/TorqueControl.svelte';

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
		armReachable = false,
		thermal = null
	}: {
		preflight?: Preflight | null;
		preflightError?: string | null;
		baseUrl?: string | null;
		/** ISO timestamp of the most recent SUCCESSFUL reach, from the connection log. */
		lastConnected?: string | null;
		armReachable?: boolean;
		/** The Pi's temperature / throttle state at page load; the chip polls from there. */
		thermal?: ArmThermal | null;
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

<section
	class="rounded border p-3 sm:p-4"
	style="border-color: var(--color-tron-border); background: var(--color-tron-surface);"
>
	<div class="flex flex-wrap items-center justify-between gap-2">
		<h2
			class="inline-flex items-center gap-2 text-sm font-semibold tracking-wide"
			style="color: var(--color-tron-text)"
		>
			<span class="inline-block h-2.5 w-2.5 rounded-full" style="background: {dotColor}" title={label}></span>
			ARM
			<span class="text-xs font-normal" style="color: {dotColor}">{label}</span>
			{#if dryRun === true}
				<span class="rounded px-1.5 py-0.5 text-[10px] font-semibold" style="background: rgba(34,197,94,0.15); color: #22c55e;">DRY RUN</span>
			{:else if liveMotion}
				<span class="rounded px-1.5 py-0.5 text-[10px] font-semibold" style="background: rgba(239,68,68,0.15); color: #ef4444;">⚠ LIVE MOTION</span>
			{/if}
		</h2>
		<button
			type="button"
			onclick={refresh}
			disabled={refreshing}
			class="min-h-[36px] rounded border px-3 text-xs disabled:opacity-50"
			style="border-color: var(--color-tron-border); color: var(--color-tron-text-secondary)"
		>
			{refreshing ? 'Refreshing…' : 'Refresh'}
		</button>
	</div>

	{#if !reachable}
		<div
			class="mt-2 rounded border p-2 text-xs"
			style="border-color: #ef4444; background: rgba(239,68,68,0.08); color: var(--color-tron-text)"
		>
			<p class="font-semibold">Cannot reach the robot arm.</p>
			<p class="mt-1 break-all" style="color: var(--color-tron-text-secondary)">
				{preflightError}
			</p>
			<p class="mt-1" style="color: var(--color-tron-text-secondary)">
				Check ROBOT_ARM_BASE_URL and ROBOT_ARM_API_KEY, and that the robot-arm service is running
				on the Pi. Last connected {relativeTime(lastConnected)}.
			</p>
		</div>
	{:else if !preflight?.ok && preflight?.diagnosis}
		<div
			class="mt-2 rounded border p-2 text-xs"
			style="border-color: #f59e0b; background: rgba(245,158,11,0.08); color: var(--color-tron-text)"
		>
			⚠ {preflight.diagnosis}
		</div>
	{/if}

	<!-- Always visible: Pi heat + Wi-Fi, servo temperatures, Torque, Return to home, Stop arm. -->
	<div class="mt-2 space-y-1.5">
		<PiThermalChip initial={thermal} {armReachable} />
	</div>
	<div class="-mx-3 mt-2 sm:-mx-4">
		<TorqueControl {armReachable} />
		<ReturnHomeControl {armReachable} />
		<StopArmControl {armReachable} />
	</div>

	{#if reachable}
		<details class="-mx-3 border-t px-3 pt-2 text-xs sm:-mx-4 sm:px-4" style="border-color: var(--color-tron-border); color: var(--color-tron-text-secondary)">
			<summary class="cursor-pointer">
				Connection details · {preflight?.service} v{preflight?.version} · last connected {relativeTime(lastConnected)}
			</summary>
			{#if baseUrl}
				<p class="mt-2 break-all">{baseUrl}</p>
			{/if}
			<!-- Stacked label/value on phones, two-column from sm up. -->
			<dl class="mt-2 grid grid-cols-1 gap-x-6 gap-y-1 sm:grid-cols-2">
				{#each portRows as row (row.key)}
					<div class="flex items-start justify-between gap-2 sm:justify-start">
						<dt>{row.label}</dt>
						<dd class="text-right sm:text-left" style="color: var(--color-tron-text)">
							<span style="color: {row.check?.ok ? '#22c55e' : '#ef4444'}">
								{row.check?.ok ? '✓' : '✗'}
							</span>
							<span class="ml-1 break-all">{row.check?.configured ?? '—'}</span>
						</dd>
					</div>
				{/each}
			</dl>
			{#if preflight?.candidates?.length}
				<p class="mt-2 font-semibold">Detected boards</p>
				<ul class="mt-1 space-y-1">
					{#each preflight.candidates as c (c.port)}
						<li class="break-all">{c.port} · {c.serial_number}{c.expected_role ? ` · ${c.expected_role}` : ''}</li>
					{/each}
				</ul>
			{/if}
		</details>
	{/if}
</section>
