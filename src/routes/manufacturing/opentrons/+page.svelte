<script lang="ts">
	import { resolve } from '$app/paths';
	import { enhance } from '$app/forms';
	import { invalidateAll } from '$app/navigation';
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
	interface RemovalHistoryEntry {
		id: string;
		cartridgeIds: string[];
		cartridgeCount: number;
		reason: string;
		operatorUsername: string;
		removedAt: string;
	}
	interface Props {
		data: {
			robots: RobotSummary[];
			waxState: WaxRobotState[];
			reagentState: ReagentRobotState[];
			robotAvailability: RobotAvailability[];
			robotStats: RobotStatsData[];
			removalHistory: RemovalHistoryEntry[];
		};
		form: { removeWaxStored?: { error?: string; success?: boolean; removalId?: string; count?: number } } | null;
	}
	let { data, form }: Props = $props();

	// Manual cartridge removal state
	let scannedIds = $state<string[]>([]);
	let scanInput = $state('');
	let reason = $state('');
	let submitting = $state(false);
	let lastScanError = $state('');
	let scanInputEl: HTMLInputElement | undefined = $state();
	let expandedGroupId = $state<string | null>(null);

	function addScan() {
		const v = scanInput.trim();
		if (!v) return;
		if (scannedIds.includes(v)) {
			lastScanError = `Already scanned: ${v}`;
			scanInput = '';
			return;
		}
		scannedIds = [...scannedIds, v];
		scanInput = '';
		lastScanError = '';
	}

	function handleScanKeydown(e: KeyboardEvent) {
		if (e.key === 'Enter') {
			e.preventDefault();
			addScan();
		}
	}

	function removeScan(id: string) {
		scannedIds = scannedIds.filter((s) => s !== id);
	}

	function clearAll() {
		scannedIds = [];
		reason = '';
		lastScanError = '';
	}

	function submitRemoval() {
		return async ({ update }: { update: () => Promise<void> }) => {
			submitting = true;
			await update();
			submitting = false;
			if (form?.removeWaxStored?.success) {
				scannedIds = [];
				reason = '';
				lastScanError = '';
				await invalidateAll();
				scanInputEl?.focus();
			}
		};
	}

	function toggleGroup(id: string) {
		expandedGroupId = expandedGroupId === id ? null : id;
	}

	function formatDate(iso: string): string {
		if (!iso) return '';
		const d = new Date(iso);
		return d.toLocaleString(undefined, { dateStyle: 'short', timeStyle: 'short' });
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

<div class="space-y-6">
	<div class="flex items-center justify-between">
		<div>
			<h2 class="text-xl font-semibold text-[var(--color-tron-text)]">Robots</h2>
			<p class="mt-1 text-sm text-[var(--color-tron-text-secondary)]">
				Overview of all Opentrons robots. Click a robot to go to its active run.
			</p>
		</div>
		<div class="flex items-center gap-2">
			<a
				href={resolve('/manufacturing/wax-filling/settings')}
				title="Wax Filling Settings — timers, temperatures, rejection codes"
				aria-label="Wax Filling Settings"
				class="flex h-10 w-10 items-center justify-center rounded border border-[var(--color-tron-border)] bg-[var(--color-tron-surface)] text-[var(--color-tron-text-secondary)] transition-colors hover:border-[var(--color-tron-cyan)] hover:text-[var(--color-tron-cyan)]"
			>
				<svg class="h-5 w-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
					<path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 002.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 001.065 2.572c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 00-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 00-2.572 1.065c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 00-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 00-1.065-2.572c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 001.066-2.573c-.94-1.543.826-3.31 2.37-2.37.996.608 2.296.07 2.572-1.065z" />
					<path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
				</svg>
			</a>
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

	<!-- Manual cartridge removal: scan wax-stored cartridges and mark them
	     scrapped as a batched group. Each removal emits a scrap InventoryTransaction
	     per cartridge (manufacturingStep='storage') so the scrap audit stays clean. -->
	<div class="mt-8 rounded-lg border border-[var(--color-tron-border)] bg-[var(--color-tron-surface)] p-6">
		<div class="flex items-start justify-between">
			<div>
				<h2 class="text-lg font-semibold text-[var(--color-tron-text)]">Manual Cartridge Removal</h2>
				<p class="mt-1 text-xs text-[var(--color-tron-text-secondary)]">
					Scan one or more wax-stored cartridges, provide a reason, and remove them as a group.
					Each removal is logged with operator, timestamp, and a scrap inventory transaction.
				</p>
			</div>
			{#if scannedIds.length > 0 || reason}
				<button
					type="button"
					onclick={clearAll}
					class="rounded border border-[var(--color-tron-border)] px-3 py-1 text-xs text-[var(--color-tron-text-secondary)] hover:border-[var(--color-tron-red)]/50 hover:text-[var(--color-tron-red)]"
				>
					Clear
				</button>
			{/if}
		</div>

		<form
			method="POST"
			action="?/removeWaxStoredCartridges"
			use:enhance={submitRemoval}
			class="mt-4 grid gap-4 lg:grid-cols-[1fr_1fr]"
		>
			<input type="hidden" name="cartridgeIds" value={JSON.stringify(scannedIds)} />
			<input type="hidden" name="reason" value={reason} />

			<!-- Left: scan input + staged scans -->
			<div class="flex flex-col gap-3">
				<div>
					<label for="manual-removal-scan" class="block text-xs font-medium text-[var(--color-tron-text-secondary)] uppercase tracking-wider">
						Scan Cartridge Barcode
					</label>
					<div class="mt-1 flex items-center gap-2">
						<input
							bind:this={scanInputEl}
							bind:value={scanInput}
							onkeydown={handleScanKeydown}
							id="manual-removal-scan"
							type="text"
							placeholder="Scan or type cartridge ID and press Enter"
							class="flex-1 rounded border border-[var(--color-tron-border)] bg-[var(--color-tron-bg)] px-3 py-2 text-sm text-[var(--color-tron-text)] focus:border-[var(--color-tron-cyan)] focus:outline-none"
							autocomplete="off"
							disabled={submitting}
						/>
						<button
							type="button"
							onclick={addScan}
							disabled={!scanInput.trim() || submitting}
							class="rounded border border-[var(--color-tron-cyan)]/50 bg-[var(--color-tron-cyan)]/10 px-3 py-2 text-xs font-medium text-[var(--color-tron-cyan)] hover:bg-[var(--color-tron-cyan)]/20 disabled:opacity-50"
						>
							Add
						</button>
					</div>
					{#if lastScanError}
						<p class="mt-1 text-xs text-amber-300">{lastScanError}</p>
					{/if}
				</div>

				<div>
					<div class="flex items-center justify-between">
						<span class="text-xs font-medium text-[var(--color-tron-text-secondary)] uppercase tracking-wider">
							Staged Cartridges
						</span>
						<span class="text-xs text-[var(--color-tron-text-secondary)]">
							{scannedIds.length} scanned
						</span>
					</div>
					<div class="mt-2 min-h-[72px] rounded border border-[var(--color-tron-border)] bg-[var(--color-tron-bg)] p-2">
						{#if scannedIds.length === 0}
							<p class="text-center text-xs text-[var(--color-tron-text-secondary)] py-4">
								No cartridges scanned yet.
							</p>
						{:else}
							<div class="flex flex-wrap gap-2">
								{#each scannedIds as cid (cid)}
									<span class="inline-flex items-center gap-1 rounded border border-[var(--color-tron-cyan)]/30 bg-[var(--color-tron-cyan)]/10 px-2 py-1 font-mono text-xs text-[var(--color-tron-cyan)]">
										{cid}
										<button
											type="button"
											onclick={() => removeScan(cid)}
											disabled={submitting}
											class="text-[var(--color-tron-text-secondary)] hover:text-[var(--color-tron-red)]"
											aria-label="Remove {cid}"
										>
											×
										</button>
									</span>
								{/each}
							</div>
						{/if}
					</div>
				</div>
			</div>

			<!-- Right: reason + submit -->
			<div class="flex flex-col gap-3">
				<div>
					<label for="manual-removal-reason" class="block text-xs font-medium text-[var(--color-tron-text-secondary)] uppercase tracking-wider">
						Reason
					</label>
					<textarea
						id="manual-removal-reason"
						bind:value={reason}
						rows="4"
						placeholder="Why are these cartridges being removed? (required)"
						class="mt-1 w-full rounded border border-[var(--color-tron-border)] bg-[var(--color-tron-bg)] px-3 py-2 text-sm text-[var(--color-tron-text)] focus:border-[var(--color-tron-cyan)] focus:outline-none"
						disabled={submitting}
					></textarea>
				</div>

				{#if form?.removeWaxStored?.error}
					<div class="rounded border border-[var(--color-tron-red)]/50 bg-red-900/20 px-3 py-2 text-xs text-red-300">
						{form.removeWaxStored.error}
					</div>
				{:else if form?.removeWaxStored?.success}
					<div class="rounded border border-emerald-500/50 bg-emerald-900/20 px-3 py-2 text-xs text-emerald-300">
						Removed {form.removeWaxStored.count} cartridge{form.removeWaxStored.count === 1 ? '' : 's'}.
					</div>
				{/if}

				<button
					type="submit"
					disabled={submitting || scannedIds.length === 0 || !reason.trim()}
					class="rounded border border-[var(--color-tron-red)]/50 bg-red-900/20 px-4 py-2 text-sm font-medium text-red-300 hover:bg-red-900/30 disabled:opacity-40 disabled:cursor-not-allowed"
				>
					{submitting ? 'Removing…' : `Remove ${scannedIds.length} cartridge${scannedIds.length === 1 ? '' : 's'}`}
				</button>
			</div>
		</form>

		<!-- Removal history -->
		<div class="mt-8">
			<h3 class="text-sm font-semibold text-[var(--color-tron-text)]">Recent Removals</h3>
			{#if data.removalHistory.length === 0}
				<p class="mt-2 text-xs text-[var(--color-tron-text-secondary)]">No manual removals yet.</p>
			{:else}
				<div class="mt-2 overflow-hidden rounded border border-[var(--color-tron-border)]">
					<table class="w-full text-left text-xs">
						<thead class="bg-[var(--color-tron-bg)] text-[var(--color-tron-text-secondary)] uppercase tracking-wider">
							<tr>
								<th class="px-3 py-2 font-medium">When</th>
								<th class="px-3 py-2 font-medium">Operator</th>
								<th class="px-3 py-2 font-medium text-right">Count</th>
								<th class="px-3 py-2 font-medium">Reason</th>
								<th class="px-3 py-2 font-medium"></th>
							</tr>
						</thead>
						<tbody class="divide-y divide-[var(--color-tron-border)]/50">
							{#each data.removalHistory as entry (entry.id)}
								<tr class="bg-[var(--color-tron-surface)] text-[var(--color-tron-text)]">
									<td class="px-3 py-2 font-mono">{formatDate(entry.removedAt)}</td>
									<td class="px-3 py-2">{entry.operatorUsername}</td>
									<td class="px-3 py-2 text-right tabular-nums">{entry.cartridgeCount}</td>
									<td class="px-3 py-2 text-[var(--color-tron-text-secondary)]">{entry.reason}</td>
									<td class="px-3 py-2">
										<button
											type="button"
											onclick={() => toggleGroup(entry.id)}
											class="text-[var(--color-tron-cyan)] hover:underline"
										>
											{expandedGroupId === entry.id ? 'Hide' : 'Cartridges'}
										</button>
									</td>
								</tr>
								{#if expandedGroupId === entry.id}
									<tr class="bg-[var(--color-tron-bg)]/40">
										<td colspan="5" class="px-3 py-2">
											<div class="flex flex-wrap gap-1">
												{#each entry.cartridgeIds as cid (cid)}
													<span class="rounded border border-[var(--color-tron-border)] bg-[var(--color-tron-bg)] px-2 py-0.5 font-mono text-[11px] text-[var(--color-tron-text-secondary)]">
														{cid}
													</span>
												{/each}
											</div>
										</td>
									</tr>
								{/if}
							{/each}
						</tbody>
					</table>
				</div>
			{/if}
		</div>
	</div>
</div>
