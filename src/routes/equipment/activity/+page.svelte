<script lang="ts">
	import { SvelteMap } from 'svelte/reactivity';

	interface Props {
		data: {
			decks: { deckId: string; status: string; currentRobotId: string | null; lastUsed: string | null }[];
			trays: { trayId: string; status: string; assignedRunId: string | null }[];
			locations: { id: string; barcode: string; locationType: string; displayName: string; isActive: boolean; capacity: number | null }[];
			equipmentTemps: Record<string, number | null>;
			placements: { locationId: string; locationType: string; displayName: string; itemType: string; itemId: string }[];
			activeWaxRuns: { runId: string; robotId: string; deckId: string | null; coolingTrayId: string | null; status: string }[];
			activeReagentRuns: { runId: string; robotId: string; deckId: string | null; status: string }[];
			waxRunHistory: {
				runId: string; robotId: string; deckId: string | null; coolingTrayId: string | null;
				waxSourceLot: string | null; status: string; operatorName: string; abortReason: string | null;
				plannedCartridgeCount: number | null; runStartTime: string | null; runEndTime: string | null; createdAt: string;
			}[];
			reagentRunHistory: {
				runId: string; robotId: string; deckId: string | null; status: string; operatorName: string;
				abortReason: string | null; cartridgeCount: number | null; runStartTime: string | null;
				runEndTime: string | null; createdAt: string;
			}[];
		};
	}

	let { data }: Props = $props();

	// ---- Diagram Logic: determine where each deck/tray is ----
	type ItemLocation = { zone: 'fridge' | 'oven' | 'robot' | 'table'; label: string; runId?: string; runStatus?: string };

	let itemLocations = $derived.by(() => {
		const map = new SvelteMap<string, ItemLocation>();

		// Location placements (fridge/oven)
		for (const p of data.placements) {
			if (p.itemType === 'deck' || p.itemType === 'tray') {
				map.set(p.itemId, { zone: p.locationType as 'fridge' | 'oven', label: p.displayName });
			}
		}

		// Active wax runs → decks/trays on robots
		for (const run of data.activeWaxRuns) {
			if (run.deckId && ['Loading', 'Running', 'Awaiting Removal'].includes(run.status)) {
				map.set(run.deckId, {
					zone: 'robot',
					label: robotLabel(run.robotId),
					runId: run.runId,
					runStatus: run.status
				});
			}
			if (run.coolingTrayId && ['Cooling', 'QC', 'Awaiting Removal'].includes(run.status)) {
				if (!map.has(run.coolingTrayId)) {
					map.set(run.coolingTrayId, {
						zone: 'robot',
						label: robotLabel(run.robotId),
						runId: run.runId,
						runStatus: run.status
					});
				}
			}
		}

		// Active reagent runs → decks on robots
		for (const run of data.activeReagentRuns) {
			if (run.deckId && !map.has(run.deckId)) {
				map.set(run.deckId, {
					zone: 'robot',
					label: robotLabel(run.robotId),
					runId: run.runId,
					runStatus: run.status
				});
			}
		}

		// Fallback: deck.currentRobotId
		for (const deck of data.decks) {
			if (deck.status === 'In Use' && deck.currentRobotId && !map.has(deck.deckId)) {
				map.set(deck.deckId, { zone: 'robot', label: robotLabel(deck.currentRobotId) });
			}
		}

		return map;
	});

	function robotLabel(robotId: string): string {
		if (robotId === 'robot-1') return 'Robot 1';
		if (robotId === 'robot-2') return 'Robot 2';
		return robotId;
	}

	type ZoneItem = { id: string; type: 'deck' | 'tray'; status: string; runId?: string; runStatus?: string };

	let fridges = $derived(data.locations.filter((l) => l.locationType === 'fridge'));
	let ovens = $derived(data.locations.filter((l) => l.locationType === 'oven'));

	function groupByZone(zone: 'fridge' | 'oven' | 'robot', equipNames: string[]): SvelteMap<string, ZoneItem[]> {
		const grouped = new SvelteMap<string, ZoneItem[]>();
		for (const name of equipNames) {
			grouped.set(name, []);
		}
		for (const [itemId, loc] of itemLocations) {
			if (loc.zone === zone) {
				const items = grouped.get(loc.label) ?? [];
				const deck = data.decks.find((d) => d.deckId === itemId);
				const tray = data.trays.find((t) => t.trayId === itemId);
				items.push({
					id: itemId,
					type: deck ? 'deck' : 'tray',
					status: deck?.status ?? tray?.status ?? 'Unknown',
					runId: loc.runId,
					runStatus: loc.runStatus
				});
				grouped.set(loc.label, items);
			}
		}
		return grouped;
	}

	let fridgeItems = $derived(groupByZone('fridge', fridges.map((f) => f.displayName)));
	let ovenItems = $derived(groupByZone('oven', ovens.map((o) => o.displayName)));
	let robotItems = $derived(groupByZone('robot', ['Robot 1', 'Robot 2']));

	let tableItems = $derived.by(() => {
		const items: ZoneItem[] = [];
		for (const deck of data.decks) {
			if (!itemLocations.has(deck.deckId)) {
				items.push({ id: deck.deckId, type: 'deck', status: deck.status });
			}
		}
		for (const tray of data.trays) {
			if (!itemLocations.has(tray.trayId)) {
				items.push({ id: tray.trayId, type: 'tray', status: tray.status });
			}
		}
		return items;
	});

	// ---- Run History ----
	type RunEntry = {
		runId: string; processType: 'wax' | 'reagent'; robotId: string;
		deckId: string | null; coolingTrayId: string | null; status: string;
		operatorName: string; abortReason: string | null; cartridgeCount: number | null;
		runStartTime: string | null; runEndTime: string | null; createdAt: string;
	};

	let allRuns = $derived.by(() => {
		const entries: RunEntry[] = [];
		for (const r of data.waxRunHistory) {
			entries.push({
				runId: r.runId, processType: 'wax', robotId: r.robotId, deckId: r.deckId,
				coolingTrayId: r.coolingTrayId, status: r.status, operatorName: r.operatorName,
				abortReason: r.abortReason, cartridgeCount: r.plannedCartridgeCount,
				runStartTime: r.runStartTime, runEndTime: r.runEndTime, createdAt: r.createdAt
			});
		}
		for (const r of data.reagentRunHistory) {
			entries.push({
				runId: r.runId, processType: 'reagent', robotId: r.robotId, deckId: r.deckId,
				coolingTrayId: null, status: r.status, operatorName: r.operatorName,
				abortReason: r.abortReason, cartridgeCount: r.cartridgeCount,
				runStartTime: r.runStartTime, runEndTime: r.runEndTime, createdAt: r.createdAt
			});
		}
		entries.sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
		return entries;
	});

	let deckRunHistory = $derived.by(() => {
		const map = new SvelteMap<string, RunEntry[]>();
		for (const deck of data.decks) map.set(deck.deckId, []);
		for (const entry of allRuns) {
			if (entry.deckId) {
				const arr = map.get(entry.deckId) ?? [];
				arr.push(entry);
				map.set(entry.deckId, arr);
			}
		}
		return map;
	});

	let trayRunHistory = $derived.by(() => {
		const map = new SvelteMap<string, RunEntry[]>();
		for (const tray of data.trays) map.set(tray.trayId, []);
		for (const entry of allRuns) {
			if (entry.coolingTrayId) {
				const arr = map.get(entry.coolingTrayId) ?? [];
				arr.push(entry);
				map.set(entry.coolingTrayId, arr);
			}
		}
		return map;
	});

	// ---- Helpers ----
	function statusColor(status: string): string {
		switch (status) {
			case 'Available': return 'text-green-300 bg-green-900/30 border-green-500/30';
			case 'In Use': return 'text-blue-300 bg-blue-900/30 border-blue-500/30';
			case 'Cooldown Lockout': return 'text-yellow-300 bg-yellow-900/30 border-yellow-500/30';
			case 'Needs Cleaning': return 'text-orange-300 bg-orange-900/30 border-orange-500/30';
			case 'Out of Service': return 'text-red-300 bg-red-900/30 border-red-500/30';
			case 'In QC': return 'text-purple-300 bg-purple-900/30 border-purple-500/30';
			default: return 'text-[var(--color-tron-text-secondary)] bg-[var(--color-tron-surface)] border-[var(--color-tron-border)]';
		}
	}

	function runStatusColor(status: string): string {
		switch (status) {
			case 'Completed': return 'text-green-300 bg-green-900/30 border-green-500/30';
			case 'Aborted': return 'text-red-300 bg-red-900/30 border-red-500/30';
			case 'Cancelled': return 'text-orange-300 bg-orange-900/30 border-orange-500/30';
			case 'Running': return 'text-blue-300 bg-blue-900/30 border-blue-500/30';
			default: return 'text-[var(--color-tron-text-secondary)] bg-[var(--color-tron-surface)] border-[var(--color-tron-border)]';
		}
	}

	function formatDuration(startTime: string | null, endTime: string | null): string {
		if (!startTime) return '-';
		const start = new Date(startTime).getTime();
		const end = endTime ? new Date(endTime).getTime() : Date.now();
		const mins = Math.round((end - start) / 60000);
		if (mins < 60) return `${mins}m`;
		const hrs = Math.floor(mins / 60);
		return `${hrs}h ${mins % 60}m`;
	}

	function formatDateTime(iso: string | null): string {
		if (!iso) return '-';
		return new Date(iso).toLocaleString();
	}
</script>

<div class="space-y-8">
	<!-- ================================================================== -->
	<!-- EQUIPMENT DIAGRAM                                                  -->
	<!-- ================================================================== -->
	<section>
		<h1 class="mb-4 text-2xl font-semibold text-[var(--color-tron-text)]">Equipment Layout</h1>
		<p class="mb-6 text-sm text-[var(--color-tron-text-secondary)]">
			Real-time location of all decks and trays across fridges, ovens, robots, and the workbench.
		</p>

		<!-- Fridges + Ovens row -->
		<div class="mb-4 grid grid-cols-1 gap-4 lg:grid-cols-2">
			<!-- Fridges column -->
			<div class="space-y-3">
				<h2 class="flex items-center gap-2 text-sm font-bold uppercase tracking-wider text-blue-300">
					<svg class="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2">
						<path stroke-linecap="round" stroke-linejoin="round" d="M20 7l-8-4-8 4m16 0l-8 4m8-4v10l-8 4m0-10L4 7m8 4v10M4 7v10l8 4" />
					</svg>
					Fridges ({fridges.length})
				</h2>
				{#if fridges.length === 0}
					<div class="rounded-lg border-2 border-dashed border-blue-500/20 p-6 text-center">
						<p class="text-xs text-blue-300/50">No fridges registered in the system</p>
					</div>
				{/if}
				{#each fridges as fridge (fridge.id)}
					{@const items = fridgeItems.get(fridge.displayName) ?? []}
					{@const temp = data.equipmentTemps[fridge.displayName] ?? null}
					<div class="relative overflow-hidden rounded-lg border border-blue-500/30 bg-gradient-to-br from-blue-950/50 to-slate-900/50">
						<div class="absolute inset-0 bg-[linear-gradient(135deg,rgba(59,130,246,0.05)_0%,transparent_50%)]"></div>
						<div class="relative p-4">
							<div class="mb-3 flex items-center justify-between">
								<div class="flex items-center gap-2">
									<div class="flex h-8 w-8 items-center justify-center rounded-lg bg-blue-500/20">
										<svg class="h-4 w-4 text-blue-400" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2">
											<path stroke-linecap="round" stroke-linejoin="round" d="M20 7l-8-4-8 4m16 0l-8 4m8-4v10l-8 4m0-10L4 7m8 4v10M4 7v10l8 4" />
										</svg>
									</div>
									<span class="text-sm font-semibold text-blue-100">{fridge.displayName}</span>
								</div>
								<div class="flex items-center gap-2">
									{#if temp != null}
										<span class="rounded-full bg-blue-900/60 px-2.5 py-1 font-mono text-xs font-bold text-blue-200">
											{temp.toFixed(1)}°C
										</span>
									{/if}
									<span class="h-2.5 w-2.5 rounded-full bg-green-400 shadow-[0_0_6px_rgba(74,222,128,0.5)]"></span>
								</div>
							</div>
							<div class="min-h-[40px] rounded-lg border border-blue-500/10 bg-blue-950/30 p-2">
								{#if fridge.occupantCount > 0}
									<div class="flex items-center justify-center gap-2 py-1">
										<span class="text-2xl font-bold text-blue-200">{fridge.occupantCount}</span>
										<span class="text-xs text-blue-300/60">cartridges stored</span>
									</div>
								{:else if items.length === 0}
									<p class="py-1 text-center text-[11px] text-blue-300/30">Empty</p>
								{:else}
									<div class="flex flex-wrap gap-1.5">
										{#each items as item (item.id)}
											<span class="inline-flex items-center gap-1.5 rounded-md border px-2.5 py-1.5 text-xs font-semibold shadow-sm {item.type === 'deck'
												? 'border-cyan-400/40 bg-cyan-900/40 text-cyan-200'
												: 'border-purple-400/40 bg-purple-900/40 text-purple-200'}">
												<span class="h-2 w-2 rounded-full {item.type === 'deck' ? 'bg-cyan-400' : 'bg-purple-400'}"></span>
												{item.id}
											</span>
										{/each}
									</div>
								{/if}
							</div>
						</div>
					</div>
				{/each}
			</div>

			<!-- Ovens column -->
			<div class="space-y-3">
				<h2 class="flex items-center gap-2 text-sm font-bold uppercase tracking-wider text-orange-300">
					<svg class="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2">
						<path stroke-linecap="round" stroke-linejoin="round" d="M17.657 18.657A8 8 0 016.343 7.343S7 9 9 10c0-2 .5-5 2.986-7C14 5 16.09 5.777 17.656 7.343A7.975 7.975 0 0120 13a7.975 7.975 0 01-2.343 5.657z" />
						<path stroke-linecap="round" stroke-linejoin="round" d="M9.879 16.121A3 3 0 1012.015 11L11 14H9c0 .768.293 1.536.879 2.121z" />
					</svg>
					Ovens ({ovens.length})
				</h2>
				{#if ovens.length === 0}
					<div class="rounded-lg border-2 border-dashed border-orange-500/20 p-6 text-center">
						<p class="text-xs text-orange-300/50">No ovens registered in the system</p>
					</div>
				{/if}
				{#each ovens as oven (oven.id)}
					{@const items = ovenItems.get(oven.displayName) ?? []}
					{@const temp = data.equipmentTemps[oven.displayName] ?? null}
					<div class="relative overflow-hidden rounded-lg border border-orange-500/30 bg-gradient-to-br from-orange-950/50 to-slate-900/50">
						<div class="absolute inset-0 bg-[linear-gradient(135deg,rgba(249,115,22,0.05)_0%,transparent_50%)]"></div>
						<div class="relative p-4">
							<div class="mb-3 flex items-center justify-between">
								<div class="flex items-center gap-2">
									<div class="flex h-8 w-8 items-center justify-center rounded-lg bg-orange-500/20">
										<svg class="h-4 w-4 text-orange-400" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2">
											<path stroke-linecap="round" stroke-linejoin="round" d="M17.657 18.657A8 8 0 016.343 7.343S7 9 9 10c0-2 .5-5 2.986-7C14 5 16.09 5.777 17.656 7.343A7.975 7.975 0 0120 13a7.975 7.975 0 01-2.343 5.657z" />
										</svg>
									</div>
									<span class="text-sm font-semibold text-orange-100">{oven.displayName}</span>
								</div>
								<div class="flex items-center gap-2">
									{#if temp != null}
										<span class="rounded-full bg-orange-900/60 px-2.5 py-1 font-mono text-xs font-bold text-orange-200">
											{temp.toFixed(1)}°C
										</span>
									{/if}
									<span class="h-2.5 w-2.5 rounded-full bg-green-400 shadow-[0_0_6px_rgba(74,222,128,0.5)]"></span>
								</div>
							</div>
							<div class="min-h-[40px] rounded-lg border border-orange-500/10 bg-orange-950/30 p-2">
								{#if oven.occupantCount > 0}
									<div class="flex items-center justify-center gap-2 py-1">
										<span class="text-2xl font-bold text-orange-200">{oven.occupantCount}</span>
										<span class="text-xs text-orange-300/60">cartridges</span>
									</div>
								{:else if items.length === 0}
									<p class="py-1 text-center text-[11px] text-orange-300/30">Empty</p>
								{:else}
									<div class="flex flex-wrap gap-1.5">
										{#each items as item (item.id)}
											<span class="inline-flex items-center gap-1.5 rounded-md border px-2.5 py-1.5 text-xs font-semibold shadow-sm {item.type === 'deck'
												? 'border-cyan-400/40 bg-cyan-900/40 text-cyan-200'
												: 'border-purple-400/40 bg-purple-900/40 text-purple-200'}">
												<span class="h-2 w-2 rounded-full {item.type === 'deck' ? 'bg-cyan-400' : 'bg-purple-400'}"></span>
												{item.id}
											</span>
										{/each}
									</div>
								{/if}
							</div>
						</div>
					</div>
				{/each}
			</div>
		</div>

		<!-- Robots row -->
		<div class="mb-4 grid grid-cols-1 gap-4 sm:grid-cols-2">
			{#each [...robotItems] as [rName, items] (rName)}
				{@const hasActive = items.some((i) => i.runId)}
				<div class="relative overflow-hidden rounded-lg border {hasActive
					? 'border-green-500/40 bg-gradient-to-br from-green-950/40 to-slate-900/50'
					: 'border-[var(--color-tron-border)] bg-[var(--color-tron-surface)]'}">
					{#if hasActive}
						<div class="absolute inset-0 bg-[linear-gradient(135deg,rgba(34,197,94,0.05)_0%,transparent_50%)]"></div>
					{/if}
					<div class="relative p-4">
						<div class="mb-3 flex items-center gap-3">
							<div class="flex h-9 w-9 items-center justify-center rounded-lg {hasActive ? 'bg-green-500/20' : 'bg-[var(--color-tron-surface)]'}">
								<svg class="h-5 w-5 {hasActive ? 'text-green-400' : 'text-[var(--color-tron-text-secondary)]'}" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2">
									<path stroke-linecap="round" stroke-linejoin="round" d="M9 3v2m6-2v2M9 19v2m6-2v2M5 9H3m2 6H3m18-6h-2m2 6h-2M7 19h10a2 2 0 002-2V7a2 2 0 00-2-2H7a2 2 0 00-2 2v10a2 2 0 002 2zM9 9h6v6H9V9z" />
								</svg>
							</div>
							<div>
								<span class="text-sm font-bold text-[var(--color-tron-text)]">{rName}</span>
								{#if hasActive}
									<span class="ml-2 inline-flex items-center gap-1 rounded-full bg-green-900/50 px-2 py-0.5 text-[10px] font-semibold text-green-300">
										<span class="h-1.5 w-1.5 animate-pulse rounded-full bg-green-400"></span>
										Active
									</span>
								{:else}
									<span class="ml-2 text-xs text-[var(--color-tron-text-secondary)]">Idle</span>
								{/if}
							</div>
						</div>
						{#if items.length === 0}
							<div class="rounded-lg border border-dashed border-[var(--color-tron-border)]/50 p-3 text-center">
								<p class="text-xs text-[var(--color-tron-text-secondary)]">No equipment loaded</p>
							</div>
						{:else}
							<div class="space-y-2">
								{#each items as item (item.id)}
									<div class="flex items-center justify-between rounded-lg border border-[var(--color-tron-border)]/50 bg-[var(--color-tron-bg)] px-3 py-2.5">
										<div class="flex items-center gap-2">
											<span class="h-2.5 w-2.5 rounded-full {item.type === 'deck' ? 'bg-cyan-400' : 'bg-purple-400'}"></span>
											<span class="text-xs font-semibold text-[var(--color-tron-text)]">{item.id}</span>
											<span class="rounded border px-1.5 py-0.5 text-[10px] font-medium {item.type === 'deck'
												? 'border-cyan-500/30 text-cyan-300'
												: 'border-purple-500/30 text-purple-300'}">{item.type}</span>
										</div>
										{#if item.runStatus}
											<span class="rounded border px-2 py-0.5 text-[10px] font-bold {runStatusColor(item.runStatus)}">
												{item.runStatus}
											</span>
										{/if}
									</div>
								{/each}
							</div>
						{/if}
					</div>
				</div>
			{/each}
		</div>

		<!-- Workbench -->
		<div class="rounded-lg border border-[var(--color-tron-border)] bg-[var(--color-tron-surface)]">
			<div class="border-b border-[var(--color-tron-border)]/50 px-4 py-3">
				<div class="flex items-center gap-2">
					<svg class="h-5 w-5 text-[var(--color-tron-text-secondary)]" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2">
						<path stroke-linecap="round" stroke-linejoin="round" d="M19 11H5m14 0a2 2 0 012 2v6a2 2 0 01-2 2H5a2 2 0 01-2-2v-6a2 2 0 012-2m14 0V9a2 2 0 00-2-2M5 11V9a2 2 0 012-2m0 0V5a2 2 0 012-2h6a2 2 0 012 2v2M7 7h10" />
					</svg>
					<span class="text-sm font-bold text-[var(--color-tron-text)]">Workbench</span>
					<span class="rounded-full bg-[var(--color-tron-surface)] px-2 py-0.5 text-xs text-[var(--color-tron-text-secondary)]">
						{tableItems.length} items
					</span>
				</div>
			</div>
			<div class="p-4">
				{#if tableItems.length === 0}
					<p class="py-4 text-center text-xs text-[var(--color-tron-text-secondary)]">All equipment is assigned to a location</p>
				{:else}
					<div class="flex flex-wrap gap-2">
						{#each tableItems as item (item.id)}
							<div class="inline-flex items-center gap-2 rounded-lg border border-[var(--color-tron-border)]/50 bg-[var(--color-tron-bg)] px-3 py-2">
								<span class="h-2.5 w-2.5 rounded-full {item.type === 'deck' ? 'bg-cyan-400' : 'bg-purple-400'}"></span>
								<span class="text-xs font-semibold text-[var(--color-tron-text)]">{item.id}</span>
								<span class="rounded border px-1.5 py-0.5 text-[10px] font-medium {item.type === 'deck'
									? 'border-cyan-500/30 text-cyan-300'
									: 'border-purple-500/30 text-purple-300'}">{item.type}</span>
								<span class="rounded border px-1.5 py-0.5 text-[10px] font-medium {statusColor(item.status)}">
									{item.status}
								</span>
							</div>
						{/each}
					</div>
				{/if}
			</div>
		</div>

		<!-- Legend -->
		<div class="mt-3 flex flex-wrap items-center gap-4 rounded-lg border border-[var(--color-tron-border)]/30 bg-[var(--color-tron-bg)] px-4 py-2.5">
			<span class="text-[11px] font-bold uppercase tracking-wider text-[var(--color-tron-text-secondary)]">Legend</span>
			<span class="inline-flex items-center gap-1.5 text-xs text-cyan-300">
				<span class="h-2.5 w-2.5 rounded-full bg-cyan-400"></span> Deck
			</span>
			<span class="inline-flex items-center gap-1.5 text-xs text-purple-300">
				<span class="h-2.5 w-2.5 rounded-full bg-purple-400"></span> Tray
			</span>
			<span class="text-[10px] text-[var(--color-tron-text-secondary)]">|</span>
			<span class="inline-flex items-center gap-1.5 text-xs text-blue-300">
				<svg class="h-3 w-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2"><path stroke-linecap="round" stroke-linejoin="round" d="M20 7l-8-4-8 4m16 0l-8 4m8-4v10l-8 4m0-10L4 7m8 4v10M4 7v10l8 4" /></svg>
				Fridge
			</span>
			<span class="inline-flex items-center gap-1.5 text-xs text-orange-300">
				<svg class="h-3 w-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2"><path stroke-linecap="round" stroke-linejoin="round" d="M17.657 18.657A8 8 0 016.343 7.343S7 9 9 10c0-2 .5-5 2.986-7C14 5 16.09 5.777 17.656 7.343A7.975 7.975 0 0120 13a7.975 7.975 0 01-2.343 5.657z" /></svg>
				Oven
			</span>
		</div>
	</section>

	<!-- ================================================================== -->
	<!-- RUN HISTORY                                                         -->
	<!-- ================================================================== -->
	<section>
		<h2 class="mb-4 text-xl font-semibold text-[var(--color-tron-text)]">Run History</h2>
		<p class="mb-6 text-sm text-[var(--color-tron-text-secondary)]">
			Complete run history for every deck and tray, organized by equipment.
		</p>

		<!-- Deck histories -->
		{#each data.decks as deck (deck.deckId)}
			{@const history = deckRunHistory.get(deck.deckId) ?? []}
			<div class="mb-4 overflow-hidden rounded-lg border border-[var(--color-tron-border)] bg-[var(--color-tron-surface)]">
				<div class="flex items-center justify-between border-b border-[var(--color-tron-border)] bg-[var(--color-tron-bg)] px-4 py-3">
					<div class="flex items-center gap-2.5">
						<span class="h-3 w-3 rounded-full bg-cyan-400"></span>
						<span class="text-sm font-bold text-[var(--color-tron-text)]">{deck.deckId}</span>
						<span class="rounded border border-cyan-500/30 px-1.5 py-0.5 text-[10px] font-medium text-cyan-300">deck</span>
						<span class="rounded border px-1.5 py-0.5 text-[10px] font-medium {statusColor(deck.status)}">
							{deck.status}
						</span>
					</div>
					<span class="text-xs text-[var(--color-tron-text-secondary)]">{history.length} run{history.length !== 1 ? 's' : ''}</span>
				</div>
				{#if history.length === 0}
					<div class="px-4 py-5 text-center text-xs text-[var(--color-tron-text-secondary)]">
						No run history
					</div>
				{:else}
					<div class="overflow-x-auto">
						<table class="w-full text-xs">
							<thead>
								<tr class="border-b border-[var(--color-tron-border)]/50 text-left text-[var(--color-tron-text-secondary)]">
									<th class="px-4 py-2.5 font-medium">Run ID</th>
									<th class="px-3 py-2.5 font-medium">Type</th>
									<th class="px-3 py-2.5 font-medium">Robot</th>
									<th class="px-3 py-2.5 font-medium">Operator</th>
									<th class="px-3 py-2.5 font-medium">Status</th>
									<th class="px-3 py-2.5 font-medium">Started</th>
									<th class="px-3 py-2.5 font-medium">Duration</th>
									<th class="px-3 py-2.5 font-medium">Cartridges</th>
									<th class="px-3 py-2.5 font-medium">Notes</th>
								</tr>
							</thead>
							<tbody>
								{#each history as run (run.runId)}
									<tr class="border-b border-[var(--color-tron-border)]/20 transition-colors hover:bg-[var(--color-tron-bg)]">
										<td class="px-4 py-2 font-mono text-[var(--color-tron-cyan)]">{run.runId}</td>
										<td class="px-3 py-2">
											<span class="rounded px-1.5 py-0.5 text-[10px] font-bold {run.processType === 'wax'
												? 'bg-amber-900/40 text-amber-300'
												: 'bg-teal-900/40 text-teal-300'}">
												{run.processType === 'wax' ? 'WAX' : 'RGF'}
											</span>
										</td>
										<td class="px-3 py-2 text-[var(--color-tron-text-secondary)]">{robotLabel(run.robotId)}</td>
										<td class="px-3 py-2 text-[var(--color-tron-text)]">{run.operatorName}</td>
										<td class="px-3 py-2">
											<span class="rounded border px-1.5 py-0.5 text-[10px] font-bold {runStatusColor(run.status)}">
												{run.status}
											</span>
										</td>
										<td class="px-3 py-2 text-[var(--color-tron-text-secondary)]">
											{formatDateTime(run.runStartTime ?? run.createdAt)}
										</td>
										<td class="px-3 py-2 font-mono text-[var(--color-tron-text-secondary)]">
											{formatDuration(run.runStartTime, run.runEndTime)}
										</td>
										<td class="px-3 py-2 text-center text-[var(--color-tron-text)]">
											{run.cartridgeCount ?? '-'}
										</td>
										<td class="max-w-[180px] truncate px-3 py-2 text-[var(--color-tron-text-secondary)]">
											{run.abortReason ?? '-'}
										</td>
									</tr>
								{/each}
							</tbody>
						</table>
					</div>
				{/if}
			</div>
		{/each}

		<!-- Tray histories -->
		{#each data.trays as tray (tray.trayId)}
			{@const history = trayRunHistory.get(tray.trayId) ?? []}
			<div class="mb-4 overflow-hidden rounded-lg border border-[var(--color-tron-border)] bg-[var(--color-tron-surface)]">
				<div class="flex items-center justify-between border-b border-[var(--color-tron-border)] bg-[var(--color-tron-bg)] px-4 py-3">
					<div class="flex items-center gap-2.5">
						<span class="h-3 w-3 rounded-full bg-purple-400"></span>
						<span class="text-sm font-bold text-[var(--color-tron-text)]">{tray.trayId}</span>
						<span class="rounded border border-purple-500/30 px-1.5 py-0.5 text-[10px] font-medium text-purple-300">tray</span>
						<span class="rounded border px-1.5 py-0.5 text-[10px] font-medium {statusColor(tray.status)}">
							{tray.status}
						</span>
					</div>
					<span class="text-xs text-[var(--color-tron-text-secondary)]">{history.length} run{history.length !== 1 ? 's' : ''}</span>
				</div>
				{#if history.length === 0}
					<div class="px-4 py-5 text-center text-xs text-[var(--color-tron-text-secondary)]">
						No run history
					</div>
				{:else}
					<div class="overflow-x-auto">
						<table class="w-full text-xs">
							<thead>
								<tr class="border-b border-[var(--color-tron-border)]/50 text-left text-[var(--color-tron-text-secondary)]">
									<th class="px-4 py-2.5 font-medium">Run ID</th>
									<th class="px-3 py-2.5 font-medium">Type</th>
									<th class="px-3 py-2.5 font-medium">Robot</th>
									<th class="px-3 py-2.5 font-medium">Operator</th>
									<th class="px-3 py-2.5 font-medium">Status</th>
									<th class="px-3 py-2.5 font-medium">Started</th>
									<th class="px-3 py-2.5 font-medium">Duration</th>
									<th class="px-3 py-2.5 font-medium">Cartridges</th>
									<th class="px-3 py-2.5 font-medium">Notes</th>
								</tr>
							</thead>
							<tbody>
								{#each history as run (run.runId)}
									<tr class="border-b border-[var(--color-tron-border)]/20 transition-colors hover:bg-[var(--color-tron-bg)]">
										<td class="px-4 py-2 font-mono text-[var(--color-tron-cyan)]">{run.runId}</td>
										<td class="px-3 py-2">
											<span class="rounded px-1.5 py-0.5 text-[10px] font-bold {run.processType === 'wax'
												? 'bg-amber-900/40 text-amber-300'
												: 'bg-teal-900/40 text-teal-300'}">
												{run.processType === 'wax' ? 'WAX' : 'RGF'}
											</span>
										</td>
										<td class="px-3 py-2 text-[var(--color-tron-text-secondary)]">{robotLabel(run.robotId)}</td>
										<td class="px-3 py-2 text-[var(--color-tron-text)]">{run.operatorName}</td>
										<td class="px-3 py-2">
											<span class="rounded border px-1.5 py-0.5 text-[10px] font-bold {runStatusColor(run.status)}">
												{run.status}
											</span>
										</td>
										<td class="px-3 py-2 text-[var(--color-tron-text-secondary)]">
											{formatDateTime(run.runStartTime ?? run.createdAt)}
										</td>
										<td class="px-3 py-2 font-mono text-[var(--color-tron-text-secondary)]">
											{formatDuration(run.runStartTime, run.runEndTime)}
										</td>
										<td class="px-3 py-2 text-center text-[var(--color-tron-text)]">
											{run.cartridgeCount ?? '-'}
										</td>
										<td class="max-w-[180px] truncate px-3 py-2 text-[var(--color-tron-text-secondary)]">
											{run.abortReason ?? '-'}
										</td>
									</tr>
								{/each}
							</tbody>
						</table>
					</div>
				{/if}
			</div>
		{/each}
	</section>
</div>
