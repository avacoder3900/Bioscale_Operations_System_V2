<script lang="ts">
	import { resolve } from '$app/paths';
	interface RobotSummary {
		robotId: string;
		name: string;
		description: string;
	}
	interface WaxRobotState {
		robotId: string;
		name: string;
		hasActiveRun: boolean;
		stage: string | null;
		alerts: { type: string; message: string }[];
	}
	interface ReagentRobotState {
		robotId: string;
		name: string;
		hasActiveRun: boolean;
		stage: string | null;
		assayTypeName: string | null;
	}
	interface RobotStatsData {
		robotId: string;
		waxRuns: { total: number; completed: number; aborted: number };
		reagentRuns: { total: number; completed: number; aborted: number };
	}
	interface RobotAvailability {
		robotId: string;
		available: boolean;
		activeProcess: string | null;
		activeRunId: string | null;
	}
	interface Props {
		data: {
			robots: RobotSummary[];
			waxState: WaxRobotState[];
			reagentState: ReagentRobotState[];
			robotAvailability: RobotAvailability[];
			robotStats: RobotStatsData[];
		};
	}
	let { data }: Props = $props();
	let selectedRobotId: string | null = $state(null);
	let selectedRobot = $derived(data.robots.find((r) => r.robotId === selectedRobotId));
	let selectedWaxState = $derived(data.waxState.find((s) => s.robotId === selectedRobotId));
	let selectedReagentState = $derived(
		data.reagentState.find((s) => s.robotId === selectedRobotId)
	);
	// Use the robot-exclusivity service as the single source of truth for busy status.
	// This prevents contradictions between the Opentrons page and individual filling pages.
	let selectedAvailability = $derived(
		data.robotAvailability.find((a) => a.robotId === selectedRobotId)
	);
	let robotBusy = $derived(!selectedAvailability?.available);
	let activeProcess = $derived(selectedAvailability?.activeProcess ?? null);
	let activeRunId = $derived(selectedAvailability?.activeRunId ?? null);
	function selectRobot(robotId: string) {
		selectedRobotId = robotId;
	}
	function goBack() {
		selectedRobotId = null;
	}
	function statusBadgeClass(hasActive: boolean, stage: string | null): string {
		if (!hasActive) return 'bg-[var(--color-tron-surface)] text-[var(--color-tron-text-secondary)]';
		switch (stage) {
			case 'Setup':
				return 'bg-blue-900/50 text-blue-300 border border-blue-500/30';
			case 'Loading':
				return 'bg-purple-900/50 text-purple-300 border border-purple-500/30';
			case 'Running':
				return 'bg-green-900/50 text-green-300 border border-green-500/30';
			case 'Awaiting Removal':
			case 'Inspection':
				return 'bg-yellow-900/50 text-yellow-300 border border-yellow-500/30';
			case 'QC':
			case 'Top Sealing':
				return 'bg-cyan-900/50 text-cyan-300 border border-cyan-500/30';
			case 'Completed':
				return 'bg-emerald-900/50 text-emerald-300 border border-emerald-500/30';
			default:
				return 'bg-[var(--color-tron-surface)] text-[var(--color-tron-text-secondary)]';
		}
	}
	function statusLabel(hasActive: boolean, stage: string | null): string {
		return hasActive && stage ? stage : 'Idle';
	}
</script>
{#if selectedRobotId === null}
	<!-- Step 1: Robot Selection -->
	<div class="space-y-6">
		<div class="flex items-center justify-between">
			<div>
				<h2 class="text-xl font-semibold text-[var(--color-tron-text)]">Select Robot</h2>
				<p class="mt-1 text-sm text-[var(--color-tron-text-secondary)]">
					Choose a robot to view or start a filling process.
				</p>
			</div>
			<a
				href={resolve('/manufacturing/opentrons/history')}
				class="flex items-center gap-2 rounded border border-[var(--color-tron-cyan)]/50 bg-[var(--color-tron-cyan)]/10 px-4 py-2 text-sm font-medium text-[var(--color-tron-cyan)] transition-colors hover:bg-[var(--color-tron-cyan)]/20"
			>
				<svg class="h-4 w-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
					<path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z" />
				</svg>
				Run History
			</a>
		</div>
		<div class="grid gap-6 sm:grid-cols-2">
			{#each data.robots as robot (robot.robotId)}
				{@const wax = data.waxState.find((s) => s.robotId === robot.robotId)}
				{@const reagent = data.reagentState.find((s) => s.robotId === robot.robotId)}
				{@const stats = data.robotStats.find((s) => s.robotId === robot.robotId)}
				{@const availability = data.robotAvailability.find((a) => a.robotId === robot.robotId)}
				<button
					type="button"
					onclick={() => selectRobot(robot.robotId)}
					class="group flex flex-col items-center gap-4 rounded-lg border border-[var(--color-tron-border)] bg-[var(--color-tron-surface)] p-6 transition-all hover:border-[var(--color-tron-cyan)] hover:shadow-[0_0_15px_rgba(0,255,255,0.15)]"
				>
					<!-- Robot Icon -->
					<div
						class="flex h-20 w-20 items-center justify-center rounded-full border-2 border-[var(--color-tron-border)] bg-[var(--color-tron-bg)] transition-colors group-hover:border-[var(--color-tron-cyan)]"
					>
						<svg
							class="h-10 w-10 text-[var(--color-tron-text-secondary)] transition-colors group-hover:text-[var(--color-tron-cyan)]"
							fill="none"
							stroke="currentColor"
							viewBox="0 0 24 24"
						>
							<path
								stroke-linecap="round"
								stroke-linejoin="round"
								stroke-width="1.5"
								d="M9 3v2m6-2v2M9 19v2m6-2v2M5 9H3m2 6H3m18-6h-2m2 6h-2M7 19h10a2 2 0 002-2V7a2 2 0 00-2-2H7a2 2 0 00-2 2v10a2 2 0 002 2zM9 9h6v6H9V9z"
							/>
						</svg>
					</div>
					<div class="text-center">
						<h3
							class="text-lg font-semibold text-[var(--color-tron-text)] transition-colors group-hover:text-[var(--color-tron-cyan)]"
						>
							{robot.name}
						</h3>
						<p class="mt-1 text-xs text-[var(--color-tron-text-secondary)]">
							{robot.description}
						</p>
					</div>
					<!-- Availability (single source of truth from robot-exclusivity service) -->
					{#if availability && !availability.available}
						<div class="flex items-center gap-2 rounded border border-amber-500/30 bg-amber-900/20 px-3 py-1.5 text-xs text-amber-300">
							<span class="h-2 w-2 rounded-full bg-amber-400 animate-pulse"></span>
							Active: {availability.activeProcess} filling{availability.activeRunId ? ` (${availability.activeRunId})` : ''}
						</div>
					{:else}
						<div class="flex items-center gap-2 text-xs text-green-300">
							<span class="h-2 w-2 rounded-full bg-green-400"></span>
							Available
						</div>
					{/if}
					<!-- Status badges -->
					<div class="flex flex-col gap-2">
						{#if wax}
							<div class="flex items-center gap-2 text-xs">
								<span class="text-[var(--color-tron-text-secondary)]">Wax:</span>
								<span class="rounded px-2 py-0.5 {statusBadgeClass(wax.hasActiveRun, wax.stage)}">
									{statusLabel(wax.hasActiveRun, wax.stage)}
								</span>
								{#if wax.alerts.length > 0}
									<span class="h-2 w-2 rounded-full bg-red-500"></span>
								{/if}
							</div>
						{/if}
						{#if reagent}
							<div class="flex items-center gap-2 text-xs">
								<span class="text-[var(--color-tron-text-secondary)]">Reagent:</span>
								<span
									class="rounded px-2 py-0.5 {statusBadgeClass(reagent.hasActiveRun, reagent.stage)}"
								>
									{statusLabel(reagent.hasActiveRun, reagent.stage)}
								</span>
								{#if reagent.assayTypeName && reagent.hasActiveRun}
									<span
										class="rounded border border-[var(--color-tron-cyan)]/30 bg-[var(--color-tron-cyan)]/10 px-1.5 py-0.5 text-[var(--color-tron-cyan)]"
									>
										{reagent.assayTypeName}
									</span>
								{/if}
							</div>
						{/if}
					</div>
					<!-- Per-robot stats -->
					{#if stats && (stats.waxRuns.total > 0 || stats.reagentRuns.total > 0)}
						<div class="mt-2 grid w-full grid-cols-3 gap-2 border-t border-[var(--color-tron-border)]/30 pt-3 text-center">
							<div>
								<p class="text-[10px] text-[var(--color-tron-text-secondary)]">Wax Runs</p>
								<p class="text-sm font-bold" style="color: var(--color-tron-yellow)">{stats.waxRuns.total}</p>
							</div>
							<div>
								<p class="text-[10px] text-[var(--color-tron-text-secondary)]">Reagent Runs</p>
								<p class="text-sm font-bold" style="color: var(--color-tron-blue)">{stats.reagentRuns.total}</p>
							</div>
							<div>
								<p class="text-[10px] text-[var(--color-tron-text-secondary)]">Success</p>
								<p class="text-sm font-bold" style="color: var(--color-tron-green)">{(stats.waxRuns.total + stats.reagentRuns.total) > 0 ? Math.round(((stats.waxRuns.completed + stats.reagentRuns.completed) / (stats.waxRuns.total + stats.reagentRuns.total)) * 100) : 0}%</p>
							</div>
						</div>
					{/if}
				</button>
			{/each}
		</div>
	</div>
{:else}
	<!-- Step 2: Process Selection -->
	<div class="space-y-6">
		<div class="flex items-center gap-4">
			<button
				type="button"
				onclick={goBack}
				class="flex items-center gap-1 rounded px-3 py-2 text-sm text-[var(--color-tron-text-secondary)] transition-colors hover:text-[var(--color-tron-cyan)]"
			>
				<svg class="h-4 w-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
					<path
						stroke-linecap="round"
						stroke-linejoin="round"
						stroke-width="2"
						d="M15 19l-7-7 7-7"
					/>
				</svg>
				Back
			</button>
			<div>
				<h2 class="text-xl font-semibold text-[var(--color-tron-text)]">
					{selectedRobot?.name} — Select Process
				</h2>
				<p class="mt-1 text-sm text-[var(--color-tron-text-secondary)]">
					Choose a filling process to run on this robot.
				</p>
			</div>
		</div>
		<div class="grid gap-6 sm:grid-cols-2">
			<!-- eslint-disable svelte/no-navigation-without-resolve -- resolve() is called, query param appended via concatenation -->
			<!-- Wax Filling Card -->
			{#if robotBusy && activeProcess === 'reagent' && !selectedWaxState?.hasActiveRun}
				<!-- Blocked: reagent is active, cannot start wax -->
				<div
					class="flex cursor-not-allowed flex-col items-center gap-4 rounded-lg border border-amber-500/30 bg-[var(--color-tron-surface)] p-6 opacity-50"
				>
					<div
						class="flex h-16 w-16 items-center justify-center rounded-full border-2 border-amber-500/30 bg-[var(--color-tron-bg)]"
					>
						<svg
							class="h-8 w-8 text-amber-500/50"
							fill="none"
							stroke="currentColor"
							viewBox="0 0 24 24"
						>
							<path
								stroke-linecap="round"
								stroke-linejoin="round"
								stroke-width="1.5"
								d="M19.428 15.428a2 2 0 00-1.022-.547l-2.387-.477a6 6 0 00-3.86.517l-.318.158a6 6 0 01-3.86.517L6.05 15.21a2 2 0 00-1.806.547M8 4h8l-1 1v5.172a2 2 0 00.586 1.414l5 5c1.26 1.26.367 3.414-1.415 3.414H4.828c-1.782 0-2.674-2.154-1.414-3.414l5-5A2 2 0 009 10.172V5L8 4z"
							/>
						</svg>
					</div>
					<div class="text-center">
						<h3 class="text-lg font-semibold text-[var(--color-tron-text)]">Wax Filling</h3>
						<p class="mt-1 text-xs text-[var(--color-tron-text-secondary)]">
							Fill cartridges with wax using the Opentrons robot
						</p>
						<p class="mt-2 text-xs font-medium text-amber-400">
							Robot busy with reagent filling{activeRunId ? ` (${activeRunId})` : ''}
						</p>
					</div>
				</div>
			{:else}
				<a
					href={resolve('/manufacturing/wax-filling') + '?robot=' + selectedRobotId}
					class="group flex flex-col items-center gap-4 rounded-lg border border-[var(--color-tron-border)] bg-[var(--color-tron-surface)] p-6 transition-all hover:border-[var(--color-tron-cyan)] hover:shadow-[0_0_15px_rgba(0,255,255,0.15)]"
				>
					<div
						class="flex h-16 w-16 items-center justify-center rounded-full border-2 border-[var(--color-tron-border)] bg-[var(--color-tron-bg)] transition-colors group-hover:border-[var(--color-tron-cyan)]"
					>
						<svg
							class="h-8 w-8 text-[var(--color-tron-text-secondary)] transition-colors group-hover:text-[var(--color-tron-cyan)]"
							fill="none"
							stroke="currentColor"
							viewBox="0 0 24 24"
						>
							<path
								stroke-linecap="round"
								stroke-linejoin="round"
								stroke-width="1.5"
								d="M19.428 15.428a2 2 0 00-1.022-.547l-2.387-.477a6 6 0 00-3.86.517l-.318.158a6 6 0 01-3.86.517L6.05 15.21a2 2 0 00-1.806.547M8 4h8l-1 1v5.172a2 2 0 00.586 1.414l5 5c1.26 1.26.367 3.414-1.415 3.414H4.828c-1.782 0-2.674-2.154-1.414-3.414l5-5A2 2 0 009 10.172V5L8 4z"
							/>
						</svg>
					</div>
					<div class="text-center">
						<h3
							class="text-lg font-semibold text-[var(--color-tron-text)] transition-colors group-hover:text-[var(--color-tron-cyan)]"
						>
							Wax Filling
						</h3>
						<p class="mt-1 text-xs text-[var(--color-tron-text-secondary)]">
							Fill cartridges with wax using the Opentrons robot
						</p>
					</div>
					{#if selectedWaxState}
						<span
							class="rounded px-2 py-1 text-xs font-medium {statusBadgeClass(selectedWaxState.hasActiveRun, selectedWaxState.stage)}"
						>
							{statusLabel(selectedWaxState.hasActiveRun, selectedWaxState.stage)}
						</span>
						{#if selectedWaxState.alerts.length > 0}
							<span
								class="rounded border border-red-500/30 bg-red-900/50 px-2 py-1 text-xs font-medium text-red-300"
							>
								{selectedWaxState.alerts[0].message}
							</span>
						{/if}
					{/if}
				</a>
			{/if}
			<!-- Reagent Filling Card -->
			{#if robotBusy && activeProcess === 'wax' && !selectedReagentState?.hasActiveRun}
				<!-- Blocked: wax is active, cannot start reagent -->
				<div
					class="flex cursor-not-allowed flex-col items-center gap-4 rounded-lg border border-amber-500/30 bg-[var(--color-tron-surface)] p-6 opacity-50"
				>
					<div
						class="flex h-16 w-16 items-center justify-center rounded-full border-2 border-amber-500/30 bg-[var(--color-tron-bg)]"
					>
						<svg
							class="h-8 w-8 text-amber-500/50"
							fill="none"
							stroke="currentColor"
							viewBox="0 0 24 24"
						>
							<path
								stroke-linecap="round"
								stroke-linejoin="round"
								stroke-width="1.5"
								d="M9.75 17L9 20l-1 1h8l-1-1-.75-3M3 13h18M5 17h14a2 2 0 002-2V5a2 2 0 00-2-2H5a2 2 0 00-2 2v10a2 2 0 002 2z"
							/>
						</svg>
					</div>
					<div class="text-center">
						<h3 class="text-lg font-semibold text-[var(--color-tron-text)]">Reagent Filling</h3>
						<p class="mt-1 text-xs text-[var(--color-tron-text-secondary)]">
							Fill cartridges with reagents using the Opentrons robot
						</p>
						<p class="mt-2 text-xs font-medium text-amber-400">
							Robot busy with wax filling{activeRunId ? ` (${activeRunId})` : ''}
						</p>
					</div>
				</div>
			{:else}
				<a
					href={resolve('/manufacturing/reagent-filling') + '?robot=' + selectedRobotId}
					class="group flex flex-col items-center gap-4 rounded-lg border border-[var(--color-tron-border)] bg-[var(--color-tron-surface)] p-6 transition-all hover:border-[var(--color-tron-cyan)] hover:shadow-[0_0_15px_rgba(0,255,255,0.15)]"
				>
					<div
						class="flex h-16 w-16 items-center justify-center rounded-full border-2 border-[var(--color-tron-border)] bg-[var(--color-tron-bg)] transition-colors group-hover:border-[var(--color-tron-cyan)]"
					>
						<svg
							class="h-8 w-8 text-[var(--color-tron-text-secondary)] transition-colors group-hover:text-[var(--color-tron-cyan)]"
							fill="none"
							stroke="currentColor"
							viewBox="0 0 24 24"
						>
							<path
								stroke-linecap="round"
								stroke-linejoin="round"
								stroke-width="1.5"
								d="M9.75 17L9 20l-1 1h8l-1-1-.75-3M3 13h18M5 17h14a2 2 0 002-2V5a2 2 0 00-2-2H5a2 2 0 00-2 2v10a2 2 0 002 2z"
							/>
						</svg>
					</div>
					<div class="text-center">
						<h3
							class="text-lg font-semibold text-[var(--color-tron-text)] transition-colors group-hover:text-[var(--color-tron-cyan)]"
						>
							Reagent Filling
						</h3>
						<p class="mt-1 text-xs text-[var(--color-tron-text-secondary)]">
							Fill cartridges with reagents using the Opentrons robot
						</p>
					</div>
					{#if selectedReagentState}
						<span
							class="rounded px-2 py-1 text-xs font-medium {statusBadgeClass(selectedReagentState.hasActiveRun, selectedReagentState.stage)}"
						>
							{statusLabel(selectedReagentState.hasActiveRun, selectedReagentState.stage)}
						</span>
						{#if selectedReagentState.assayTypeName && selectedReagentState.hasActiveRun}
							<span
								class="rounded border border-[var(--color-tron-cyan)]/30 bg-[var(--color-tron-cyan)]/10 px-2 py-1 text-xs font-medium text-[var(--color-tron-cyan)]"
							>
								{selectedReagentState.assayTypeName}
							</span>
						{/if}
					{/if}
				</a>
			{/if}
			<!-- eslint-enable svelte/no-navigation-without-resolve -->
		</div>
	</div>
{/if}
