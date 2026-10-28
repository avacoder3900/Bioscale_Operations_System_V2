<script lang="ts">
	/**
	 * ARM-02 — the consolidated Robot Arm page.
	 *
	 * Control / Jog / Calibrate / Runs were four sibling entries in the Cart
	 * Mfg nav, as though they were peers of Reagent Filling. They are one
	 * machine, so they are now tabs inside one page.
	 *
	 * This is a real +layout.svelte rather than client-side tab state, because
	 * the four pages between them own 15 named form actions (?/jog, ?/capture,
	 * ?/startTeleop, …) that would collide in a single actions object, and
	 * because merging their loads would make opening Runs pay for a live
	 * calibration sync. Tabs stay deep-linkable and each keeps its own load.
	 *
	 * The camera lives here, not in a child page: a SvelteKit layout instance
	 * survives navigation between its children, so the feed is not torn down
	 * and reconnected every time the operator moves between tabs.
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

	// Operational order — connect/run, nudge, fix, review — not alphabetical.
	const tabs = [
		{
			href: `${BASE}/control`,
			label: 'Control',
			icon: 'M12 2L9.5 4.5h5L12 2zm-2.5 3l-2 2v8l2 2h5l2-2V7l-2-2h-5zm0 11h5v3h-5v-3zm-3 4h11l-1 2H7.5l-1-2z'
		},
		{
			href: `${BASE}/jog`,
			label: 'Jog',
			icon: 'M4 8V4m0 0h4M4 4l5 5m11-5v4m0-4h-4m4 0l-5 5M4 16v4m0 0h4m-4 0l5-5m11 5v-4m0 4h-4m4 0l-5-5'
		},
		{
			href: `${BASE}/calibrate`,
			label: 'Calibrate',
			icon: 'M12 3v3m0 12v3M3 12h3m12 0h3m-3 0a6 6 0 11-12 0 6 6 0 0112 0z'
		},
		{
			// ARM-04 — sticker-marker calibration, live tracking, home check.
			href: `${BASE}/vision`,
			label: 'Vision',
			icon: 'M15 12a3 3 0 11-6 0 3 3 0 016 0zm-3-7C7 5 3.3 8.1 2 12c1.3 3.9 5 7 10 7s8.7-3.1 10-7c-1.3-3.9-5-7-10-7z'
		},
		{
			// Recording clean-up: split a recording into steps, edit, save as a new one.
			href: `${BASE}/cleanup`,
			label: 'Clean-up',
			icon: 'M4 6h16M4 12h10M4 18h6m9-5l-3 3 3 3m-3-3h5'
		},
		{
			// ARM-06 — pose animation: poses by hand, move sets, sequences.
			href: `${BASE}/animate`,
			label: 'Animate',
			icon: 'M5 4l10 8-10 8V4zm12 0h2v16h-2V4z'
		},
		{
			// The arm feeds one cart at a time to an OT-2 running the wax-filling protocol.
			href: `${BASE}/wax-fill`,
			label: 'Wax fill',
			icon: 'M4 7h16M4 7l2 12h12l2-12M9 7V4h6v3m-6 6h6'
		},
		{
			href: `${BASE}/runs`,
			label: 'Runs',
			icon: 'M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2m-3 7h3m-3 4h3m-6-4h.01M9 16h.01'
		}
	];

	let currentPath = $derived($page.url.pathname);
	let activeTab = $derived(tabs.find((t) => currentPath.startsWith(t.href)) ?? tabs[0]);

	// dry_run.ok is always true — dry-run vs live is a config choice, not a
	// fault — so the state worth showing is `value`.
	let dryRun = $derived(data.arm.preflight?.checks?.dry_run?.value ?? null);
	let version = $derived(data.arm.preflight?.version ?? null);
	let diagnosis = $derived(data.arm.preflight?.diagnosis ?? null);

	// ARM CONNECTION panel sits above the camera in the right rail. Hiding it
	// folds away the connection details to give the camera more of the rail;
	// its header, the Pi / servo lines and Torque stay. The choice is a
	// per-browser convenience, remembered so it survives a reload.
	const CONNECTION_HIDDEN_KEY = 'robot-arm:connection-panel-hidden';
	let connectionHidden = $state(false);
	$effect(() => {
		try {
			connectionHidden = localStorage.getItem(CONNECTION_HIDDEN_KEY) === '1';
		} catch {
			/* storage unavailable — default to shown */
		}
	});
	function setConnectionHidden(hidden: boolean) {
		connectionHidden = hidden;
		try {
			localStorage.setItem(CONNECTION_HIDDEN_KEY, hidden ? '1' : '0');
		} catch {
			/* ignore */
		}
	}

	// The preflight warning (e.g. the leader BusLinker missing) can be collapsed
	// to a small "Show Warning" chip. The hidden TEXT is remembered, not a flag,
	// so a new or different warning shows again.
	const DIAGNOSIS_HIDDEN_KEY = 'robot-arm:diagnosis-hidden';
	let hiddenDiagnosis = $state<string | null>(null);
	$effect(() => {
		try {
			hiddenDiagnosis = localStorage.getItem(DIAGNOSIS_HIDDEN_KEY);
		} catch {
			/* storage unavailable — default to shown */
		}
	});
	let diagnosisHidden = $derived(!!diagnosis && hiddenDiagnosis === diagnosis);
	function setDiagnosisHidden(hidden: boolean) {
		hiddenDiagnosis = hidden ? diagnosis : null;
		try {
			if (hidden && diagnosis) localStorage.setItem(DIAGNOSIS_HIDDEN_KEY, diagnosis);
			else localStorage.removeItem(DIAGNOSIS_HIDDEN_KEY);
		} catch {
			/* ignore */
		}
	}
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
			href={`${BASE}/control`}
			class="transition-colors hover:text-[var(--color-tron-cyan)]"
			style="color: var(--color-tron-text-secondary)">Robot Arm</a
		>
		<span style="color: var(--color-tron-text-secondary)">/</span>
		<span style="color: var(--color-tron-cyan)">{activeTab.label}</span>
	</nav>

	<div class="flex items-center justify-between gap-4">
		<h1 class="text-2xl font-bold" style="color: var(--color-tron-cyan)">Robot Arm</h1>

		<!-- Status strip. ARM-01 fills this region out with per-port diagnosis;
		     ARM-02 only claims the space and shows the headline facts. -->
		<div class="flex items-center gap-3 text-xs">
			{#if data.arm.reachable}
				<span class="flex items-center gap-1.5">
					<span class="h-2 w-2 rounded-full bg-green-500"></span>
					<span style="color: var(--color-tron-text-secondary)">
						Reachable{#if version} · v{version}{/if}
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
					<span class="text-red-400">Unreachable</span>
				</span>
			{/if}
		</div>
	</div>

	{#if !data.arm.reachable && data.arm.error}
		<div class="rounded-lg border border-red-500/40 bg-red-500/10 p-3 text-xs">
			<p class="text-red-300">Cannot reach the robot-arm Pi: {data.arm.error}</p>
			<p class="mt-1" style="color: var(--color-tron-text-secondary)">
				Check <code>ROBOT_ARM_BASE_URL</code> and <code>ROBOT_ARM_API_KEY</code>. Run history below
				still works — it reads from BIMS, not the arm.
			</p>
		</div>
	{:else if diagnosis && diagnosisHidden}
		<button
			type="button"
			onclick={() => setDiagnosisHidden(false)}
			class="rounded border border-amber-500/40 bg-amber-500/10 px-3 py-1 text-xs font-semibold text-amber-200 hover:bg-amber-500/20"
		>
			Show Warning
		</button>
	{:else if diagnosis}
		<div class="flex items-start gap-3 rounded-lg border border-amber-500/40 bg-amber-500/10 p-3 text-xs text-amber-200">
			<span class="flex-1">{diagnosis}</span>
			<button
				type="button"
				onclick={() => setDiagnosisHidden(true)}
				class="shrink-0 rounded border border-amber-500/40 px-2 py-0.5 font-semibold hover:bg-amber-500/20"
			>
				Hide
			</button>
		</div>
	{/if}

	<!-- Tab strip -->
	<div class="flex flex-wrap gap-2 border-b pb-3" style="border-color: var(--color-tron-border)">
		{#each tabs as tab (tab.href)}
			{@const active = currentPath.startsWith(tab.href)}
			<a
				href={tab.href}
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
	</div>

	<!--
		Camera is a right rail on wide screens so it is co-visible with the
		controls — the natural teleop posture. Below 1280px it stacks above the
		tab content. Never a modal: a modal you must dismiss to press a jog
		button is the exact problem this page exists to fix.
	-->
	<div class="grid grid-cols-1 gap-4 xl:grid-cols-[minmax(0,1fr)_380px]">
		<div class="min-w-0 xl:order-1">
			{@render children()}
		</div>
		<div class="xl:order-2">
			<div class="space-y-4 xl:sticky xl:top-4">
				<!-- Hidden keeps the header, Pi / servo lines and Torque; only the details fold away. -->
				<RobotArmConnectionPanel
					preflight={data.arm.preflight}
					preflightError={data.arm.error}
					baseUrl={data.arm.baseUrl}
					lastConnected={data.arm.lastConnected}
					armReachable={data.arm.reachable}
					thermal={data.thermal}
					hidden={connectionHidden}
					onhide={() => setConnectionHidden(true)}
					onshow={() => setConnectionHidden(false)}
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
