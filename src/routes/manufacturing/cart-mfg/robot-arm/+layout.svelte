<script lang="ts">
	/**
	 * The Robot Arm page (2026-11 UI redesign).
	 *
	 * Four tabs in the order an operator needs them — Run the wax-fill line,
	 * Teach the arm its moves, Calibrate (arm home by camera, the OT-2 stage),
	 * History — plus a small Maintenance link for the leader-arm tools, the
	 * Pi's recordings, jog, sync zero and the conveyor bench test, which the
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
		},
		{
			href: `${BASE}/history`,
			label: 'History',
			hint: 'Wax-fill runs and arm sessions',
			icon: 'M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z'
		}
	];
	const maintenanceHref = `${BASE}/maintenance`;

	let currentPath = $derived($page.url.pathname);
	let maintActive = $derived(currentPath.startsWith(maintenanceHref));
	let activeLabel = $derived(
		tabs.find((t) => currentPath.startsWith(t.href))?.label ?? (maintActive ? 'Maintenance' : 'Run')
	);

	// dry_run.ok is always true — dry-run vs live is a config choice, not a
	// fault — so the state worth showing is `value`.
	let dryRun = $derived(data.arm.preflight?.checks?.dry_run?.value ?? null);
	let version = $derived(data.arm.preflight?.version ?? null);
</script>

<div class="space-y-4">
	<!-- Breadcrumb -->
	<nav class="flex items-center gap-2 text-sm">
		<a
			href="/manufacturing/cart-mfg"
			class="transition-colors hover:text-[var(--color-tron-cyan)]"
			style="color: var(--color-tron-text-secondary)">Cart Mfg</a
		>
		<span style="color: var(--color-tron-text-secondary)">/</span>
		<a
			href={`${BASE}/run`}
			class="transition-colors hover:text-[var(--color-tron-cyan)]"
			style="color: var(--color-tron-text-secondary)">Robot Arm</a
		>
		<span style="color: var(--color-tron-text-secondary)">/</span>
		<span style="color: var(--color-tron-cyan)">{activeLabel}</span>
	</nav>

	<div class="flex flex-wrap items-center justify-between gap-4">
		<h1 class="text-2xl font-bold" style="color: var(--color-tron-cyan)">Robot Arm</h1>

		<!-- Headline facts only; the status card in the rail has the rest. -->
		<div class="flex items-center gap-3 text-xs">
			{#if data.arm.reachable}
				<span class="flex items-center gap-1.5">
					<span class="h-2 w-2 rounded-full bg-green-500"></span>
					<span style="color: var(--color-tron-text-secondary)">
						Arm reachable{#if version} · v{version}{/if}
					</span>
				</span>
				{#if dryRun === true}
					<span class="rounded border border-amber-500/50 bg-amber-500/10 px-2 py-0.5 text-amber-300">
						DRY RUN
					</span>
				{:else if dryRun === false}
					<span class="rounded border border-red-500/50 bg-red-500/10 px-2 py-0.5 text-red-300">
						LIVE MOTION
					</span>
				{/if}
			{:else}
				<span class="flex items-center gap-1.5">
					<span class="h-2 w-2 rounded-full bg-red-500"></span>
					<span class="text-red-400">Arm unreachable</span>
				</span>
			{/if}
		</div>
	</div>

	{#if !data.arm.reachable && data.arm.error}
		<div class="rounded-lg border border-red-500/40 bg-red-500/10 p-3 text-xs">
			<p class="text-red-300">Cannot reach the robot-arm Pi: {data.arm.error}</p>
			<p class="mt-1" style="color: var(--color-tron-text-secondary)">
				Check <code>ROBOT_ARM_BASE_URL</code> and <code>ROBOT_ARM_API_KEY</code>. History still
				works — it reads from BIMS, not the arm.
			</p>
		</div>
	{/if}

	<!-- Tab strip: four tabs left, Maintenance tucked right. -->
	<div class="flex flex-wrap items-center gap-2 border-b pb-3" style="border-color: var(--color-tron-border)">
		{#each tabs as tab (tab.href)}
			{@const active = currentPath.startsWith(tab.href)}
			<a
				href={tab.href}
				title={tab.hint}
				class="flex items-center gap-2 rounded-lg px-4 py-2 text-sm font-medium transition-all duration-200
					{active
					? 'bg-[var(--color-tron-cyan)] text-[var(--color-tron-bg-primary)]'
					: 'text-[var(--color-tron-text-secondary)] hover:bg-[var(--color-tron-bg-tertiary)] hover:text-[var(--color-tron-cyan)]'}"
				aria-current={active ? 'page' : undefined}
			>
				<svg class="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
					<path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d={tab.icon} />
				</svg>
				{tab.label}
			</a>
		{/each}
		<span class="grow"></span>
		<a
			href={maintenanceHref}
			title="Leader arm, Pi recordings, jog, sync zero, clean-up, conveyor bench test"
			class="rounded-lg px-3 py-1.5 text-xs transition-colors
				{maintActive
				? 'bg-[var(--color-tron-bg-tertiary)] text-[var(--color-tron-cyan)]'
				: 'text-[var(--color-tron-text-secondary)] hover:text-[var(--color-tron-cyan)]'}"
			aria-current={maintActive ? 'page' : undefined}
		>
			Maintenance
		</a>
	</div>

	<!--
		Status card and camera are a right rail on wide screens so they are
		co-visible with the controls. Below 1280px they stack above the tab
		content. Never a modal.
	-->
	<div class="grid grid-cols-1 gap-4 xl:grid-cols-[minmax(0,1fr)_380px]">
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
