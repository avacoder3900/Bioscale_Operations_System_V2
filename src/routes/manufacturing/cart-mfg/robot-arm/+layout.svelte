<script lang="ts">
	/**
	 * The Robot Arm page (2026-11 UI redesign).
	 *
	 * Three tabs in the order an operator needs them — Run the wax-fill line,
	 * Teach the arm its moves, Calibrate (arm home by camera, the OT-2 stage) —
	 * History is its own page behind a button at the bottom of Run — plus a small Maintenance link for the leader-arm tools, the
	 * Pi's recordings, jog and sync zero, which the
	 * line no longer needs day to day.
	 *
	 * This is a real +layout.svelte rather than client-side tab state: the
	 * child pages own dozens of named form actions that would collide in one
	 * actions object, and each tab keeps its own load. The camera and the
	 * status card live here, so the feed is not torn down on every tab change
	 * and torque / Return to home / Stop arm are reachable from anywhere.
	 */
	import type { Snippet } from 'svelte';
	import { page } from '$app/stores';
	import RobotArmCameraPanel from '$lib/components/RobotArmCameraPanel.svelte';
	import RobotArmConnectionPanel from '$lib/components/RobotArmConnectionPanel.svelte';
	import type { CameraStatus, ArmPreflight, ArmThermal } from '$lib/server/robot-arm-client';

	interface Props {
		children: Snippet;
		data: {
			arm: {
				reachable: boolean;
				preflight: ArmPreflight | null;
				error: string | null;
				baseUrl: string | null;
				/** ISO timestamp of the most recent successful reach, from the connection log. */
				lastConnected: string | null;
			};
			cameras: CameraStatus[];
			camerasError: string | null;
			/** Pi heat / throttle state at load (null: unreachable or route not installed). */
			thermal: ArmThermal | null;
		};
	}

	let { children, data }: Props = $props();

	const BASE = '/manufacturing/cart-mfg/robot-arm';

	const tabs = [
		{
			href: `${BASE}/run`,
			label: 'Run',
			hint: 'The wax-fill line: start, watch and stop a run',
			icon: 'M5 4l10 8-10 8V4z'
		},
		{
			href: `${BASE}/teach`,
			label: 'Teach',
			hint: 'Poses, move sets and sequences the arm plays',
			icon: 'M12 20h9M16.5 3.5a2.1 2.1 0 013 3L7 19l-4 1 1-4L16.5 3.5z'
		},
		{
			href: `${BASE}/calibrate`,
			label: 'Calibrate',
			hint: 'Arm home by camera · the OT-2 stage',
			icon: 'M12 3v3m0 12v3M3 12h3m12 0h3m-3 0a6 6 0 11-12 0 6 6 0 0112 0z'
		}
	];
	const maintenanceHref = `${BASE}/maintenance`;

	let currentPath = $derived($page.url.pathname);
	let maintActive = $derived(currentPath.startsWith(maintenanceHref));

	// dry_run.ok is always true — dry-run vs live is a config choice, not a
	// fault — so the state worth showing is `value`.
	let dryRun = $derived(data.arm.preflight?.checks?.dry_run?.value ?? null);
</script>

<div class="space-y-2">
	<!-- One chrome row (2026-11-04): crumb + title, the tabs, then arm state and Maintenance on the right. -->
	<div class="flex flex-wrap items-center gap-1 border-b pb-1.5" style="border-color: var(--color-tron-border)">
		<div class="mr-2 flex min-w-0 items-center gap-1.5 text-xs">
			<a
				href="/manufacturing/cart-mfg"
				class="transition-colors hover:text-[var(--color-tron-cyan)]"
				style="color: var(--color-tron-text-secondary)">Cart Mfg</a
			>
			<span style="color: var(--color-tron-text-secondary)">/</span>
			<h1 class="text-sm font-bold" style="color: var(--color-tron-cyan)">Robot Arm</h1>
		</div>
		{#each tabs as tab (tab.href)}
			{@const active = currentPath.startsWith(tab.href)}
			<a
				href={tab.href}
				title={tab.hint}
				class="flex items-center gap-1.5 rounded-md px-2.5 py-1 text-xs font-medium transition-all duration-200
					{active
					? 'bg-[var(--color-tron-cyan)] text-[var(--color-tron-bg-primary)]'
					: 'text-[var(--color-tron-text-secondary)] hover:bg-[var(--color-tron-bg-tertiary)] hover:text-[var(--color-tron-cyan)]'}"
				aria-current={active ? 'page' : undefined}
			>
				<svg class="h-3.5 w-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
					<path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d={tab.icon} />
				</svg>
				{tab.label}
			</a>
		{/each}
		<span class="grow"></span>
		<span class="flex items-center gap-2 text-[11px]">
			{#if data.arm.reachable}
				{#if dryRun === true}
					<span class="rounded border border-amber-500/50 bg-amber-500/10 px-1.5 py-px text-amber-300">
						DRY RUN
					</span>
				{/if}
			{:else}
				<span class="flex items-center gap-1.5">
					<span class="h-2 w-2 rounded-full bg-red-500"></span>
					<span class="text-red-400">Arm Unreachable</span>
				</span>
			{/if}
		</span>
		<a
			href={maintenanceHref}
			title="Leader arm, Pi recordings, jog, sync zero, clean-up"
			class="rounded-md px-2 py-1 text-[11px] transition-colors
				{maintActive
				? 'bg-[var(--color-tron-bg-tertiary)] text-[var(--color-tron-cyan)]'
				: 'text-[var(--color-tron-text-secondary)] hover:text-[var(--color-tron-cyan)]'}"
			aria-current={maintActive ? 'page' : undefined}
		>
			Maintenance
		</a>
	</div>

	{#if !data.arm.reachable && data.arm.error}
		<div class="rounded-lg border border-red-500/40 bg-red-500/10 px-3 py-1.5 text-xs">
			<p class="text-red-300">Cannot reach the robot-arm Pi: {data.arm.error}</p>
		</div>
	{/if}

	<!--
		Status card and camera are a right rail on wide screens so they are
		co-visible with the controls. Below 1280px they stack above the tab
		content. Never a modal.
	-->
	<div class="grid grid-cols-1 gap-3 xl:grid-cols-[minmax(0,1fr)_380px]">
		<div class="min-w-0 xl:order-1">
			{@render children()}
		</div>
		<div class="xl:order-2">
			<div class="space-y-4 xl:sticky xl:top-4">
				<RobotArmConnectionPanel
					preflight={data.arm.preflight}
					preflightError={data.arm.error}
					baseUrl={data.arm.baseUrl}
					lastConnected={data.arm.lastConnected}
					armReachable={data.arm.reachable}
					thermal={data.thermal}
				/>
				<RobotArmCameraPanel
					cameras={data.cameras}
					camerasError={data.camerasError}
					armReachable={data.arm.reachable}
				/>
			</div>
		</div>
	</div>
</div>
