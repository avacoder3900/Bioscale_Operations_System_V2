<script lang="ts">
	import { enhance } from '$app/forms';
	import { resolve } from '$app/paths';
	import { page } from '$app/stores';
	import { goto } from '$app/navigation';
	import { SvelteMap } from 'svelte/reactivity';
	import type { DeckRecord, CoolingTrayRecord, RejectionReasonCode } from '$lib/server/db/schema';

	interface Props {
		data: {
			decks: DeckRecord[];
			trays: CoolingTrayRecord[];
			rejectionCodes: RejectionReasonCode[];
			isAdmin: boolean;
			equipmentList: { equipmentId: string; name: string; equipmentType: string; status: string; currentTemperatureC: number | null }[];
			placements: { locationId: string; locationType: string; displayName: string; itemType: string; itemId: string }[];
			activeWaxRuns: { runId: string; robotId: string; deckId: string | null; coolingTrayId: string | null; status: string }[];
			activeReagentRuns: { runId: string; robotId: string; deckId: string | null; status: string }[];
			waxRunHistory: {
				runId: string;
				robotId: string;
				deckId: string | null;
				coolingTrayId: string | null;
				waxSourceLot: string | null;
				status: string;
				operatorName: string;
				abortReason: string | null;
				plannedCartridgeCount: number | null;
				runStartTime: string | null;
				runEndTime: string | null;
				createdAt: string;
			}[];
			reagentRunHistory: {
				runId: string;
				robotId: string;
				deckId: string | null;
				status: string;
				operatorName: string;
				abortReason: string | null;
				cartridgeCount: number | null;
				runStartTime: string | null;
				runEndTime: string | null;
				createdAt: string;
			}[];
		};
		form: { success?: boolean; error?: string; message?: string } | null;
	}

	let { data, form }: Props = $props();

	// Tab state — persist via URL param so it survives form submissions
	let activeTab = $derived.by(() => {
		const t = $page.url.searchParams.get('tab');
		return t === 'decks-trays' ? 'decks-trays' as const : 'overview' as const;
	});

	function setTab(tab: 'overview' | 'decks-trays') {
		const url = new URL($page.url);
		if (tab === 'overview') {
			url.searchParams.delete('tab');
		} else {
			url.searchParams.set('tab', tab);
		}
		goto(url.toString(), { replaceState: true, noScroll: true });
	}

	let saving = $state(false);

	// Equipment lookup
	let lookupBarcode = $state('');
	let lookupResult = $state<
		{ type: 'deck'; item: DeckRecord } | { type: 'tray'; item: CoolingTrayRecord } | null
	>(null);
	let lookupError = $state('');

	function lookupEquipment() {
		const bc = lookupBarcode.trim();
		if (!bc) return;
		lookupError = '';
		lookupResult = null;

		const deck = data.decks.find((d) => d.deckId === bc);
		if (deck) {
			lookupResult = { type: 'deck', item: deck };
			return;
		}
		const tray = data.trays.find((t) => t.trayId === bc);
		if (tray) {
			lookupResult = { type: 'tray', item: tray };
			return;
		}
		lookupError = `No deck or tray found with barcode "${bc}"`;
	}

	function handleLookupKeydown(e: KeyboardEvent) {
		if (e.key === 'Enter') {
			e.preventDefault();
			lookupEquipment();
		}
	}

	// Rejection code management
	let showAddCode = $state(false);
	let editingCodeId = $state<string | null>(null);

	const DECK_STATUSES = [
		'Available',
		'In Use',
		'Cooldown Lockout',
		'Needs Cleaning',
		'Out of Service'
	];
	const TRAY_STATUSES = ['Available', 'In Use', 'In QC', 'Needs Cleaning'];

	function statusColor(status: string): string {
		switch (status) {
			case 'Available':
				return 'text-green-300 bg-green-900/30 border-green-500/30';
			case 'In Use':
				return 'text-blue-300 bg-blue-900/30 border-blue-500/30';
			case 'Cooldown Lockout':
				return 'text-yellow-300 bg-yellow-900/30 border-yellow-500/30';
			case 'Needs Cleaning':
				return 'text-orange-300 bg-orange-900/30 border-orange-500/30';
			case 'Out of Service':
				return 'text-red-300 bg-red-900/30 border-red-500/30';
			case 'In QC':
				return 'text-purple-300 bg-purple-900/30 border-purple-500/30';
			default:
				return 'text-[var(--color-tron-text-secondary)] bg-[var(--color-tron-surface)] border-[var(--color-tron-border)]';
		}
	}

	function formatTime(date: Date | string | null): string {
		if (!date) return '-';
		return new Date(date).toLocaleString();
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

	function runStatusColor(status: string): string {
		switch (status) {
			case 'Completed':
				return 'text-green-300 bg-green-900/30 border-green-500/30';
			case 'Aborted':
				return 'text-red-300 bg-red-900/30 border-red-500/30';
			case 'Cancelled':
				return 'text-orange-300 bg-orange-900/30 border-orange-500/30';
			case 'Running':
				return 'text-blue-300 bg-blue-900/30 border-blue-500/30';
			default:
				return 'text-[var(--color-tron-text-secondary)] bg-[var(--color-tron-surface)] border-[var(--color-tron-border)]';
		}
	}

	// ---- Overview Diagram Logic ----
	let fridges = $derived(data.equipmentList.filter((e) => e.equipmentType === 'fridge'));
	let ovens = $derived(data.equipmentList.filter((e) => e.equipmentType === 'oven'));

	// Build a map: itemId -> location
	type ItemLocation = { zone: 'fridge' | 'oven' | 'robot' | 'table'; label: string; runId?: string; runStatus?: string };

	let itemLocations = $derived.by(() => {
		const map = new SvelteMap<string, ItemLocation>();

		// 1. Check location placements (fridge/oven)
		for (const p of data.placements) {
			if (p.itemType === 'deck' || p.itemType === 'tray') {
				map.set(p.itemId, {
					zone: p.locationType as 'fridge' | 'oven',
					label: p.displayName
				});
			}
		}

		// 2. Check active wax runs (deck on robot, tray on robot/cooling)
		for (const run of data.activeWaxRuns) {
			if (run.deckId && ['Loading', 'Running', 'Awaiting Removal'].includes(run.status)) {
				map.set(run.deckId, {
					zone: 'robot',
					label: run.robotId === 'robot-1' ? 'Robot 1' : run.robotId === 'robot-2' ? 'Robot 2' : run.robotId,
					runId: run.runId,
					runStatus: run.status
				});
			}
			if (run.coolingTrayId && ['Cooling', 'QC', 'Awaiting Removal'].includes(run.status)) {
				if (!map.has(run.coolingTrayId)) {
					map.set(run.coolingTrayId, {
						zone: 'robot',
						label: run.robotId === 'robot-1' ? 'Robot 1' : run.robotId === 'robot-2' ? 'Robot 2' : run.robotId,
						runId: run.runId,
						runStatus: run.status
					});
				}
			}
		}

		// 3. Check active reagent runs (deck on robot)
		for (const run of data.activeReagentRuns) {
			if (run.deckId && !map.has(run.deckId)) {
				map.set(run.deckId, {
					zone: 'robot',
					label: run.robotId === 'robot-1' ? 'Robot 1' : run.robotId === 'robot-2' ? 'Robot 2' : run.robotId,
					runId: run.runId,
					runStatus: run.status
				});
			}
		}

		// 4. Also check deck.currentRobotId for in-use decks
		for (const deck of data.decks) {
			if (deck.status === 'In Use' && deck.currentRobotId && !map.has(deck.deckId)) {
				map.set(deck.deckId, {
					zone: 'robot',
					label: deck.currentRobotId === 'robot-1' ? 'Robot 1' : deck.currentRobotId === 'robot-2' ? 'Robot 2' : deck.currentRobotId
				});
			}
		}

		return map;
	});

	// Group items by zone
	type ZoneItem = { id: string; type: 'deck' | 'tray'; status: string; runId?: string; runStatus?: string };

	let fridgeItems = $derived.by(() => {
		const grouped = new SvelteMap<string, ZoneItem[]>();
		for (const f of fridges) {
			grouped.set(f.name, []);
		}
		for (const [itemId, loc] of itemLocations) {
			if (loc.zone === 'fridge') {
				const items = grouped.get(loc.label) ?? [];
				const deck = data.decks.find((d) => d.deckId === itemId);
				const tray = data.trays.find((t) => t.trayId === itemId);
				items.push({
					id: itemId,
					type: deck ? 'deck' : 'tray',
					status: deck?.status ?? tray?.status ?? 'Unknown'
				});
				grouped.set(loc.label, items);
			}
		}
		return grouped;
	});

	let ovenItems = $derived.by(() => {
		const grouped = new SvelteMap<string, ZoneItem[]>();
		for (const o of ovens) {
			grouped.set(o.name, []);
		}
		for (const [itemId, loc] of itemLocations) {
			if (loc.zone === 'oven') {
				const items = grouped.get(loc.label) ?? [];
				const deck = data.decks.find((d) => d.deckId === itemId);
				const tray = data.trays.find((t) => t.trayId === itemId);
				items.push({
					id: itemId,
					type: deck ? 'deck' : 'tray',
					status: deck?.status ?? tray?.status ?? 'Unknown'
				});
				grouped.set(loc.label, items);
			}
		}
		return grouped;
	});

	let robotItems = $derived.by(() => {
		const grouped = new SvelteMap<string, ZoneItem[]>();
		grouped.set('Robot 1', []);
		grouped.set('Robot 2', []);
		for (const [itemId, loc] of itemLocations) {
			if (loc.zone === 'robot') {
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
	});

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

	// Run history: combine and group by deck/tray
	type RunHistoryEntry = {
		runId: string;
		processType: 'wax' | 'reagent';
		robotId: string;
		deckId: string | null;
		coolingTrayId: string | null;
		status: string;
		operatorName: string;
		abortReason: string | null;
		cartridgeCount: number | null;
		runStartTime: string | null;
		runEndTime: string | null;
		createdAt: string;
	};

	let allRunHistory = $derived.by(() => {
		const entries: RunHistoryEntry[] = [];
		for (const r of data.waxRunHistory) {
			entries.push({
				runId: r.runId,
				processType: 'wax',
				robotId: r.robotId,
				deckId: r.deckId,
				coolingTrayId: r.coolingTrayId,
				status: r.status,
				operatorName: r.operatorName,
				abortReason: r.abortReason,
				cartridgeCount: r.plannedCartridgeCount,
				runStartTime: r.runStartTime,
				runEndTime: r.runEndTime,
				createdAt: r.createdAt
			});
		}
		for (const r of data.reagentRunHistory) {
			entries.push({
				runId: r.runId,
				processType: 'reagent',
				robotId: r.robotId,
				deckId: r.deckId,
				coolingTrayId: null,
				status: r.status,
				operatorName: r.operatorName,
				abortReason: r.abortReason,
				cartridgeCount: r.cartridgeCount,
				runStartTime: r.runStartTime,
				runEndTime: r.runEndTime,
				createdAt: r.createdAt
			});
		}
		entries.sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
		return entries;
	});

	// Group run history by equipment (deck or tray)
	let deckRunHistory = $derived.by(() => {
		const map = new SvelteMap<string, RunHistoryEntry[]>();
		for (const deck of data.decks) {
			map.set(deck.deckId, []);
		}
		for (const entry of allRunHistory) {
			if (entry.deckId) {
				const arr = map.get(entry.deckId) ?? [];
				arr.push(entry);
				map.set(entry.deckId, arr);
			}
		}
		return map;
	});

	let trayRunHistory = $derived.by(() => {
		const map = new SvelteMap<string, RunHistoryEntry[]>();
		for (const tray of data.trays) {
			map.set(tray.trayId, []);
		}
		for (const entry of allRunHistory) {
			if (entry.coolingTrayId) {
				const arr = map.get(entry.coolingTrayId) ?? [];
				arr.push(entry);
				map.set(entry.coolingTrayId, arr);
			}
		}
		return map;
	});
</script>

<div class="space-y-6">
	<div class="flex items-center justify-between">
		<h1 class="text-2xl font-semibold text-[var(--color-tron-text)]">Equipment</h1>
		<a
			href={resolve('/spu/manufacturing/wax-filling')}
			class="inline-flex min-h-[44px] items-center rounded border border-[var(--color-tron-border)] px-4 py-2 text-sm text-[var(--color-tron-text-secondary)] transition-colors hover:text-[var(--color-tron-text)]"
		>
			Back to Wax Filling
		</a>
	</div>

	{#if form?.success}
		<div class="rounded border border-green-500/30 bg-green-900/20 px-4 py-3 text-sm text-green-300">
			{form.message ?? 'Operation successful.'}
		</div>
	{/if}

	{#if form?.error}
		<div class="rounded border border-red-500/30 bg-red-900/20 px-4 py-3 text-sm text-red-300">
			{form.error}
		</div>
	{/if}

	<!-- Tab Navigation -->
	<div class="flex gap-1 border-b border-[var(--color-tron-border)]">
		<button
			type="button"
			onclick={() => setTab('overview')}
			class="min-h-[44px] border-b-2 px-5 py-2.5 text-sm font-medium transition-colors {activeTab === 'overview'
				? 'border-[var(--color-tron-cyan)] text-[var(--color-tron-cyan)]'
				: 'border-transparent text-[var(--color-tron-text-secondary)] hover:text-[var(--color-tron-text)]'}"
		>
			Overview
		</button>
		<button
			type="button"
			onclick={() => setTab('decks-trays')}
			class="min-h-[44px] border-b-2 px-5 py-2.5 text-sm font-medium transition-colors {activeTab === 'decks-trays'
				? 'border-[var(--color-tron-cyan)] text-[var(--color-tron-cyan)]'
				: 'border-transparent text-[var(--color-tron-text-secondary)] hover:text-[var(--color-tron-text)]'}"
		>
			Decks & Trays
		</button>
	</div>

	<!-- ====================================================================== -->
	<!-- OVERVIEW TAB -->
	<!-- ====================================================================== -->
	{#if activeTab === 'overview'}
		<div class="space-y-8">
			<!-- Equipment Diagram -->
			<section class="space-y-4">
				<h2 class="text-lg font-semibold text-[var(--color-tron-text)]">Equipment Layout</h2>

				<div class="grid grid-cols-1 gap-4 xl:grid-cols-2">
					<!-- Left: Fridges -->
					<div class="space-y-3">
						<h3 class="flex items-center gap-2 text-sm font-semibold text-blue-300">
							<svg class="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2">
								<path stroke-linecap="round" stroke-linejoin="round" d="M20 7l-8-4-8 4m16 0l-8 4m8-4v10l-8 4m0-10L4 7m8 4v10M4 7v10l8 4" />
							</svg>
							Fridges
						</h3>
						{#if fridges.length === 0}
							<div class="rounded-lg border border-dashed border-blue-500/30 bg-blue-900/10 p-4 text-center">
								<p class="text-xs text-blue-300/60">No fridges registered</p>
							</div>
						{/if}
						{#each fridges as fridge (fridge.equipmentId)}
							{@const items = fridgeItems.get(fridge.name) ?? []}
							<div class="rounded-lg border border-blue-500/30 bg-gradient-to-br from-blue-950/40 to-blue-900/20 p-4">
								<div class="mb-2 flex items-center justify-between">
									<span class="text-sm font-medium text-blue-200">{fridge.name}</span>
									<div class="flex items-center gap-2">
										{#if fridge.currentTemperatureC != null}
											<span class="rounded-full bg-blue-900/50 px-2 py-0.5 font-mono text-xs text-blue-300">
												{fridge.currentTemperatureC.toFixed(1)}°C
											</span>
										{/if}
										<span class="h-2 w-2 rounded-full {fridge.status === 'active' ? 'bg-green-400' : 'bg-red-400'}"></span>
									</div>
								</div>
								{#if items.length === 0}
									<p class="py-2 text-center text-xs text-blue-300/40">Empty</p>
								{:else}
									<div class="flex flex-wrap gap-1.5">
										{#each items as item (item.id)}
											<span class="inline-flex items-center gap-1 rounded border px-2 py-1 text-xs font-medium {item.type === 'deck'
												? 'border-cyan-500/40 bg-cyan-900/30 text-cyan-200'
												: 'border-purple-500/40 bg-purple-900/30 text-purple-200'}">
												<span class="h-1.5 w-1.5 rounded-full {item.type === 'deck' ? 'bg-cyan-400' : 'bg-purple-400'}"></span>
												{item.id}
											</span>
										{/each}
									</div>
								{/if}
							</div>
						{/each}
					</div>

					<!-- Right: Ovens -->
					<div class="space-y-3">
						<h3 class="flex items-center gap-2 text-sm font-semibold text-orange-300">
							<svg class="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2">
								<path stroke-linecap="round" stroke-linejoin="round" d="M17.657 18.657A8 8 0 016.343 7.343S7 9 9 10c0-2 .5-5 2.986-7C14 5 16.09 5.777 17.656 7.343A7.975 7.975 0 0120 13a7.975 7.975 0 01-2.343 5.657z" />
								<path stroke-linecap="round" stroke-linejoin="round" d="M9.879 16.121A3 3 0 1012.015 11L11 14H9c0 .768.293 1.536.879 2.121z" />
							</svg>
							Ovens
						</h3>
						{#if ovens.length === 0}
							<div class="rounded-lg border border-dashed border-orange-500/30 bg-orange-900/10 p-4 text-center">
								<p class="text-xs text-orange-300/60">No ovens registered</p>
							</div>
						{/if}
						{#each ovens as oven (oven.equipmentId)}
							{@const items = ovenItems.get(oven.name) ?? []}
							<div class="rounded-lg border border-orange-500/30 bg-gradient-to-br from-orange-950/40 to-orange-900/20 p-4">
								<div class="mb-2 flex items-center justify-between">
									<span class="text-sm font-medium text-orange-200">{oven.name}</span>
									<div class="flex items-center gap-2">
										{#if oven.currentTemperatureC != null}
											<span class="rounded-full bg-orange-900/50 px-2 py-0.5 font-mono text-xs text-orange-300">
												{oven.currentTemperatureC.toFixed(1)}°C
											</span>
										{/if}
										<span class="h-2 w-2 rounded-full {oven.status === 'active' ? 'bg-green-400' : 'bg-red-400'}"></span>
									</div>
								</div>
								{#if items.length === 0}
									<p class="py-2 text-center text-xs text-orange-300/40">Empty</p>
								{:else}
									<div class="flex flex-wrap gap-1.5">
										{#each items as item (item.id)}
											<span class="inline-flex items-center gap-1 rounded border px-2 py-1 text-xs font-medium {item.type === 'deck'
												? 'border-cyan-500/40 bg-cyan-900/30 text-cyan-200'
												: 'border-purple-500/40 bg-purple-900/30 text-purple-200'}">
												<span class="h-1.5 w-1.5 rounded-full {item.type === 'deck' ? 'bg-cyan-400' : 'bg-purple-400'}"></span>
												{item.id}
											</span>
										{/each}
									</div>
								{/if}
							</div>
						{/each}
					</div>
				</div>

				<!-- Robots Row -->
				<div class="grid grid-cols-1 gap-4 sm:grid-cols-2">
					{#each [...robotItems] as [robotName, items] (robotName)}
						{@const hasActiveRun = items.some((i) => i.runId)}
						<div class="rounded-lg border {hasActiveRun ? 'border-green-500/40 bg-gradient-to-br from-green-950/30 to-green-900/10' : 'border-[var(--color-tron-border)] bg-[var(--color-tron-surface)]'} p-4">
							<div class="mb-2 flex items-center gap-2">
								<svg class="h-5 w-5 text-[var(--color-tron-cyan)]" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2">
									<path stroke-linecap="round" stroke-linejoin="round" d="M9 3v2m6-2v2M9 19v2m6-2v2M5 9H3m2 6H3m18-6h-2m2 6h-2M7 19h10a2 2 0 002-2V7a2 2 0 00-2-2H7a2 2 0 00-2 2v10a2 2 0 002 2zM9 9h6v6H9V9z" />
								</svg>
								<span class="text-sm font-semibold text-[var(--color-tron-text)]">{robotName}</span>
								{#if hasActiveRun}
									<span class="rounded-full bg-green-900/50 px-2 py-0.5 text-xs font-medium text-green-300">Active</span>
								{:else}
									<span class="rounded-full bg-[var(--color-tron-surface)] px-2 py-0.5 text-xs text-[var(--color-tron-text-secondary)]">Idle</span>
								{/if}
							</div>
							{#if items.length === 0}
								<p class="py-3 text-center text-xs text-[var(--color-tron-text-secondary)]">No equipment loaded</p>
							{:else}
								<div class="space-y-1.5">
									{#each items as item (item.id)}
										<div class="flex items-center justify-between rounded border border-[var(--color-tron-border)]/50 bg-[var(--color-tron-bg)] px-3 py-2">
											<div class="flex items-center gap-2">
												<span class="h-2 w-2 rounded-full {item.type === 'deck' ? 'bg-cyan-400' : 'bg-purple-400'}"></span>
												<span class="text-xs font-medium text-[var(--color-tron-text)]">{item.id}</span>
												<span class="rounded border px-1.5 py-0.5 text-[10px] {item.type === 'deck'
													? 'border-cyan-500/30 text-cyan-300'
													: 'border-purple-500/30 text-purple-300'}">{item.type}</span>
											</div>
											{#if item.runStatus}
												<span class="rounded border px-1.5 py-0.5 text-[10px] font-medium {runStatusColor(item.runStatus)}">
													{item.runStatus}
												</span>
											{/if}
										</div>
									{/each}
								</div>
							{/if}
						</div>
					{/each}
				</div>

				<!-- Workbench / Table -->
				<div class="rounded-lg border border-[var(--color-tron-border)] bg-[var(--color-tron-surface)] p-4">
					<div class="mb-3 flex items-center gap-2">
						<svg class="h-5 w-5 text-[var(--color-tron-text-secondary)]" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2">
							<path stroke-linecap="round" stroke-linejoin="round" d="M4 6h16M4 12h16M4 18h7" />
						</svg>
						<span class="text-sm font-semibold text-[var(--color-tron-text)]">Workbench</span>
						<span class="text-xs text-[var(--color-tron-text-secondary)]">({tableItems.length} items)</span>
					</div>
					{#if tableItems.length === 0}
						<p class="py-3 text-center text-xs text-[var(--color-tron-text-secondary)]">No items on workbench</p>
					{:else}
						<div class="flex flex-wrap gap-2">
							{#each tableItems as item (item.id)}
								<div class="inline-flex items-center gap-2 rounded-lg border border-[var(--color-tron-border)]/50 bg-[var(--color-tron-bg)] px-3 py-2">
									<span class="h-2 w-2 rounded-full {item.type === 'deck' ? 'bg-cyan-400' : 'bg-purple-400'}"></span>
									<span class="text-xs font-medium text-[var(--color-tron-text)]">{item.id}</span>
									<span class="rounded border px-1.5 py-0.5 text-[10px] {item.type === 'deck'
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

				<!-- Legend -->
				<div class="flex flex-wrap items-center gap-4 rounded border border-[var(--color-tron-border)]/50 bg-[var(--color-tron-bg)] px-4 py-2">
					<span class="text-xs font-medium text-[var(--color-tron-text-secondary)]">Legend:</span>
					<span class="inline-flex items-center gap-1 text-xs text-cyan-300">
						<span class="h-2 w-2 rounded-full bg-cyan-400"></span> Deck
					</span>
					<span class="inline-flex items-center gap-1 text-xs text-purple-300">
						<span class="h-2 w-2 rounded-full bg-purple-400"></span> Tray
					</span>
				</div>
			</section>

			<!-- Run History -->
			<section class="space-y-4">
				<h2 class="text-lg font-semibold text-[var(--color-tron-text)]">Run History</h2>

				<!-- Deck History -->
				{#each data.decks as deck (deck.deckId)}
					{@const history = deckRunHistory.get(deck.deckId) ?? []}
					<div class="rounded-lg border border-[var(--color-tron-border)] bg-[var(--color-tron-surface)]">
						<div class="flex items-center justify-between border-b border-[var(--color-tron-border)] px-4 py-3">
							<div class="flex items-center gap-2">
								<span class="h-2.5 w-2.5 rounded-full bg-cyan-400"></span>
								<span class="text-sm font-semibold text-[var(--color-tron-text)]">{deck.deckId}</span>
								<span class="rounded border px-1.5 py-0.5 text-[10px] border-cyan-500/30 text-cyan-300">deck</span>
								<span class="rounded border px-1.5 py-0.5 text-[10px] font-medium {statusColor(deck.status)}">
									{deck.status}
								</span>
							</div>
							<span class="text-xs text-[var(--color-tron-text-secondary)]">{history.length} runs</span>
						</div>
						{#if history.length === 0}
							<div class="px-4 py-4 text-center text-xs text-[var(--color-tron-text-secondary)]">
								No run history for this deck
							</div>
						{:else}
							<div class="overflow-x-auto">
								<table class="w-full text-xs">
									<thead>
										<tr class="border-b border-[var(--color-tron-border)]/50 text-left text-[var(--color-tron-text-secondary)]">
											<th class="px-4 py-2 font-medium">Run ID</th>
											<th class="px-3 py-2 font-medium">Type</th>
											<th class="px-3 py-2 font-medium">Robot</th>
											<th class="px-3 py-2 font-medium">Operator</th>
											<th class="px-3 py-2 font-medium">Status</th>
											<th class="px-3 py-2 font-medium">Started</th>
											<th class="px-3 py-2 font-medium">Duration</th>
											<th class="px-3 py-2 font-medium">Cartridges</th>
											<th class="px-3 py-2 font-medium">Notes</th>
										</tr>
									</thead>
									<tbody>
										{#each history as run (run.runId)}
											<tr class="border-b border-[var(--color-tron-border)]/30 hover:bg-[var(--color-tron-bg)]">
												<td class="px-4 py-2 font-mono text-[var(--color-tron-cyan)]">{run.runId}</td>
												<td class="px-3 py-2">
													<span class="rounded px-1.5 py-0.5 text-[10px] font-medium {run.processType === 'wax'
														? 'bg-amber-900/30 text-amber-300'
														: 'bg-teal-900/30 text-teal-300'}">
														{run.processType === 'wax' ? 'Wax' : 'Reagent'}
													</span>
												</td>
												<td class="px-3 py-2 text-[var(--color-tron-text-secondary)]">{run.robotId}</td>
												<td class="px-3 py-2 text-[var(--color-tron-text)]">{run.operatorName}</td>
												<td class="px-3 py-2">
													<span class="rounded border px-1.5 py-0.5 text-[10px] font-medium {runStatusColor(run.status)}">
														{run.status}
													</span>
												</td>
												<td class="px-3 py-2 text-[var(--color-tron-text-secondary)]">
													{run.runStartTime ? new Date(run.runStartTime).toLocaleString() : formatTime(run.createdAt)}
												</td>
												<td class="px-3 py-2 text-[var(--color-tron-text-secondary)]">
													{formatDuration(run.runStartTime, run.runEndTime)}
												</td>
												<td class="px-3 py-2 text-center text-[var(--color-tron-text)]">
													{run.cartridgeCount ?? '-'}
												</td>
												<td class="max-w-[200px] truncate px-3 py-2 text-[var(--color-tron-text-secondary)]">
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

				<!-- Tray History -->
				{#each data.trays as tray (tray.trayId)}
					{@const history = trayRunHistory.get(tray.trayId) ?? []}
					<div class="rounded-lg border border-[var(--color-tron-border)] bg-[var(--color-tron-surface)]">
						<div class="flex items-center justify-between border-b border-[var(--color-tron-border)] px-4 py-3">
							<div class="flex items-center gap-2">
								<span class="h-2.5 w-2.5 rounded-full bg-purple-400"></span>
								<span class="text-sm font-semibold text-[var(--color-tron-text)]">{tray.trayId}</span>
								<span class="rounded border px-1.5 py-0.5 text-[10px] border-purple-500/30 text-purple-300">tray</span>
								<span class="rounded border px-1.5 py-0.5 text-[10px] font-medium {statusColor(tray.status)}">
									{tray.status}
								</span>
							</div>
							<span class="text-xs text-[var(--color-tron-text-secondary)]">{history.length} runs</span>
						</div>
						{#if history.length === 0}
							<div class="px-4 py-4 text-center text-xs text-[var(--color-tron-text-secondary)]">
								No run history for this tray
							</div>
						{:else}
							<div class="overflow-x-auto">
								<table class="w-full text-xs">
									<thead>
										<tr class="border-b border-[var(--color-tron-border)]/50 text-left text-[var(--color-tron-text-secondary)]">
											<th class="px-4 py-2 font-medium">Run ID</th>
											<th class="px-3 py-2 font-medium">Type</th>
											<th class="px-3 py-2 font-medium">Robot</th>
											<th class="px-3 py-2 font-medium">Operator</th>
											<th class="px-3 py-2 font-medium">Status</th>
											<th class="px-3 py-2 font-medium">Started</th>
											<th class="px-3 py-2 font-medium">Duration</th>
											<th class="px-3 py-2 font-medium">Cartridges</th>
											<th class="px-3 py-2 font-medium">Notes</th>
										</tr>
									</thead>
									<tbody>
										{#each history as run (run.runId)}
											<tr class="border-b border-[var(--color-tron-border)]/30 hover:bg-[var(--color-tron-bg)]">
												<td class="px-4 py-2 font-mono text-[var(--color-tron-cyan)]">{run.runId}</td>
												<td class="px-3 py-2">
													<span class="rounded px-1.5 py-0.5 text-[10px] font-medium {run.processType === 'wax'
														? 'bg-amber-900/30 text-amber-300'
														: 'bg-teal-900/30 text-teal-300'}">
														{run.processType === 'wax' ? 'Wax' : 'Reagent'}
													</span>
												</td>
												<td class="px-3 py-2 text-[var(--color-tron-text-secondary)]">{run.robotId}</td>
												<td class="px-3 py-2 text-[var(--color-tron-text)]">{run.operatorName}</td>
												<td class="px-3 py-2">
													<span class="rounded border px-1.5 py-0.5 text-[10px] font-medium {runStatusColor(run.status)}">
														{run.status}
													</span>
												</td>
												<td class="px-3 py-2 text-[var(--color-tron-text-secondary)]">
													{run.runStartTime ? new Date(run.runStartTime).toLocaleString() : formatTime(run.createdAt)}
												</td>
												<td class="px-3 py-2 text-[var(--color-tron-text-secondary)]">
													{formatDuration(run.runStartTime, run.runEndTime)}
												</td>
												<td class="px-3 py-2 text-center text-[var(--color-tron-text)]">
													{run.cartridgeCount ?? '-'}
												</td>
												<td class="max-w-[200px] truncate px-3 py-2 text-[var(--color-tron-text-secondary)]">
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
	{/if}

	<!-- ====================================================================== -->
	<!-- DECKS & TRAYS TAB (existing content) -->
	<!-- ====================================================================== -->
	{#if activeTab === 'decks-trays'}
		<div class="space-y-8">
			<!-- Equipment Lookup -->
			<section class="rounded-lg border border-[var(--color-tron-border)] bg-[var(--color-tron-surface)] p-5">
				<h2 class="mb-4 text-lg font-medium text-[var(--color-tron-cyan)]">Equipment Lookup</h2>
				<div class="flex gap-2">
					<input
						type="text"
						bind:value={lookupBarcode}
						onkeydown={handleLookupKeydown}
						placeholder="Scan deck or tray barcode..."
						class="min-h-[44px] flex-1 rounded border border-[var(--color-tron-border)] bg-[var(--color-tron-bg)] px-3 py-2 text-sm text-[var(--color-tron-text)] placeholder-[var(--color-tron-text-secondary)] focus:border-[var(--color-tron-cyan)] focus:outline-none"
					/>
					<button
						type="button"
						onclick={lookupEquipment}
						class="min-h-[44px] rounded border border-[var(--color-tron-cyan)]/50 bg-[var(--color-tron-cyan)]/10 px-4 py-2 text-sm font-medium text-[var(--color-tron-cyan)] transition-colors hover:bg-[var(--color-tron-cyan)]/20"
					>
						Search
					</button>
				</div>

				{#if lookupError}
					<p class="mt-3 text-sm text-red-400">{lookupError}</p>
				{/if}

				{#if lookupResult}
					<div class="mt-4 rounded border border-[var(--color-tron-border)] bg-[var(--color-tron-bg)] p-4">
						{#if lookupResult.type === 'deck'}
							{@const deck = lookupResult.item as DeckRecord}
							<div class="mb-3 flex items-center gap-3">
								<h3 class="text-base font-medium text-[var(--color-tron-text)]">Deck: {deck.deckId}</h3>
								<span class="rounded border px-2 py-0.5 text-xs font-medium {statusColor(deck.status)}">
									{deck.status}
								</span>
							</div>
							<dl class="grid grid-cols-2 gap-2 text-sm">
								<dt class="text-[var(--color-tron-text-secondary)]">Current Robot</dt>
								<dd class="text-[var(--color-tron-text)]">{deck.currentRobotId ?? '-'}</dd>
								<dt class="text-[var(--color-tron-text-secondary)]">Lockout Until</dt>
								<dd class="text-[var(--color-tron-text)]">{formatTime(deck.lockoutUntil)}</dd>
								<dt class="text-[var(--color-tron-text-secondary)]">Last Used</dt>
								<dd class="text-[var(--color-tron-text)]">{formatTime(deck.lastUsed)}</dd>
							</dl>

							{#if data.isAdmin}
								<form
									method="POST"
									action="?/updateDeckStatus"
									use:enhance={() => {
										saving = true;
										return async ({ update }) => {
											await update();
											saving = false;
											lookupResult = null;
											lookupBarcode = '';
										};
									}}
									class="mt-4 flex items-end gap-2"
								>
									<input type="hidden" name="deckId" value={deck.deckId} />
									<label class="flex-1">
										<span class="mb-1 block text-xs text-[var(--color-tron-text-secondary)]">Set Status</span>
										<select
											name="status"
											class="min-h-[44px] w-full rounded border border-[var(--color-tron-border)] bg-[var(--color-tron-bg)] px-3 py-2 text-sm text-[var(--color-tron-text)]"
										>
											{#each DECK_STATUSES as s (s)}
												<option value={s} selected={s === deck.status}>{s}</option>
											{/each}
										</select>
									</label>
									<button
										type="submit"
										disabled={saving}
										class="min-h-[44px] rounded border border-[var(--color-tron-cyan)]/50 bg-[var(--color-tron-cyan)]/10 px-4 py-2 text-sm font-medium text-[var(--color-tron-cyan)] transition-colors hover:bg-[var(--color-tron-cyan)]/20 disabled:opacity-50"
									>
										Update
									</button>
								</form>
							{/if}
						{:else}
							{@const tray = lookupResult.item as CoolingTrayRecord}
							<div class="mb-3 flex items-center gap-3">
								<h3 class="text-base font-medium text-[var(--color-tron-text)]">Tray: {tray.trayId}</h3>
								<span class="rounded border px-2 py-0.5 text-xs font-medium {statusColor(tray.status)}">
									{tray.status}
								</span>
							</div>
							<dl class="grid grid-cols-2 gap-2 text-sm">
								<dt class="text-[var(--color-tron-text-secondary)]">Assigned Run</dt>
								<dd class="text-[var(--color-tron-text)]">{tray.assignedRunId ?? '-'}</dd>
								<dt class="text-[var(--color-tron-text-secondary)]">Updated</dt>
								<dd class="text-[var(--color-tron-text)]">{formatTime(tray.updatedAt)}</dd>
							</dl>

							{#if data.isAdmin}
								<form
									method="POST"
									action="?/updateTrayStatus"
									use:enhance={() => {
										saving = true;
										return async ({ update }) => {
											await update();
											saving = false;
											lookupResult = null;
											lookupBarcode = '';
										};
									}}
									class="mt-4 flex items-end gap-2"
								>
									<input type="hidden" name="trayId" value={tray.trayId} />
									<label class="flex-1">
										<span class="mb-1 block text-xs text-[var(--color-tron-text-secondary)]">Set Status</span>
										<select
											name="status"
											class="min-h-[44px] w-full rounded border border-[var(--color-tron-border)] bg-[var(--color-tron-bg)] px-3 py-2 text-sm text-[var(--color-tron-text)]"
										>
											{#each TRAY_STATUSES as s (s)}
												<option value={s} selected={s === tray.status}>{s}</option>
											{/each}
										</select>
									</label>
									<button
										type="submit"
										disabled={saving}
										class="min-h-[44px] rounded border border-[var(--color-tron-cyan)]/50 bg-[var(--color-tron-cyan)]/10 px-4 py-2 text-sm font-medium text-[var(--color-tron-cyan)] transition-colors hover:bg-[var(--color-tron-cyan)]/20 disabled:opacity-50"
									>
										Update
									</button>
								</form>
							{/if}
						{/if}
					</div>
				{/if}
			</section>

			<!-- Equipment Registry Tables -->
			<div class="grid gap-6 lg:grid-cols-2">
				<!-- Decks -->
				<section class="rounded-lg border border-[var(--color-tron-border)] bg-[var(--color-tron-surface)] p-5">
					<h2 class="mb-4 text-lg font-medium text-[var(--color-tron-cyan)]">
						Decks ({data.decks.length})
					</h2>
					{#if data.decks.length === 0}
						<p class="text-sm text-[var(--color-tron-text-secondary)]">No decks registered.</p>
					{:else}
						<div class="overflow-x-auto">
							<table class="w-full text-sm">
								<thead>
									<tr class="border-b border-[var(--color-tron-border)] text-left text-[var(--color-tron-text-secondary)]">
										<th class="py-2 pr-3 font-medium">Deck ID</th>
										<th class="py-2 pr-3 font-medium">Status</th>
										<th class="py-2 font-medium">Last Used</th>
									</tr>
								</thead>
								<tbody>
									{#each data.decks as deck (deck.deckId)}
										<tr class="border-b border-[var(--color-tron-border)]/50">
											<td class="py-2 pr-3 text-[var(--color-tron-text)]">{deck.deckId}</td>
											<td class="py-2 pr-3">
												<span class="rounded border px-2 py-0.5 text-xs font-medium {statusColor(deck.status)}">
													{deck.status}
												</span>
											</td>
											<td class="py-2 text-[var(--color-tron-text-secondary)]">{formatTime(deck.lastUsed)}</td>
										</tr>
									{/each}
								</tbody>
							</table>
						</div>
					{/if}
				</section>

				<!-- Cooling Trays -->
				<section class="rounded-lg border border-[var(--color-tron-border)] bg-[var(--color-tron-surface)] p-5">
					<h2 class="mb-4 text-lg font-medium text-[var(--color-tron-cyan)]">
						Cooling Trays ({data.trays.length})
					</h2>
					{#if data.trays.length === 0}
						<p class="text-sm text-[var(--color-tron-text-secondary)]">No cooling trays registered.</p>
					{:else}
						<div class="overflow-x-auto">
							<table class="w-full text-sm">
								<thead>
									<tr class="border-b border-[var(--color-tron-border)] text-left text-[var(--color-tron-text-secondary)]">
										<th class="py-2 pr-3 font-medium">Tray ID</th>
										<th class="py-2 pr-3 font-medium">Status</th>
										<th class="py-2 font-medium">Updated</th>
									</tr>
								</thead>
								<tbody>
									{#each data.trays as tray (tray.trayId)}
										<tr class="border-b border-[var(--color-tron-border)]/50">
											<td class="py-2 pr-3 text-[var(--color-tron-text)]">{tray.trayId}</td>
											<td class="py-2 pr-3">
												<span class="rounded border px-2 py-0.5 text-xs font-medium {statusColor(tray.status)}">
													{tray.status}
												</span>
											</td>
											<td class="py-2 text-[var(--color-tron-text-secondary)]">{formatTime(tray.updatedAt)}</td>
										</tr>
									{/each}
								</tbody>
							</table>
						</div>
					{/if}
				</section>
			</div>

			<!-- Rejection Codes -->
			<section class="rounded-lg border border-[var(--color-tron-border)] bg-[var(--color-tron-surface)] p-5">
				<div class="mb-4 flex items-center justify-between">
					<h2 class="text-lg font-medium text-[var(--color-tron-cyan)]">
						Rejection Codes ({data.rejectionCodes.length})
					</h2>
					{#if data.isAdmin}
						<button
							type="button"
							onclick={() => (showAddCode = !showAddCode)}
							class="min-h-[44px] rounded border border-[var(--color-tron-cyan)]/50 bg-[var(--color-tron-cyan)]/10 px-4 py-2 text-sm font-medium text-[var(--color-tron-cyan)] transition-colors hover:bg-[var(--color-tron-cyan)]/20"
						>
							{showAddCode ? 'Cancel' : 'Add Code'}
						</button>
					{/if}
				</div>

				{#if showAddCode}
					<form
						method="POST"
						action="?/addRejectionCode"
						use:enhance={() => {
							saving = true;
							return async ({ update }) => {
								await update();
								saving = false;
								showAddCode = false;
							};
						}}
						class="mb-4 flex flex-wrap items-end gap-3 rounded border border-[var(--color-tron-border)] bg-[var(--color-tron-bg)] p-4"
					>
						<label class="flex-1">
							<span class="mb-1 block text-xs text-[var(--color-tron-text-secondary)]">Code</span>
							<input
								type="text"
								name="code"
								placeholder="REJ-08"
								required
								pattern={'REJ-\\d{2,3}'}
								class="min-h-[44px] w-full rounded border border-[var(--color-tron-border)] bg-[var(--color-tron-bg)] px-3 py-2 text-sm text-[var(--color-tron-text)] focus:border-[var(--color-tron-cyan)] focus:outline-none"
							/>
						</label>
						<label class="flex-[2]">
							<span class="mb-1 block text-xs text-[var(--color-tron-text-secondary)]">Label</span>
							<input
								type="text"
								name="label"
								placeholder="Description of rejection reason"
								required
								class="min-h-[44px] w-full rounded border border-[var(--color-tron-border)] bg-[var(--color-tron-bg)] px-3 py-2 text-sm text-[var(--color-tron-text)] focus:border-[var(--color-tron-cyan)] focus:outline-none"
							/>
						</label>
						<label>
							<span class="mb-1 block text-xs text-[var(--color-tron-text-secondary)]">Sort Order</span>
							<input
								type="number"
								name="sortOrder"
								value="0"
								min="0"
								class="min-h-[44px] w-24 rounded border border-[var(--color-tron-border)] bg-[var(--color-tron-bg)] px-3 py-2 text-sm text-[var(--color-tron-text)] focus:border-[var(--color-tron-cyan)] focus:outline-none"
							/>
						</label>
						<button
							type="submit"
							disabled={saving}
							class="min-h-[44px] rounded border border-green-500/50 bg-green-900/20 px-4 py-2 text-sm font-medium text-green-300 transition-colors hover:bg-green-900/30 disabled:opacity-50"
						>
							Add
						</button>
					</form>
				{/if}

				{#if data.rejectionCodes.length === 0}
					<p class="text-sm text-[var(--color-tron-text-secondary)]">No rejection codes configured.</p>
				{:else}
					<div class="overflow-x-auto">
						<table class="w-full text-sm">
							<thead>
								<tr class="border-b border-[var(--color-tron-border)] text-left text-[var(--color-tron-text-secondary)]">
									<th class="py-2 pr-3 font-medium">Code</th>
									<th class="py-2 pr-3 font-medium">Label</th>
									<th class="py-2 pr-3 font-medium">Sort Order</th>
									{#if data.isAdmin}
										<th class="py-2 font-medium">Actions</th>
									{/if}
								</tr>
							</thead>
							<tbody>
								{#each data.rejectionCodes as code (code.id)}
									<tr class="border-b border-[var(--color-tron-border)]/50">
										<td class="py-2 pr-3 font-mono text-[var(--color-tron-text)]">{code.code}</td>
										<td class="py-2 pr-3">
											{#if editingCodeId === code.id}
												<form
													method="POST"
													action="?/editRejectionCode"
													use:enhance={() => {
														saving = true;
														return async ({ update }) => {
															await update();
															saving = false;
															editingCodeId = null;
														};
													}}
													class="flex items-center gap-2"
												>
													<input type="hidden" name="id" value={code.id} />
													<input
														type="text"
														name="label"
														value={code.label}
														required
														class="min-h-[36px] flex-1 rounded border border-[var(--color-tron-border)] bg-[var(--color-tron-bg)] px-2 py-1 text-sm text-[var(--color-tron-text)] focus:border-[var(--color-tron-cyan)] focus:outline-none"
													/>
													<input
														type="number"
														name="sortOrder"
														value={code.sortOrder}
														min="0"
														class="min-h-[36px] w-16 rounded border border-[var(--color-tron-border)] bg-[var(--color-tron-bg)] px-2 py-1 text-sm text-[var(--color-tron-text)] focus:border-[var(--color-tron-cyan)] focus:outline-none"
													/>
													<button
														type="submit"
														disabled={saving}
														class="min-h-[36px] rounded border border-green-500/50 bg-green-900/20 px-3 py-1 text-xs font-medium text-green-300 hover:bg-green-900/30 disabled:opacity-50"
													>
														Save
													</button>
													<button
														type="button"
														onclick={() => (editingCodeId = null)}
														class="min-h-[36px] rounded border border-[var(--color-tron-border)] px-3 py-1 text-xs text-[var(--color-tron-text-secondary)] hover:text-[var(--color-tron-text)]"
													>
														Cancel
													</button>
												</form>
											{:else}
												<span class="text-[var(--color-tron-text)]">{code.label}</span>
											{/if}
										</td>
										<td class="py-2 pr-3 text-[var(--color-tron-text-secondary)]">
											{#if editingCodeId !== code.id}
												{code.sortOrder}
											{/if}
										</td>
										{#if data.isAdmin}
											<td class="py-2">
												{#if editingCodeId !== code.id}
													<div class="flex gap-1">
														<button
															type="button"
															onclick={() => (editingCodeId = code.id)}
															class="min-h-[36px] rounded border border-[var(--color-tron-border)] px-3 py-1 text-xs text-[var(--color-tron-text-secondary)] transition-colors hover:text-[var(--color-tron-text)]"
														>
															Edit
														</button>
														<form
															method="POST"
															action="?/removeRejectionCode"
															use:enhance={() => {
																saving = true;
																return async ({ update }) => {
																	await update();
																	saving = false;
																};
															}}
														>
															<input type="hidden" name="id" value={code.id} />
															<button
																type="submit"
																disabled={saving}
																class="min-h-[36px] rounded border border-red-500/30 px-3 py-1 text-xs text-red-400 transition-colors hover:bg-red-900/20 disabled:opacity-50"
															>
																Remove
															</button>
														</form>
													</div>
												{/if}
											</td>
										{/if}
									</tr>
								{/each}
							</tbody>
						</table>
					</div>
				{/if}
			</section>
		</div>
	{/if}
</div>
