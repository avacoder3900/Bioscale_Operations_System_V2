<script lang="ts">
	import { enhance } from '$app/forms';
	import { invalidateAll } from '$app/navigation';

	interface OvenEntry {
		id: string;
		displayName: string;
		barcode: string;
	}

	interface BakingLot {
		lotId: string;
		ovenEntryTime: string | null;
		ovenLocationId: string | null;
		ovenLocationName: string | null;
		cartridgeCount: number;
		status: string;
		operatorUsername: string | null;
		elapsedMin: number;
		remainingMin: number;
		isReady: boolean;
	}

	interface Props {
		data: {
			recentLots: {
				lotId: string;
				qrCodeRef: string;
				configId: string;
				quantityProduced: number;
				startTime: string | null;
				finishTime: string | null;
				cycleTime: number | null;
				status: string;
				username: string | null;
			}[];
			stats: Record<string, { lotsToday: number; unitsToday: number }>;
			bakingLots: BakingLot[];
			ovens: OvenEntry[];
			minOvenTimeMin: number;
		};
	}

	let { data }: Props = $props();

	// Register backing lot form state
	let registerError = $state('');
	let registerSuccess = $state('');
	let lotBarcode = $state('');
	let selectedOven = $state('');
	let cartridgeCount = $state('');
	let submitting = $state(false);

	// Countdown interval
	let now = $state(Date.now());
	$effect(() => {
		const interval = setInterval(() => { now = Date.now(); }, 30000);
		return () => clearInterval(interval);
	});

	function getLiveRemainingMin(ovenEntryTime: string | null, remainingMin: number): number {
		if (!ovenEntryTime) return remainingMin;
		const entry = new Date(ovenEntryTime).getTime();
		const elapsed = (now - entry) / 60000;
		return Math.max(0, data.minOvenTimeMin - elapsed);
	}

	function getLiveElapsedMin(ovenEntryTime: string | null): number {
		if (!ovenEntryTime) return 0;
		const entry = new Date(ovenEntryTime).getTime();
		return (now - entry) / 60000;
	}

	function isLiveReady(ovenEntryTime: string | null): boolean {
		return getLiveElapsedMin(ovenEntryTime) >= data.minOvenTimeMin;
	}

	function formatElapsed(min: number): string {
		const h = Math.floor(min / 60);
		const m = Math.floor(min % 60);
		return h > 0 ? `${h}h ${m}m` : `${m}m`;
	}
</script>

<div class="space-y-6">
	<h1 class="text-2xl font-semibold text-[var(--color-tron-text)]">Manufacturing Dashboard</h1>

	{#if Object.keys(data.stats).length > 0}
		<div class="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
			{#each Object.entries(data.stats) as [configId, s]}
				<div
					class="rounded-lg border border-[var(--color-tron-border)] bg-[var(--color-tron-bg-secondary)] p-4"
				>
					<div class="text-sm text-[var(--color-tron-text-secondary)]">{configId}</div>
					<div class="mt-1 text-xl font-semibold text-[var(--color-tron-text)]">
						{s.unitsToday} units today
					</div>
					<div class="text-sm text-[var(--color-tron-text-secondary)]">{s.lotsToday} lots</div>
				</div>
			{/each}
		</div>
	{/if}

	<!-- Oven Status: Active Backing Lots -->
	<section class="rounded-lg border border-[var(--color-tron-border)] bg-[var(--color-tron-bg-secondary)]">
		<h2 class="border-b border-[var(--color-tron-border)] px-4 py-3 text-lg font-medium text-[var(--color-tron-text)]">
			🔥 Oven Status — Backing Lots
		</h2>

		{#if data.bakingLots.length === 0}
			<p class="px-4 py-6 text-center text-sm text-[var(--color-tron-text-secondary)]">
				No backing lots currently in oven. Register a lot below.
			</p>
		{:else}
			<div class="divide-y divide-[var(--color-tron-border)]">
				{#each data.bakingLots as lot (lot.lotId)}
					{@const liveReady = isLiveReady(lot.ovenEntryTime)}
					{@const liveRemaining = getLiveRemainingMin(lot.ovenEntryTime, lot.remainingMin)}
					{@const liveElapsed = getLiveElapsedMin(lot.ovenEntryTime)}
					<div class="flex items-center justify-between gap-4 px-4 py-3">
						<div class="min-w-0 flex-1">
							<div class="flex items-center gap-2">
								<span
									class="inline-block h-2.5 w-2.5 shrink-0 rounded-full {liveReady ? 'bg-green-500' : 'bg-amber-400'}"
									aria-hidden="true"
								></span>
								<span class="font-mono text-sm font-semibold text-[var(--color-tron-text)] truncate">{lot.lotId}</span>
								{#if lot.status === 'ready' || liveReady}
									<span class="rounded border border-green-500/50 bg-green-900/30 px-1.5 py-0.5 text-[10px] font-bold text-green-400 shrink-0">READY</span>
								{/if}
							</div>
							<div class="mt-1 flex flex-wrap items-center gap-x-3 gap-y-0.5 text-xs text-[var(--color-tron-text-secondary)]">
								<span>{lot.cartridgeCount} cartridges</span>
								{#if lot.ovenLocationName}
									<span>· {lot.ovenLocationName}</span>
								{/if}
								{#if lot.operatorUsername}
									<span>· by {lot.operatorUsername}</span>
								{/if}
							</div>
						</div>
						<div class="shrink-0 text-right">
							{#if liveReady}
								<p class="text-sm font-semibold text-green-400">
									{formatElapsed(liveElapsed)} in oven
								</p>
								<p class="text-[10px] text-green-500/70">≥ {data.minOvenTimeMin} min ✓</p>
							{:else}
								<p class="text-sm font-semibold text-amber-300">
									{Math.ceil(liveRemaining)} min left
								</p>
								<p class="text-[10px] text-[var(--color-tron-text-secondary)]">
									{formatElapsed(liveElapsed)} elapsed
								</p>
							{/if}
						</div>
					</div>
				{/each}
			</div>
		{/if}

		<!-- Register Backing Lot Form -->
		<div class="border-t border-[var(--color-tron-border)] px-4 py-4">
			<h3 class="mb-3 text-sm font-semibold text-[var(--color-tron-text)]">Register Backing Lot</h3>

			{#if registerError}
				<div class="mb-3 rounded border border-red-500/30 bg-red-900/20 px-3 py-2 text-xs text-red-300">
					{registerError}
				</div>
			{/if}
			{#if registerSuccess}
				<div class="mb-3 rounded border border-green-500/30 bg-green-900/20 px-3 py-2 text-xs text-green-300">
					{registerSuccess}
				</div>
			{/if}

			<form
				method="POST"
				action="?/registerBackingLot"
				use:enhance={() => {
					submitting = true;
					registerError = '';
					registerSuccess = '';
					return async ({ result }) => {
						if (result.type === 'failure') {
							registerError = (result.data as any)?.error ?? 'Failed to register lot';
						} else if (result.type === 'success') {
							registerSuccess = `Lot "${(result.data as any)?.lotBarcode}" registered — oven timer started!`;
							lotBarcode = '';
							selectedOven = '';
							cartridgeCount = '';
							await invalidateAll();
						}
						submitting = false;
					};
				}}
				class="grid gap-3 sm:grid-cols-3"
			>
				<div>
					<label for="lot-barcode" class="tron-label">Lot Barcode (scan)</label>
					<input
						id="lot-barcode"
						type="text"
						name="lotBarcode"
						bind:value={lotBarcode}
						class="tron-input"
						placeholder="Scan or type lot barcode"
						autocomplete="off"
						required
					/>
				</div>

				<div>
					<label for="oven-select" class="tron-label">Oven Location</label>
					{#if data.ovens.length > 0}
						<select
							id="oven-select"
							name="ovenLocationId"
							bind:value={selectedOven}
							class="tron-input"
						>
							<option value="">— Select oven —</option>
							{#each data.ovens as oven}
								<option value={oven.id}>{oven.displayName}</option>
							{/each}
						</select>
					{:else}
						<input
							id="oven-select"
							type="text"
							name="ovenLocationId"
							class="tron-input"
							placeholder="No ovens configured"
							disabled
						/>
					{/if}
				</div>

				<div>
					<label for="cartridge-count" class="tron-label">Cartridge Count</label>
					<input
						id="cartridge-count"
						type="number"
						name="cartridgeCount"
						bind:value={cartridgeCount}
						min="1"
						max="9999"
						class="tron-input"
						placeholder="e.g. 100"
						required
					/>
				</div>

				<div class="sm:col-span-3">
					<button
						type="submit"
						disabled={submitting || !lotBarcode.trim() || !cartridgeCount}
						class="min-h-[44px] rounded-lg bg-[var(--color-tron-cyan)] px-6 py-2.5 text-sm font-semibold text-white transition-colors hover:bg-[var(--color-tron-cyan)]/80 disabled:opacity-50"
					>
						{submitting ? 'Registering...' : 'Place in Oven — Start Timer'}
					</button>
				</div>
			</form>
		</div>
	</section>

	<section class="rounded-lg border border-[var(--color-tron-border)] bg-[var(--color-tron-bg-secondary)]">
		<h2 class="border-b border-[var(--color-tron-border)] px-4 py-3 text-lg font-medium text-[var(--color-tron-text)]">
			Lot History
		</h2>
		<div class="overflow-x-auto">
			<table class="w-full text-left text-sm">
				<thead>
					<tr class="border-b border-[var(--color-tron-border)] text-[var(--color-tron-text-secondary)]">
						<th class="px-4 py-3">Lot ID</th>
						<th class="px-4 py-3">Config</th>
						<th class="px-4 py-3">Operator</th>
						<th class="px-4 py-3">Qty</th>
						<th class="px-4 py-3">Cycle (s)</th>
						<th class="px-4 py-3">Status</th>
						<th class="px-4 py-3">Finish</th>
					</tr>
				</thead>
				<tbody>
					{#if data.recentLots.length === 0}
						<tr>
							<td colspan="7" class="px-4 py-8 text-center text-[var(--color-tron-text-secondary)]">
								No lots yet. Start a batch from WI-01 or WI-02.
							</td>
						</tr>
					{:else}
						{#each data.recentLots as lot}
							<tr class="border-b border-[var(--color-tron-border)]">
								<td class="px-4 py-3">
									<a
										href="/manufacturing/lots/{lot.lotId}"
										class="text-[var(--color-tron-cyan)] hover:underline"
									>
										{lot.lotId}
									</a>
								</td>
								<td class="px-4 py-3 text-[var(--color-tron-text)]">{lot.configId}</td>
								<td class="px-4 py-3 text-[var(--color-tron-text)]">{lot.username ?? '—'}</td>
								<td class="px-4 py-3 text-[var(--color-tron-text)]">{lot.quantityProduced}</td>
								<td class="px-4 py-3 text-[var(--color-tron-text)]">{lot.cycleTime ?? '—'}</td>
								<td class="px-4 py-3 text-[var(--color-tron-text)]">{lot.status}</td>
								<td class="px-4 py-3 text-[var(--color-tron-text-secondary)]">{lot.finishTime ? new Date(lot.finishTime).toLocaleString() : '—'}</td>
							</tr>
						{/each}
					{/if}
				</tbody>
			</table>
		</div>
	</section>
</div>
