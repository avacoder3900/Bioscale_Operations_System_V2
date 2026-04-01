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

<div class="space-y-6">
	<div class="flex items-center justify-between">
		<div>
			<h2 class="text-xl font-semibold text-[var(--color-tron-text)]">Robots</h2>
			<p class="mt-1 text-sm text-[var(--color-tron-text-secondary)]">
				Overview of all Opentrons robots. Click a robot to go to its active run.
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

	<div class="grid gap-6 sm:grid-cols-2 lg:grid-cols-3">
		{#each data.robots as robot (robot.robotId)}
			{@const wax = data.waxState.find((s) => s.robotId === robot.robotId)}
			{@const reagent = data.reagentState.find((s) => s.robotId === robot.robotId)}
			{@const stats = data.robotStats.find((s) => s.robotId === robot.robotId)}
			{@const availability = data.robotAvailability.find((a) => a.robotId === robot.robotId)}
			{@const isBusy = availability && !availability.available}

			<div class="flex flex-col items-center gap-4 rounded-lg border border-[var(--color-tron-border)] bg-[var(--color-tron-surface)] p-6 transition-all hover:border-[var(--color-tron-cyan)]/50">
				<!-- Robot Icon -->
				<div
					class="flex h-20 w-20 items-center justify-center rounded-full border-2 bg-[var(--color-tron-bg)] {isBusy
						? 'border-amber-500/50'
						: 'border-[var(--color-tron-border)]'}"
				>
					<svg
						class="h-10 w-10 {isBusy ? 'text-amber-400' : 'text-[var(--color-tron-text-secondary)]'}"
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
					<h3 class="text-lg font-semibold text-[var(--color-tron-text)]">{robot.name}</h3>
					<p class="mt-1 text-xs text-[var(--color-tron-text-secondary)]">{robot.description}</p>
				</div>

				<!-- Availability -->
				{#if isBusy}
					<div class="flex items-center gap-2 rounded border border-amber-500/30 bg-amber-900/20 px-3 py-1.5 text-xs text-amber-300">
						<span class="h-2 w-2 rounded-full bg-amber-400 animate-pulse"></span>
						Active: {availability?.activeProcess} filling
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
							<span class="rounded px-2 py-0.5 {statusBadgeClass(reagent.hasActiveRun, reagent.stage)}">
								{statusLabel(reagent.hasActiveRun, reagent.stage)}
							</span>
							{#if reagent.assayTypeName && reagent.hasActiveRun}
								<span class="rounded border border-[var(--color-tron-cyan)]/30 bg-[var(--color-tron-cyan)]/10 px-1.5 py-0.5 text-[var(--color-tron-cyan)]">
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

				<!-- Action button -->
				{#if isBusy}
					<a
						href={resolve(availability?.activeProcess === 'wax' ? '/manufacturing/wax-filling' : '/manufacturing/reagent-filling') + '?robot=' + robot.robotId}
						class="w-full rounded border border-amber-500/50 bg-amber-900/20 px-4 py-2 text-center text-sm font-medium text-amber-300 transition-colors hover:bg-amber-900/30"
					>
						Go to run →
					</a>
				{:else}
					<div class="flex w-full gap-2">
						<a
							href={resolve('/manufacturing/wax-filling') + '?robot=' + robot.robotId}
							class="flex-1 rounded border border-[var(--color-tron-cyan)]/30 bg-[var(--color-tron-cyan)]/10 px-3 py-2 text-center text-xs font-medium text-[var(--color-tron-cyan)] transition-colors hover:bg-[var(--color-tron-cyan)]/20"
						>
							Wax Filling
						</a>
						<a
							href={resolve('/manufacturing/reagent-filling') + '?robot=' + robot.robotId}
							class="flex-1 rounded border border-[var(--color-tron-cyan)]/30 bg-[var(--color-tron-cyan)]/10 px-3 py-2 text-center text-xs font-medium text-[var(--color-tron-cyan)] transition-colors hover:bg-[var(--color-tron-cyan)]/20"
						>
							Reagent Filling
						</a>
					</div>
				{/if}
			</div>
		{/each}
	</div>
</div>
