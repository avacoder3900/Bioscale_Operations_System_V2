<script lang="ts">
	import { enhance } from '$app/forms';
	import { invalidateAll } from '$app/navigation';

	interface OvenLot {
		lotId: string;
		configId: string;
		ovenEntryTime: string;
		readyAt: string;
		minutesRemaining: number;
		ready: boolean;
	}

	interface Props {
		data: {
			lots: OvenLot[];
			minOvenTimeMin: number;
			isAdmin: boolean;
		};
		form: { success?: boolean; error?: string } | null;
	}

	let { data, form }: Props = $props();

	let overrideLotId = $state<string | null>(null);
	let overrideReason = $state('');

	// Tick counter incremented every second to drive $derived recomputation
	let tick = $state(0);

	$effect(() => {
		const timer = setInterval(() => { tick++; }, 1_000);
		return () => clearInterval(timer);
	});

	// Auto-refresh from server every 30s
	$effect(() => {
		const interval = setInterval(() => { invalidateAll(); }, 30_000);
		return () => clearInterval(interval);
	});

	// Close override modal on success
	$effect(() => {
		if (form?.success) {
			overrideLotId = null;
			overrideReason = '';
		}
	});

	// Derive computed lots from server data + tick (forces recompute each second)
	let computedLots = $derived.by(() => {
		void tick; // subscribe to tick
		const now = Date.now();
		return data.lots.map((lot) => {
			const readyAt = new Date(lot.readyAt).getTime();
			const ready = now >= readyAt;
			return {
				...lot,
				ready,
				minutesRemaining: ready ? 0 : Math.ceil((readyAt - now) / 60_000)
			};
		});
	});

	let readyLots = $derived(computedLots.filter((l) => l.ready));
	let heatingLots = $derived(computedLots.filter((l) => !l.ready));

	function formatTime(iso: string): string {
		return new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
	}

	function formatDate(iso: string): string {
		return new Date(iso).toLocaleDateString([], { month: 'short', day: 'numeric' });
	}
</script>

<div class="space-y-6">
	<div class="flex items-center justify-between">
		<h1 class="text-2xl font-semibold text-[var(--color-tron-text)]">Oven Queue</h1>
		<span class="text-sm text-[var(--color-tron-text-secondary)]">
			Min oven time: {data.minOvenTimeMin} min
		</span>
	</div>

	{#if form?.error}
		<div class="rounded border border-red-500/30 bg-red-900/20 px-4 py-3 text-sm text-red-300">
			{form.error}
		</div>
	{/if}

	<!-- Ready Lots -->
	<section>
		<h2 class="mb-3 text-lg font-medium text-green-400">
			Ready ({readyLots.length})
		</h2>
		{#if readyLots.length === 0}
			<p class="text-sm text-[var(--color-tron-text-secondary)]">No lots ready for wax filling.</p>
		{:else}
			<div class="overflow-x-auto">
				<table class="tron-table w-full">
					<thead>
						<tr>
							<th class="px-4 py-3 text-left text-sm font-medium text-[var(--color-tron-text-secondary)]">Lot ID</th>
							<th class="px-4 py-3 text-left text-sm font-medium text-[var(--color-tron-text-secondary)]">Oven Entry</th>
							<th class="px-4 py-3 text-left text-sm font-medium text-[var(--color-tron-text-secondary)]">Ready Since</th>
							<th class="px-4 py-3 text-left text-sm font-medium text-[var(--color-tron-text-secondary)]">Status</th>
						</tr>
					</thead>
					<tbody>
						{#each readyLots as lot (lot.lotId)}
							<tr class="border-t border-[var(--color-tron-border)]">
								<td class="px-4 py-3 font-mono text-sm text-[var(--color-tron-text)]">{lot.lotId}</td>
								<td class="px-4 py-3 text-sm text-[var(--color-tron-text-secondary)]">
									{formatDate(lot.ovenEntryTime)} {formatTime(lot.ovenEntryTime)}
								</td>
								<td class="px-4 py-3 text-sm text-[var(--color-tron-text-secondary)]">
									{formatDate(lot.readyAt)} {formatTime(lot.readyAt)}
								</td>
								<td class="px-4 py-3">
									<span class="inline-flex items-center gap-1.5 rounded border border-green-500/30 bg-green-900/50 px-2 py-1 text-xs font-medium text-green-300">
										<svg class="h-3.5 w-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2.5">
											<path stroke-linecap="round" stroke-linejoin="round" d="M5 13l4 4L19 7" />
										</svg>
										Ready
									</span>
								</td>
							</tr>
						{/each}
					</tbody>
				</table>
			</div>
		{/if}
	</section>

	<!-- Heating Lots -->
	<section>
		<h2 class="mb-3 text-lg font-medium text-amber-400">
			Heating ({heatingLots.length})
		</h2>
		{#if heatingLots.length === 0}
			<p class="text-sm text-[var(--color-tron-text-secondary)]">No lots currently heating.</p>
		{:else}
			<div class="overflow-x-auto">
				<table class="tron-table w-full">
					<thead>
						<tr>
							<th class="px-4 py-3 text-left text-sm font-medium text-[var(--color-tron-text-secondary)]">Lot ID</th>
							<th class="px-4 py-3 text-left text-sm font-medium text-[var(--color-tron-text-secondary)]">Oven Entry</th>
							<th class="px-4 py-3 text-left text-sm font-medium text-[var(--color-tron-text-secondary)]">Ready At</th>
							<th class="px-4 py-3 text-left text-sm font-medium text-[var(--color-tron-text-secondary)]">Remaining</th>
							{#if data.isAdmin}
								<th class="px-4 py-3 text-left text-sm font-medium text-[var(--color-tron-text-secondary)]">Actions</th>
							{/if}
						</tr>
					</thead>
					<tbody>
						{#each heatingLots as lot (lot.lotId)}
							<tr class="border-t border-[var(--color-tron-border)]">
								<td class="px-4 py-3 font-mono text-sm text-[var(--color-tron-text)]">{lot.lotId}</td>
								<td class="px-4 py-3 text-sm text-[var(--color-tron-text-secondary)]">
									{formatDate(lot.ovenEntryTime)} {formatTime(lot.ovenEntryTime)}
								</td>
								<td class="px-4 py-3 text-sm text-[var(--color-tron-text-secondary)]">
									{formatDate(lot.readyAt)} {formatTime(lot.readyAt)}
								</td>
								<td class="px-4 py-3">
									<span class="inline-flex items-center gap-1.5 rounded border border-amber-500/30 bg-amber-900/50 px-2 py-1 text-xs font-medium text-amber-300">
										<svg class="h-3.5 w-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2.5">
											<path stroke-linecap="round" stroke-linejoin="round" d="M12 6v6l4 2" />
										</svg>
										{lot.minutesRemaining} min
									</span>
								</td>
								{#if data.isAdmin}
									<td class="px-4 py-3">
										<button
											type="button"
											onclick={() => { overrideLotId = lot.lotId; overrideReason = ''; }}
											class="min-h-[44px] rounded border border-red-500/30 bg-red-900/30 px-3 py-2 text-xs font-medium text-red-300 transition-colors hover:bg-red-900/50"
										>
											Override
										</button>
									</td>
								{/if}
							</tr>
						{/each}
					</tbody>
				</table>
			</div>
		{/if}
	</section>

	<!-- Empty state -->
	{#if computedLots.length === 0}
		<div class="rounded border border-[var(--color-tron-border)] bg-[var(--color-tron-surface)] px-6 py-12 text-center">
			<p class="text-[var(--color-tron-text-secondary)]">No lots in oven queue. Complete WI-01 batches with oven handoff to populate this queue.</p>
		</div>
	{/if}
</div>

<!-- Admin Override Modal -->
{#if overrideLotId}
	<div class="fixed inset-0 z-50 flex items-center justify-center bg-black/60">
		<div class="w-full max-w-md rounded-lg border border-[var(--color-tron-border)] bg-[var(--color-tron-bg)] p-6 shadow-xl">
			<h3 class="mb-4 text-lg font-semibold text-red-400">Admin Override</h3>
			<p class="mb-4 text-sm text-[var(--color-tron-text-secondary)]">
				Override minimum oven time for lot <span class="font-mono text-[var(--color-tron-text)]">{overrideLotId}</span>.
				This action is logged in the audit trail.
			</p>
			<form
				method="POST"
				action="?/adminOverride"
				use:enhance={() => {
					return async ({ update }) => {
						await update();
					};
				}}
			>
				<input type="hidden" name="lotId" value={overrideLotId} />
				<label class="mb-4 block">
					<span class="mb-1 block text-sm font-medium text-[var(--color-tron-text-secondary)]">Reason (required)</span>
					<textarea
						name="reason"
						bind:value={overrideReason}
						rows="3"
						required
						class="w-full rounded border border-[var(--color-tron-border)] bg-[var(--color-tron-surface)] px-3 py-2 text-sm text-[var(--color-tron-text)] placeholder-[var(--color-tron-text-secondary)] focus:border-[var(--color-tron-cyan)] focus:outline-none"
						placeholder="Justification for bypassing oven time..."
					></textarea>
				</label>
				<div class="flex items-center justify-end gap-3">
					<button
						type="button"
						onclick={() => { overrideLotId = null; }}
						class="min-h-[44px] rounded border border-[var(--color-tron-border)] px-4 py-2 text-sm text-[var(--color-tron-text-secondary)] transition-colors hover:text-[var(--color-tron-text)]"
					>
						Cancel
					</button>
					<button
						type="submit"
						disabled={!overrideReason.trim()}
						class="min-h-[44px] rounded border border-red-500/50 bg-red-900/30 px-4 py-2 text-sm font-medium text-red-300 transition-colors hover:bg-red-900/50 disabled:cursor-not-allowed disabled:opacity-50"
					>
						Confirm Override
					</button>
				</div>
			</form>
		</div>
	</div>
{/if}
