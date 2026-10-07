<!--
  Robot board (ROBOT-OVERHAUL, 2026-10-07): every OT-2 on one row of cards,
  with BOTH processes per robot. Each card shows the bridge health, the wax
  run and the reagent run the robot has (or Idle), and the two controls that
  used to sit in the wax-filling and reagent-filling layouts — restart the
  robot server, force the robot back to idle.

  Round 2: the wizards open BELOW this board on the same page, as many at once
  as the operator wants. A robot with a run in progress is always open on that
  process ("Open" just scrolls to it); "Start →" opens an idle robot's wizard
  (?open=<id>:wax|reagent, see $lib/manufacturing/robot-panels) and "Close"
  hides it again. A robot busy with the other process shows a dash.

  Health is polled every 10 s from /api/opentrons-lab/robots/health; run stages
  refresh whenever a wizard action invalidates the page data.
-->
<script lang="ts">
	import { onMount } from 'svelte';
	import { invalidateAll } from '$app/navigation';
	import { page } from '$app/stores';
	import { resolve } from '$app/paths';
	import { openRobotSession } from '$lib/opentrons/direct-client';
	import { restartServerOverBridge } from '$lib/opentrons/fill-bridge-jobs';
	import { parseOpenPanels, panelsHref, panelAnchor, type BoardProcess } from '$lib/manufacturing/robot-panels';
	import type { BoardRun, RobotBoardRow, RobotHealth } from '$lib/server/manufacturing/robot-board';

	interface Props {
		rows: RobotBoardRow[];
		/** Which wizard is open per robot, from the Robots page load. */
		openPanels?: Record<string, BoardProcess>;
	}

	let { rows, openPanels = {} }: Props = $props();

	const processLabel = (p: BoardProcess) => (p === 'wax' ? 'Wax' : 'Reagent');
	const otherProcess = (p: BoardProcess): BoardProcess => (p === 'wax' ? 'reagent' : 'wax');
	// The operator-chosen panels in the URL (robots with runs are open regardless).
	const openMap = $derived(parseOpenPanels($page.url.searchParams.get('open')));

	// --- Robot health (ready / busy / hung / offline) --------------------------
	// Polled from a lightweight endpoint so the dots stay fresh WITHOUT a full
	// invalidateAll (which would reset an operator's in-progress wizard form).
	let liveHealth = $state<Record<string, RobotHealth>>({});
	let now = $state(Date.now());

	function healthFor(row: RobotBoardRow): RobotHealth | null {
		return liveHealth[row.robotId] ?? row.health ?? null;
	}

	function healthDotClass(status?: string | null): string {
		switch (status) {
			case 'ready': return 'bg-green-400';
			case 'busy': return 'bg-amber-400';
			case 'hung': return 'bg-red-500 animate-pulse';
			case 'offline': return 'bg-gray-500';
			default: return 'bg-gray-600';
		}
	}

	function healthTextClass(status?: string | null): string {
		switch (status) {
			case 'ready': return 'text-green-300';
			case 'busy': return 'text-amber-300';
			case 'hung': return 'text-red-300';
			case 'offline': return 'text-gray-400';
			default: return 'text-[var(--color-tron-text-secondary)]';
		}
	}

	async function pollHealth() {
		try {
			const res = await fetch('/api/opentrons-lab/robots/health');
			if (res.ok) {
				const body = await res.json();
				if (body?.health) liveHealth = body.health;
			}
		} catch {
			/* transient — keep last known */
		}
	}

	onMount(() => {
		pollHealth();
		const health = setInterval(pollHealth, 10_000);
		const clock = setInterval(() => { now = Date.now(); }, 30_000);
		return () => {
			clearInterval(health);
			clearInterval(clock);
		};
	});

	// --- Controls: restart server / force reset -----------------------------------
	let busyId = $state<string | null>(null);
	let busyWhat = $state<'restart' | 'reset' | null>(null);
	let messages = $state<Record<string, string>>({});

	function say(robotId: string, text: string) {
		messages = { ...messages, [robotId]: text };
	}

	async function restartServer(row: RobotBoardRow) {
		if (busyId) return;
		if (!confirm(`Restart the robot server on ${row.name}?\n\nThis clears a hung engine (~90s to come back). Any in-progress run on this robot will be cancelled.`)) return;
		busyId = row.robotId;
		busyWhat = 'restart';
		say(row.robotId, '');
		try {
			// Tailnet line (OT2-TAILNET-5 S6): the restart is a daemon job over
			// /bridge (BIMS audits it first). Otherwise the queue POST.
			const session = await openRobotSession(row.robotId);
			try {
				const bridge = session.bridge();
				if (bridge) {
					const r = await restartServerOverBridge(bridge, row.robotId);
					say(row.robotId, r.ok ? r.message : r.error);
					return;
				}
			} finally {
				session.close();
			}
			const res = await fetch(`/api/opentrons-lab/robots/${row.robotId}/restart-server`, { method: 'POST' });
			const body = await res.json().catch(() => ({}));
			say(row.robotId, res.ok ? (body.message ?? 'Restart sent.') : (body.message ?? body.error ?? 'Restart failed.'));
		} catch {
			say(row.robotId, 'Restart request failed — check the bridge.');
		} finally {
			busyId = null;
			busyWhat = null;
			// The dot reflects recovery on the next heartbeat; poll a bit sooner.
			setTimeout(pollHealth, 3000);
		}
	}

	// Master "force reset to idle" — aborts any stale wax/reagent run record that
	// is locking the robot AND best-effort clears the robot's own run state.
	async function forceReset(row: RobotBoardRow) {
		if (busyId) return;
		if (!confirm(`Force ${row.name} back to idle?\n\nThis ABORTS any active wax/reagent run on this robot and clears its run state. Use for stale/stuck runs. Cartridges are left as-is.`)) return;
		busyId = row.robotId;
		busyWhat = 'reset';
		say(row.robotId, '');
		try {
			const res = await fetch(`/api/opentrons-lab/robots/${row.robotId}/force-reset`, { method: 'POST' });
			const body = await res.json().catch(() => ({}));
			say(row.robotId, res.ok ? (body.message ?? 'Reset to idle.') : (body.message ?? body.error ?? 'Reset failed.'));
			if (res.ok) await invalidateAll();
		} catch {
			say(row.robotId, 'Reset request failed — check the bridge.');
		} finally {
			busyId = null;
			busyWhat = null;
			setTimeout(pollHealth, 1500);
		}
	}

	// --- Presentation ----------------------------------------------------------------
	function stageBadgeClass(stage: string | null | undefined): string {
		switch (stage) {
			case 'Setup': return 'bg-blue-900/50 text-blue-300 border border-blue-500/30';
			case 'Loading': return 'bg-purple-900/50 text-purple-300 border border-purple-500/30';
			case 'Running': return 'bg-green-900/50 text-green-300 border border-green-500/30';
			case 'Awaiting Removal':
			case 'Inspection': return 'bg-yellow-900/50 text-yellow-300 border border-yellow-500/30';
			default: return 'bg-[var(--color-tron-surface)] text-[var(--color-tron-text-secondary)] border border-[var(--color-tron-border)]';
		}
	}

	/** Compact "running for" label. */
	function elapsedLabel(iso: string | null): string {
		if (!iso) return '';
		const ms = now - new Date(iso).getTime();
		if (!Number.isFinite(ms) || ms < 0) return '';
		const min = Math.floor(ms / 60000);
		return min < 60 ? `${min}m` : `${Math.floor(min / 60)}h ${min % 60}m`;
	}

	function runDetail(run: BoardRun): string {
		const parts: string[] = [];
		if (run.cartridgeCount > 0) parts.push(`${run.cartridgeCount} cart${run.cartridgeCount === 1 ? '' : 's'}`);
		const el = elapsedLabel(run.startTime);
		if (el) parts.push(el);
		if (run.assayTypeName) parts.push(run.assayTypeName);
		if (run.deckId) parts.push(`deck ${run.deckId}`);
		return parts.join(' · ');
	}

	const toolLink =
		'rounded border border-[var(--color-tron-border)] px-2.5 py-1 text-[var(--color-tron-text-secondary)] transition-colors hover:border-[var(--color-tron-cyan)] hover:text-[var(--color-tron-cyan)]';
</script>

<div class="space-y-3">
	<div class="flex flex-wrap items-end justify-between gap-2">
		<div>
			<h1 class="text-xl font-semibold text-[var(--color-tron-text)]">Robots</h1>
			<p class="mt-0.5 text-xs text-[var(--color-tron-text-secondary)]">
				Every OT-2, wax and reagent, on one page. Open wizards render below, side by side.
			</p>
		</div>
		<nav class="flex flex-wrap items-center gap-1 text-xs" aria-label="Robot tools">
			<a href={resolve('/manufacturing/cart-mfg/robots/history')} class={toolLink}>Run history</a>
			<a href={resolve('/manufacturing/cart-mfg/reagent-filling/well-issues')} class={toolLink}>Well issues</a>
			<a href={resolve('/manufacturing/cart-mfg/reagent-filling/cooling-queue')} class={toolLink}>Cooling queue</a>
			<a href={resolve('/manufacturing/cart-mfg/wax-filling/settings')} class={toolLink}>⚙ Wax params</a>
			<a href={resolve('/manufacturing/cart-mfg/reagent-filling/settings')} class={toolLink}>⚙ Reagent params</a>
		</nav>
	</div>

	{#if rows.length === 0}
		<div class="rounded-lg border border-dashed border-[var(--color-tron-border)] p-6 text-center text-sm text-[var(--color-tron-text-secondary)]">
			No active robots. Add one under Equipment.
		</div>
	{:else}
		<div class="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
			{#each rows as row (row.robotId)}
				{@const h = healthFor(row)}
				{@const isOpen = row.robotId in openPanels}
				{@const isHung = h?.status === 'hung'}
				<section
					class="flex flex-col gap-2.5 rounded-lg border bg-[var(--color-tron-surface)] p-3 transition-colors {isOpen
						? 'border-[var(--color-tron-cyan)] shadow-[0_0_12px_rgba(0,255,255,0.12)]'
						: isHung
							? 'border-red-500/50'
							: 'border-[var(--color-tron-border)]'}"
					aria-label={row.name}
				>
					<!-- Header: health dot, name, side, controls -->
					<div class="flex items-start justify-between gap-2">
						<div class="min-w-0">
							<div class="flex items-center gap-2">
								<span class="h-2.5 w-2.5 shrink-0 rounded-full {healthDotClass(h?.status)}" title={h ? `${h.label}: ${h.detail}` : 'No health data'}></span>
								<h2 class="truncate text-base font-semibold text-[var(--color-tron-text)]">{row.name}</h2>
								{#if row.side}
									<span class="rounded bg-[var(--color-tron-bg)] px-1.5 py-0.5 text-[10px] text-[var(--color-tron-text-secondary)]">{row.side}</span>
								{/if}
							</div>
							<p class="mt-0.5 truncate text-[11px] {healthTextClass(h?.status)}" title={h?.detail ?? ''}>
								{h?.label ?? 'No health data'}{#if h?.detail} <span class="text-[var(--color-tron-text-secondary)]">— {h.detail}</span>{/if}
							</p>
						</div>
						<div class="flex shrink-0 items-center gap-1">
							<button
								type="button"
								onclick={() => restartServer(row)}
								disabled={busyId !== null}
								title="Restart the robot server (clears a hung engine, ~90 s)"
								class="rounded border px-2 py-1 text-[11px] font-medium transition-colors disabled:opacity-50 {isHung
									? 'border-red-500/60 bg-red-900/30 text-red-200 hover:bg-red-900/50'
									: 'border-[var(--color-tron-border)] text-[var(--color-tron-text-secondary)] hover:border-[var(--color-tron-cyan)] hover:text-[var(--color-tron-text)]'}"
							>
								{busyId === row.robotId && busyWhat === 'restart' ? 'Restarting…' : 'Restart'}
							</button>
							<button
								type="button"
								onclick={() => forceReset(row)}
								disabled={busyId !== null}
								title="Abort any stale run and force this robot back to idle"
								class="rounded border border-red-500/40 bg-red-900/15 px-2 py-1 text-[11px] font-medium text-red-300 transition-colors hover:bg-red-900/30 disabled:opacity-50"
							>
								{busyId === row.robotId && busyWhat === 'reset' ? 'Resetting…' : 'Reset'}
							</button>
						</div>
					</div>

					<!-- One row per process -->
					{@render processRow(row, 'wax', row.wax, row.reagent)}
					{@render processRow(row, 'reagent', row.reagent, row.wax)}

					{#if messages[row.robotId]}
						<p class="text-[11px] text-[var(--color-tron-text-secondary)]">{messages[row.robotId]}</p>
					{/if}
				</section>
			{/each}
		</div>
	{/if}
</div>

{#snippet processRow(row: RobotBoardRow, process: BoardProcess, run: BoardRun | null, other: BoardRun | null)}
	{@const isOpen = openPanels[row.robotId] === process}
	{@const blocked = !run && !!other}
	<div
		class="flex items-center gap-2 rounded border px-2.5 py-2 {isOpen
			? 'border-[var(--color-tron-cyan)] bg-[var(--color-tron-cyan)]/10'
			: 'border-[var(--color-tron-border)]/60 bg-[var(--color-tron-bg)]/40'}"
	>
		<span class="w-14 shrink-0 text-xs font-medium text-[var(--color-tron-text)]">{processLabel(process)}</span>
		<span class="shrink-0 rounded px-1.5 py-0.5 text-[11px] {stageBadgeClass(run?.stage)}">{run ? run.stage : 'Idle'}</span>
		<span class="min-w-0 flex-1 truncate text-[11px] text-[var(--color-tron-text-secondary)]">
			{#if run}
				{runDetail(run)}
			{:else if blocked}
				busy with {otherProcess(process)} filling
			{/if}
		</span>
		{#if blocked}
			<span class="shrink-0 text-[11px] text-[var(--color-tron-text-secondary)]" title="This robot is on a {otherProcess(process)} run">—</span>
		{:else if run}
			<!-- A run in progress is always open below; this just scrolls to it. -->
			<a
				href={panelAnchor(row.robotId)}
				class="shrink-0 rounded px-2.5 py-1 text-[11px] font-medium transition-colors {isOpen
					? 'bg-[var(--color-tron-cyan)] text-black'
					: 'border border-amber-500/50 bg-amber-900/20 text-amber-300 hover:bg-amber-900/30'}"
			>
				Open ↓
			</a>
		{:else if isOpen}
			<!-- eslint-disable-next-line svelte/no-navigation-without-resolve -- URL built from the current page -->
			<a
				href={panelsHref(openMap, row.robotId, null)}
				class="shrink-0 rounded border border-[var(--color-tron-cyan)]/60 bg-[var(--color-tron-cyan)]/10 px-2.5 py-1 text-[11px] font-medium text-[var(--color-tron-cyan)] transition-colors hover:bg-[var(--color-tron-cyan)]/20"
				title="Hide this wizard (no run has started)"
			>
				Close
			</a>
		{:else}
			<!-- eslint-disable-next-line svelte/no-navigation-without-resolve -- URL built from the current page -->
			<a
				href={panelsHref(openMap, row.robotId, process)}
				class="shrink-0 rounded border border-[var(--color-tron-cyan)]/40 bg-[var(--color-tron-cyan)]/10 px-2.5 py-1 text-[11px] font-medium text-[var(--color-tron-cyan)] transition-colors hover:bg-[var(--color-tron-cyan)]/20"
			>
				Start →
			</a>
		{/if}
	</div>
{/snippet}
