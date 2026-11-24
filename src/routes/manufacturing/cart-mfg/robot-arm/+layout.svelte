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

	// Text sizes for the Robot Arm page. Every font size on Run, the tab bar and the
	// Status rail uses one of these through var(--arm-text-<name>); change a size here.
	// The comment after each is the size it replaced (2026-11-24).
	const TEXT_SIZES = {
		micro: '11px', // 9px
		tiny: '12px', // 10px
		small: '13px', // 11px
		body: '16px', // 12px, text-xs
		label: '16px', // 14px, text-sm
		title: '18px' // 16px, text-base
	};
	const textSizeStyle = Object.entries(TEXT_SIZES)
		.map(([name, size]) => `--arm-text-${name}: ${size}`)
		.join('; ');

	// Status shows or removes the Arm status card and the Arm Camera panel. Removing
	// unmounts them, so the camera feed stops too. Per-browser view choice.
	const STATUS_KEY = 'robot-arm-info-visible';
	let statusVisible = $state(true);
	$effect(() => {
		try {
			const saved = localStorage.getItem(STATUS_KEY);
			if (saved !== null) statusVisible = saved === '1';
		} catch {
			/* storage blocked: keep the default */
		}
	});
	function toggleStatus() {
		statusVisible = !statusVisible;
		try {
			localStorage.setItem(STATUS_KEY, statusVisible ? '1' : '0');
		} catch {
			/* storage blocked: the choice lasts until reload */
		}
	}
</script>

<div class="arm-page space-y-2" style={textSizeStyle}>
	<!-- One chrome row (2026-11-04): crumb + title, the tabs, then arm state and Maintenance on the right. -->
	<div class="flex flex-wrap items-center gap-1 border-b pb-1.5" style="border-color: var(--color-tron-border)">
		<div class="mr-2 flex min-w-0 items-center gap-1.5 text-[length:var(--arm-text-body)]">
			<a
				href="/manufacturing/cart-mfg"
				class="transition-colors hover:text-[var(--color-tron-cyan)]"
				style="color: var(--color-tron-text-secondary)">Cart Mfg</a
			>
			<span style="color: var(--color-tron-text-secondary)">/</span>
			<h1 class="text-[length:var(--arm-text-label)] font-bold" style="color: var(--color-tron-cyan)">Robot Arm</h1>
		</div>
		{#each tabs as tab (tab.href)}
			{@const active = currentPath.startsWith(tab.href)}
			<a
				href={tab.href}
				title={tab.hint}
				class="flex items-center gap-1.5 rounded-md px-2.5 py-1 text-[length:var(--arm-text-body)] font-medium transition-all duration-200
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
		<span class="flex items-center gap-2 text-[length:var(--arm-text-small)]">
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
			class="flex items-center gap-1.5 rounded-md px-2.5 py-1 text-[length:var(--arm-text-body)] font-medium transition-all duration-200
				{maintActive
				? 'bg-[var(--color-tron-cyan)] text-[var(--color-tron-bg-primary)]'
				: 'text-[var(--color-tron-text-secondary)] hover:bg-[var(--color-tron-bg-tertiary)] hover:text-[var(--color-tron-cyan)]'}"
			aria-current={maintActive ? 'page' : undefined}
		>
			<svg class="h-3.5 w-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
				<path
					stroke-linecap="round"
					stroke-linejoin="round"
					stroke-width="2"
					d="M21.75 6.75a4.5 4.5 0 01-4.884 4.484c-1.076-.091-2.264.071-2.95.904l-7.152 8.684a2.548 2.548 0 11-3.586-3.586l8.684-7.152c.833-.686.995-1.874.904-2.95a4.5 4.5 0 016.336-4.486l-3.276 3.276a3.004 3.004 0 002.25 2.25l3.276-3.276c.256.565.398 1.192.398 1.852z"
				/>
			</svg>
			Maintenance
		</a>
		<button
			type="button"
			onclick={toggleStatus}
			title={statusVisible ? 'Hide Status' : 'Show Status'}
			aria-pressed={statusVisible}
			class="flex cursor-pointer items-center gap-1.5 rounded-md px-2.5 py-1 text-[length:var(--arm-text-body)] font-medium transition-all duration-200
				{statusVisible
				? 'bg-[var(--color-tron-bg-tertiary)] text-[var(--color-tron-cyan)]'
				: 'text-[var(--color-tron-text-secondary)] hover:bg-[var(--color-tron-bg-tertiary)] hover:text-[var(--color-tron-cyan)]'}"
		>
			<svg class="h-3.5 w-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
				<path
					stroke-linecap="round"
					stroke-linejoin="round"
					stroke-width="2"
					d="M3 12h4l3-8 4 16 3-8h4"
				/>
			</svg>
			Status
		</button>
	</div>

	{#if !data.arm.reachable && data.arm.error}
		<div class="rounded-lg border border-red-500/40 bg-red-500/10 px-3 py-1.5 text-[length:var(--arm-text-body)]">
			<p class="text-red-300">Cannot reach the robot-arm Pi: {data.arm.error}</p>
		</div>
	{/if}

	<!--
		Status card and camera are a right rail on wide screens so they are
		co-visible with the controls. Below 1280px they stack above the tab
		content. Never a modal.
	-->
	<div class="grid grid-cols-1 gap-3 {statusVisible ? 'xl:grid-cols-[minmax(0,1fr)_380px]' : ''}">
		<div class="min-w-0 xl:order-1">
			{@render children()}
		</div>
		{#if statusVisible}
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
		{/if}
	</div>
</div>

<style>
	/* Everything clickable on every Robot Arm tab shows the hand cursor, as links do (2026-11-24). */
	.arm-page :global(
			:is(
				button,
				select,
				summary,
				label:has(input[type='checkbox'], input[type='radio']),
				input:is([type='checkbox'], [type='radio'], [type='range'], [type='file'], [type='color'], [type='submit'], [type='button'], [type='reset']),
				input[type='file']::file-selector-button,
				[role='button'],
				[role='menuitem'],
				[role='tab'],
				[role='slider']
			):not(:disabled, [aria-disabled='true'])
		) {
		cursor: pointer;
	}
</style>
