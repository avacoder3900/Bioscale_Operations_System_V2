<script lang="ts">
	import { enhance } from '$app/forms';

	interface RecentLot {
		lotId: string;
		quantityProduced: number;
		operatorName: string;
		status: string;
		createdAt: string;
		finishTime: string | null;
	}

	interface Props {
		data: {
			config: {
				configId: string;
				processName: string;
				maxBatchSize: number;
				handoffPrompt: string;
				inputMaterials: { partId: string; name: string; scanOrder: number }[];
			} | null;
			processSteps: any[];
			lotStepEntries: any[];
			recentLots: RecentLot[];
			inventory: {
				cutThermosealStrips: { name: string; quantity: number; unit: string };
				rawCartridges: { name: string; quantity: number; unit: string };
				barcodeLabels: { name: string; quantity: number; unit: string };
				individualBacks: { name: string; quantity: number; unit: string };
			};
			error?: string;
		};
		form: {
			checkAndStart?: { success?: boolean; lotId?: string; plannedQty?: number; error?: string; insufficient?: { name: string; need: number; have: number }[] };
			confirmComplete?: { success?: boolean; handoffPrompt?: string; error?: string };
			resumeLot?: { success?: boolean; lotId?: string; resumeStep?: string; plannedQty?: number; error?: string };
		};
	}

	let { data, form }: Props = $props();

	// Flow: start → scan → qty → working → confirm
	let step = $state<'start' | 'scan' | 'qty' | 'working' | 'confirm'>('start');
	let plannedQty = $state(1);
	let lotBarcode1 = $state('');
	let lotBarcode2 = $state('');
	let lotBarcode3 = $state('');
	let lotId = $state('');
	let actualCount = $state(1);
	let scrapCount = $state(0);
	let scrapReason = $state('');
	let bucketBarcode = $state('');
	let sessionNotes = $state('');
	let handoffOpen = $state(false);
	let handoffPrompt = $state('');

	$effect(() => {
		if (form?.checkAndStart) {
			const r = form.checkAndStart as any;
			if (r.success && r.lotId) {
				lotId = r.lotId;
				plannedQty = r.plannedQty ?? plannedQty;
				actualCount = r.plannedQty ?? plannedQty;
				step = 'working';
			}
		}
		if (form?.confirmComplete) {
			const r = form.confirmComplete as any;
			if (r.success) {
				handoffPrompt = r.handoffPrompt ?? 'Backed cartridges ready for wax filling.';
				handoffOpen = true;
			}
		}
		if (form?.resumeLot) {
			const r = form.resumeLot as any;
			if (r.success) {
				lotId = r.lotId;
				plannedQty = r.plannedQty ?? 1;
				actualCount = r.plannedQty ?? 1;
				step = 'working';
			}
		}
	});

	function resetAll() {
		step = 'start';
		lotId = '';
		plannedQty = 1;
		lotBarcode1 = '';
		lotBarcode2 = '';
		lotBarcode3 = '';
		actualCount = 1;
		scrapCount = 0;
		scrapReason = '';
		bucketBarcode = '';
		sessionNotes = '';
		handoffOpen = false;
		handoffPrompt = '';
	}

	// Compute max possible cartridges from inventory
	const maxFromInventory = $derived(
		Math.min(
			data.inventory.rawCartridges.quantity,
			data.inventory.cutThermosealStrips.quantity,
			data.inventory.barcodeLabels.quantity
		)
	);

	// Track which barcodes are scanned
	const allScanned = $derived(
		lotBarcode1.trim().length > 0 &&
		lotBarcode2.trim().length > 0 &&
		lotBarcode3.trim().length > 0
	);
</script>

{#if data.error || !data.config}
	<p class="text-[var(--color-tron-error)]">{data.error ?? 'Config not found'}</p>
{:else}
	<div class="space-y-6">
		<h1 class="text-2xl font-semibold text-[var(--color-tron-text)]">{data.config.processName}</h1>

		<!-- Inventory Cards -->
		<div class="grid grid-cols-2 gap-3 sm:grid-cols-4">
			<div class="rounded-lg border border-[var(--color-tron-border)] bg-[var(--color-tron-surface)] p-4">
				<p class="text-xs font-medium text-[var(--color-tron-text-secondary)]">{data.inventory.rawCartridges.name}</p>
				<p class="mt-1 text-2xl font-bold text-[var(--color-tron-text)]">
					{data.inventory.rawCartridges.quantity}
					<span class="text-sm font-normal text-[var(--color-tron-text-secondary)]">{data.inventory.rawCartridges.unit}</span>
				</p>
			</div>
			<div class="rounded-lg border border-[var(--color-tron-border)] bg-[var(--color-tron-surface)] p-4">
				<p class="text-xs font-medium text-[var(--color-tron-text-secondary)]">{data.inventory.cutThermosealStrips.name}</p>
				<p class="mt-1 text-2xl font-bold text-[var(--color-tron-text)]">
					{data.inventory.cutThermosealStrips.quantity}
					<span class="text-sm font-normal text-[var(--color-tron-text-secondary)]">{data.inventory.cutThermosealStrips.unit}</span>
				</p>
			</div>
			<div class="rounded-lg border border-[var(--color-tron-border)] bg-[var(--color-tron-surface)] p-4">
				<p class="text-xs font-medium text-[var(--color-tron-text-secondary)]">{data.inventory.barcodeLabels.name}</p>
				<p class="mt-1 text-2xl font-bold text-[var(--color-tron-text)]">
					{data.inventory.barcodeLabels.quantity}
					<span class="text-sm font-normal text-[var(--color-tron-text-secondary)]">{data.inventory.barcodeLabels.unit}</span>
				</p>
			</div>
			<div class="rounded-lg border border-[var(--color-tron-cyan)]/30 bg-[var(--color-tron-cyan)]/5 p-4">
				<p class="text-xs font-medium text-[var(--color-tron-cyan)]/70">Can Make</p>
				<p class="mt-1 text-2xl font-bold text-[var(--color-tron-cyan)]">
					{maxFromInventory}
					<span class="text-sm font-normal text-[var(--color-tron-cyan)]/70">cartridges</span>
				</p>
			</div>
		</div>

		<!-- Main flow area -->
		<div class="rounded-lg border border-[var(--color-tron-border)] bg-[var(--color-tron-bg-secondary)] p-6">

			{#if step === 'start'}
				<!-- STEP 1: Start -->
				{#if maxFromInventory <= 0}
					<div class="rounded border border-[var(--color-tron-error)]/30 bg-[var(--color-tron-error)]/10 p-4">
						<p class="text-sm font-medium text-[var(--color-tron-error)]">Insufficient inventory to start a batch.</p>
						<p class="mt-1 text-xs text-[var(--color-tron-text-secondary)]">Check that all materials are stocked above.</p>
					</div>
				{:else}
					<button
						type="button"
						onclick={() => { step = 'scan'; }}
						class="w-full rounded-lg bg-[var(--color-tron-cyan)] py-4 text-lg font-bold text-[var(--color-tron-bg-primary)] hover:opacity-90 transition-opacity"
					>
						Start New Batch
					</button>
				{/if}

				<!-- In-Progress Lots -->
				{#each data.recentLots.filter((l) => l.status === 'In Progress') as ipLot (ipLot.lotId)}
					<div class="mt-4 rounded-lg border border-[var(--color-tron-yellow)]/50 bg-[var(--color-tron-yellow)]/5 p-3">
						<div class="flex items-center justify-between">
							<div>
								<span class="font-mono text-sm text-[var(--color-tron-yellow)]">{ipLot.lotId}</span>
								<span class="ml-2 text-xs text-[var(--color-tron-text-secondary)]">{ipLot.operatorName}</span>
							</div>
							<form method="POST" action="?/resumeLot" use:enhance>
								<input type="hidden" name="lotId" value={ipLot.lotId} />
								<button type="submit" class="rounded border border-[var(--color-tron-yellow)]/50 bg-[var(--color-tron-yellow)]/20 px-4 py-2 text-sm font-medium text-[var(--color-tron-yellow)] hover:bg-[var(--color-tron-yellow)]/30">
									Resume
								</button>
							</form>
						</div>
					</div>
				{/each}

			{:else if step === 'scan'}
				<!-- STEP 2: Scan all lot barcodes -->
				<div class="space-y-4">
					<p class="text-lg font-semibold text-[var(--color-tron-text)]">Scan Lot Barcodes</p>
					<p class="text-xs text-[var(--color-tron-text-secondary)]">Scan all 3 material lot barcodes before proceeding.</p>

					<div class="space-y-3">
						<div>
							<label class="block text-xs font-medium text-[var(--color-tron-text-secondary)]">Cartridge Lot</label>
							<div class="mt-1 flex items-center gap-2">
								<input type="text" bind:value={lotBarcode1} class="flex-1 rounded border border-[var(--color-tron-border)] bg-[var(--color-tron-bg-primary)] px-3 py-2 text-[var(--color-tron-text)]" placeholder="Scan cartridge lot barcode" />
								{#if lotBarcode1.trim()}
									<span class="text-green-400 text-lg">&#10003;</span>
								{/if}
							</div>
						</div>
						<div>
							<label class="block text-xs font-medium text-[var(--color-tron-text-secondary)]">Thermoseal Laser Cut Sheet Lot</label>
							<div class="mt-1 flex items-center gap-2">
								<input type="text" bind:value={lotBarcode2} class="flex-1 rounded border border-[var(--color-tron-border)] bg-[var(--color-tron-bg-primary)] px-3 py-2 text-[var(--color-tron-text)]" placeholder="Scan thermoseal lot barcode" />
								{#if lotBarcode2.trim()}
									<span class="text-green-400 text-lg">&#10003;</span>
								{/if}
							</div>
						</div>
						<div>
							<label class="block text-xs font-medium text-[var(--color-tron-text-secondary)]">Barcode Label Lot</label>
							<div class="mt-1 flex items-center gap-2">
								<input type="text" bind:value={lotBarcode3} class="flex-1 rounded border border-[var(--color-tron-border)] bg-[var(--color-tron-bg-primary)] px-3 py-2 text-[var(--color-tron-text)]" placeholder="Scan barcode label lot barcode" />
								{#if lotBarcode3.trim()}
									<span class="text-green-400 text-lg">&#10003;</span>
								{/if}
							</div>
						</div>
					</div>

					<div class="flex gap-3 pt-2">
						<button
							type="button"
							disabled={!allScanned}
							onclick={() => { step = 'qty'; }}
							class="rounded-lg bg-[var(--color-tron-cyan)] px-6 py-3 font-bold text-[var(--color-tron-bg-primary)] hover:opacity-90 transition-opacity disabled:opacity-30 disabled:cursor-not-allowed"
						>
							Next — Enter Quantity
						</button>
						<button type="button" onclick={() => { step = 'start'; lotBarcode1 = ''; lotBarcode2 = ''; lotBarcode3 = ''; }} class="rounded-lg border border-[var(--color-tron-border)] px-4 py-3 text-sm text-[var(--color-tron-text-secondary)] hover:border-[var(--color-tron-text-secondary)]">
							Cancel
						</button>
					</div>
				</div>

			{:else if step === 'qty'}
				<!-- STEP 3: Enter quantity + check inventory + start -->
				<form method="POST" action="?/checkAndStart" use:enhance>
					<input type="hidden" name="lot1" value={lotBarcode1} />
					<input type="hidden" name="lot2" value={lotBarcode2} />
					<input type="hidden" name="lot3" value={lotBarcode3} />

					<div class="space-y-4">
						<p class="text-lg font-semibold text-[var(--color-tron-text)]">How many cartridges?</p>

						<!-- Show scanned lots summary -->
						<div class="rounded border border-[var(--color-tron-border)] bg-[var(--color-tron-bg-primary)] p-3 text-xs space-y-1">
							<div class="flex justify-between text-[var(--color-tron-text-secondary)]">
								<span>Cartridge Lot</span>
								<span class="font-mono text-[var(--color-tron-text)]">{lotBarcode1}</span>
							</div>
							<div class="flex justify-between text-[var(--color-tron-text-secondary)]">
								<span>Thermoseal Lot</span>
								<span class="font-mono text-[var(--color-tron-text)]">{lotBarcode2}</span>
							</div>
							<div class="flex justify-between text-[var(--color-tron-text-secondary)]">
								<span>Barcode Lot</span>
								<span class="font-mono text-[var(--color-tron-text)]">{lotBarcode3}</span>
							</div>
						</div>

						<div>
							<input
								type="number"
								name="quantity"
								bind:value={plannedQty}
								min="1"
								max={data.config.maxBatchSize}
								class="w-32 rounded border border-[var(--color-tron-border)] bg-[var(--color-tron-bg-primary)] px-3 py-3 text-2xl font-bold text-[var(--color-tron-text)]"
							/>
							<p class="mt-1 text-xs text-[var(--color-tron-text-secondary)]">Max from inventory: {maxFromInventory} &middot; Max batch: {data.config.maxBatchSize}</p>
						</div>

						{#if form?.checkAndStart && (form.checkAndStart as any).error}
							<div class="rounded border border-[var(--color-tron-error)]/30 bg-[var(--color-tron-error)]/10 p-3">
								<p class="text-sm text-[var(--color-tron-error)]">{(form.checkAndStart as any).error}</p>
								{#if (form.checkAndStart as any).insufficient}
									<ul class="mt-2 space-y-1 text-xs text-[var(--color-tron-text-secondary)]">
										{#each (form.checkAndStart as any).insufficient as item}
											<li>{item.name}: need {item.need}, have {item.have}</li>
										{/each}
									</ul>
								{/if}
							</div>
						{/if}

						<div class="flex gap-3">
							<button type="submit" class="rounded-lg bg-[var(--color-tron-cyan)] px-6 py-3 font-bold text-[var(--color-tron-bg-primary)] hover:opacity-90 transition-opacity">
								Check Inventory & Start
							</button>
							<button type="button" onclick={() => { step = 'scan'; }} class="rounded-lg border border-[var(--color-tron-border)] px-4 py-3 text-sm text-[var(--color-tron-text-secondary)] hover:border-[var(--color-tron-text-secondary)]">
								Back
							</button>
						</div>
					</div>
				</form>

			{:else if step === 'working'}
				<!-- STEP 4: In Progress — making cartridges -->
				<div class="text-center space-y-4">
					<div class="inline-flex h-16 w-16 items-center justify-center rounded-full bg-[var(--color-tron-cyan)]/20 text-3xl">
						&#9881;
					</div>
					<p class="text-lg font-semibold text-[var(--color-tron-text)]">Batch in progress</p>
					<p class="text-3xl font-bold text-[var(--color-tron-cyan)]">{plannedQty} <span class="text-base font-normal text-[var(--color-tron-text-secondary)]">cartridges planned</span></p>
					<p class="text-xs text-[var(--color-tron-text-secondary)]">Lot: {lotId}</p>

					<div class="mt-4 text-left">
						<label class="block text-xs font-medium text-[var(--color-tron-text-secondary)]">Notes</label>
						<textarea
							bind:value={sessionNotes}
							rows="3"
							placeholder="Optional session notes..."
							class="mt-1 w-full rounded border border-[var(--color-tron-border)] bg-[var(--color-tron-bg-primary)] px-3 py-2 text-sm text-[var(--color-tron-text)] placeholder:text-[var(--color-tron-text-secondary)]/50"
						></textarea>
					</div>

					<button
						type="button"
						onclick={() => { step = 'confirm'; actualCount = plannedQty; }}
						class="mt-4 w-full rounded-lg bg-green-600 py-4 text-lg font-bold text-white hover:bg-green-500 transition-colors"
					>
						Done — Count Cartridges
					</button>
				</div>

			{:else if step === 'confirm'}
				<!-- STEP 5: Confirm count & withdraw -->
				<form method="POST" action="?/confirmComplete" use:enhance>
					<input type="hidden" name="lotId" value={lotId} />
					<input type="hidden" name="notes" value={sessionNotes} />
					<div class="space-y-5">
						<!-- Good cartridges -->
						<div>
							<p class="text-lg font-semibold text-[var(--color-tron-text)]">How many GOOD cartridges?</p>
							<input
								type="number"
								name="actualCount"
								bind:value={actualCount}
								min="0"
								max={data.config.maxBatchSize}
								class="mt-2 mx-auto block w-32 rounded border border-[var(--color-tron-border)] bg-[var(--color-tron-bg-primary)] px-3 py-3 text-center text-2xl font-bold text-[var(--color-tron-text)]"
							/>
							<p class="mt-1 text-xs text-[var(--color-tron-text-secondary)] text-center">Planned: {plannedQty} — Adjust if different</p>
						</div>

						<!-- Scrapped cartridges -->
						<div>
							<p class="text-lg font-semibold text-[var(--color-tron-text)]">How many SCRAPPED?</p>
							<input
								type="number"
								name="scrapCount"
								bind:value={scrapCount}
								min="0"
								max={data.config.maxBatchSize}
								class="mt-2 mx-auto block w-32 rounded border border-[var(--color-tron-border)] bg-[var(--color-tron-bg-primary)] px-3 py-3 text-center text-2xl font-bold text-[var(--color-tron-text)]"
							/>
							{#if scrapCount > 0}
								<div class="mt-2">
									<label class="block text-xs font-medium text-[var(--color-tron-text-secondary)]">Scrap Reason (required)</label>
									<input
										type="text"
										name="scrapReason"
										bind:value={scrapReason}
										required
										placeholder="Why were these scrapped?"
										class="mt-1 w-full rounded border border-[var(--color-tron-border)] bg-[var(--color-tron-bg-primary)] px-3 py-2 text-sm text-[var(--color-tron-text)] placeholder:text-[var(--color-tron-text-secondary)]/50"
									/>
								</div>
							{/if}
						</div>

						<!-- Total consumed -->
						<div class="rounded border border-[var(--color-tron-border)] bg-[var(--color-tron-bg-primary)] p-3 text-center">
							<p class="text-xs text-[var(--color-tron-text-secondary)]">Total consumed</p>
							<p class="text-2xl font-bold text-[var(--color-tron-text)]">{actualCount + scrapCount}</p>
						</div>

						<!-- Bucket assignment -->
						<div>
							<p class="text-lg font-semibold text-[var(--color-tron-text)]">Bucket Assignment</p>
							<input
								type="text"
								name="bucketBarcode"
								bind:value={bucketBarcode}
								placeholder="Scan bucket barcode"
								class="mt-2 w-full rounded border border-[var(--color-tron-border)] bg-[var(--color-tron-bg-primary)] px-3 py-2 text-[var(--color-tron-text)] placeholder:text-[var(--color-tron-text-secondary)]/50"
							/>
						</div>

						{#if form?.confirmComplete && (form.confirmComplete as any).error}
							<p class="text-sm text-[var(--color-tron-error)] text-center">{(form.confirmComplete as any).error}</p>
						{/if}

						<div class="flex justify-center gap-3 pt-2">
							<button type="submit" class="rounded-lg bg-green-600 px-6 py-3 font-bold text-white hover:bg-green-500 transition-colors">
								Yes — Confirm & Withdraw
							</button>
							<button type="button" onclick={() => { step = 'working'; }} class="rounded-lg border border-[var(--color-tron-border)] px-4 py-3 text-sm text-[var(--color-tron-text-secondary)]">
								Go Back
							</button>
						</div>
					</div>
				</form>
			{/if}
		</div>

		<!-- Recent Batches (visible on start screen) -->
		{#if data.recentLots.length > 0 && step === 'start'}
			<div class="border-t border-[var(--color-tron-border)] pt-4">
				<h2 class="text-sm font-medium text-[var(--color-tron-text-secondary)]">Recent Batches</h2>
				<div class="mt-2 overflow-x-auto">
					<table class="w-full text-left text-sm">
						<thead>
							<tr class="border-b border-[var(--color-tron-border)] text-[var(--color-tron-text-secondary)]">
								<th class="px-3 py-2">Lot ID</th>
								<th class="px-3 py-2">Qty</th>
								<th class="px-3 py-2">Operator</th>
								<th class="px-3 py-2">Status</th>
								<th class="px-3 py-2">Time</th>
							</tr>
						</thead>
						<tbody>
							{#each data.recentLots as lot (lot.lotId)}
								<tr class="border-b border-[var(--color-tron-border)]">
									<td class="px-3 py-2 font-mono text-xs text-[var(--color-tron-cyan)]">{lot.lotId}</td>
									<td class="px-3 py-2 text-[var(--color-tron-text)]">{lot.quantityProduced}</td>
									<td class="px-3 py-2 text-[var(--color-tron-text)]">{lot.operatorName}</td>
									<td class="px-3 py-2 text-[var(--color-tron-text)]">{lot.status}</td>
									<td class="px-3 py-2 text-[var(--color-tron-text-secondary)]">
										{lot.finishTime
											? new Date(lot.finishTime).toLocaleString()
											: new Date(lot.createdAt).toLocaleString()}
									</td>
								</tr>
							{/each}
						</tbody>
					</table>
				</div>
			</div>
		{/if}
	</div>

	<!-- Handoff Modal -->
	{#if handoffOpen}
		<div class="fixed inset-0 z-50 flex items-center justify-center bg-black/50" role="dialog" aria-modal="true">
			<div class="rounded-lg border border-green-500/30 bg-[var(--color-tron-bg-secondary)] p-6 shadow-lg max-w-sm text-center">
				<div class="text-4xl mb-3">&#10003;</div>
				<h3 class="text-lg font-semibold text-green-400">Batch Complete</h3>
				<p class="mt-2 text-[var(--color-tron-text)]">{handoffPrompt}</p>
				<p class="mt-1 text-sm text-[var(--color-tron-text-secondary)]">Inventory has been withdrawn.</p>
				<button
					type="button"
					onclick={resetAll}
					class="mt-4 rounded bg-[var(--color-tron-cyan)] px-6 py-2 font-semibold text-[var(--color-tron-bg-primary)]"
				>
					Done
				</button>
			</div>
		</div>
	{/if}
{/if}
