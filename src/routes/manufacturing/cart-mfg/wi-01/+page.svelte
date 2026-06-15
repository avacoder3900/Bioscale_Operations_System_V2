<script lang="ts">
	import { enhance } from '$app/forms';

	interface RecentLot {
		lotId: string;
		quantityProduced: number;
		operatorName: string;
		status: string;
		createdAt: string;
		finishTime: string | null;
		bucketBarcode?: string | null;
		outputLotNumber?: string | null;
	}

	interface LotOption { lotId: string; quantity: number; remaining: number }

	interface Props {
		data: {
			config: {
				configId: string;
				processName: string;
				maxBatchSize: number;
				handoffPrompt: string;
				inputMaterials: { partId: string; name: string; scanOrder: number }[];
			} | null;
			availableLots?: Record<string, LotOption[]>;
			recentLots: RecentLot[];
			ovens?: { _id: string; name: string; barcode: string; status: string }[];
			inventory: {
				cutThermosealStrips: { name: string; quantity: number; unit: string };
				rawCartridges: { name: string; quantity: number; unit: string };
				barcodeLabels: { name: string; quantity: number; unit: string };
				individualBacks: { name: string; quantity: number; unit: string };
			};
			error?: string;
		};
		form: {
			checkAndStart?: { success?: boolean; lotId?: string; error?: string };
			confirmComplete?: { success?: boolean; handoffPrompt?: string; error?: string };
			resumeLot?: { success?: boolean; lotId?: string; error?: string; cartridgeIds?: string[] };
		};
	}

	let { data, form }: Props = $props();

	// Flow: config (pick lots + oven) → session (rapid scan) → confirm (scrap + withdraw)
	let step = $state<'config' | 'session' | 'confirm'>('config');

	// Batch setup (dropdown selections = ReceivingLot lotIds)
	let lot1 = $state(''); // PT-CT-104 cartridge blank
	let lot2 = $state(''); // PT-CT-112 thermoseal sheet
	let lot3 = $state(''); // PT-CT-106 barcode label
	let ovenId = $state('');
	let starting = $state(false);
	let startError = $state('');

	// Session state
	let lotId = $state(''); // created LotRecord._id
	let scannedCarts = $state<string[]>([]);
	let cartScanInput = $state('');
	let cartScanError = $state('');
	let cartScanBusy = $state(false);

	// Confirm state
	let scrapCartridge = $state(0);
	let scrapThermoseal = $state(0);
	let scrapBarcode = $state(0);
	let scrapReason = $state('');
	let sessionNotes = $state('');
	let handoffOpen = $state(false);
	let handoffPrompt = $state('');

	const lots1 = $derived(data.availableLots?.['PT-CT-104'] ?? []);
	const lots2 = $derived(data.availableLots?.['PT-CT-112'] ?? []);
	const lots3 = $derived(data.availableLots?.['PT-CT-106'] ?? []);
	const configReady = $derived(!!lot1 && !!lot2 && !!lot3 && !!ovenId);
	const ovenName = $derived((data.ovens ?? []).find((o) => o._id === ovenId)?.name ?? ovenId);

	const totalScrap = $derived(scrapCartridge + scrapThermoseal + scrapBarcode);
	const hasScrap = $derived(totalScrap > 0);

	const maxFromInventory = $derived(
		Math.min(
			data.inventory.rawCartridges.quantity,
			data.inventory.cutThermosealStrips.quantity,
			data.inventory.barcodeLabels.quantity
		)
	);
	const LOW_INVENTORY_THRESHOLD = 100;
	const lowInventoryItems = $derived(
		[data.inventory.rawCartridges, data.inventory.cutThermosealStrips, data.inventory.barcodeLabels]
			.filter((i) => i.quantity < LOW_INVENTORY_THRESHOLD)
	);

	async function handleCartScan() {
		const barcode = cartScanInput.trim();
		if (!barcode || cartScanBusy) return;
		if (!ovenId) { cartScanError = 'Select an oven first'; return; }
		if (scannedCarts.includes(barcode)) {
			cartScanError = `${barcode} already scanned in this batch`;
			cartScanInput = '';
			return;
		}
		cartScanBusy = true;
		cartScanError = '';
		try {
			const fd = new FormData();
			fd.set('lotId', lotId);
			fd.set('barcode', barcode);
			fd.set('ovenId', ovenId);
			const res = await fetch('?/scanBackedCartridge', {
				method: 'POST',
				body: fd,
				headers: { 'x-sveltekit-action': 'true' }
			});
			const json = await res.json();
			const payload = json?.data ?? json;
			const inner = payload?.scanBackedCartridge ?? payload;
			if (!res.ok || inner?.error) {
				cartScanError = inner?.error ?? `Error ${res.status}`;
			} else {
				scannedCarts = [barcode, ...scannedCarts];
			}
		} catch (e) {
			cartScanError = e instanceof Error ? e.message : 'Scan failed';
		} finally {
			cartScanBusy = false;
			cartScanInput = '';
			document.getElementById('cartScanInput')?.focus();
		}
	}

	async function removeCartScan(barcode: string) {
		cartScanError = '';
		try {
			const fd = new FormData();
			fd.set('lotId', lotId);
			fd.set('barcode', barcode);
			const res = await fetch('?/removeBackedCartridge', {
				method: 'POST',
				body: fd,
				headers: { 'x-sveltekit-action': 'true' }
			});
			const json = await res.json();
			const payload = json?.data ?? json;
			const inner = payload?.removeBackedCartridge ?? payload;
			if (!res.ok || inner?.error) {
				cartScanError = inner?.error ?? `Error ${res.status}`;
			} else {
				scannedCarts = scannedCarts.filter((b) => b !== barcode);
			}
		} catch (e) {
			cartScanError = e instanceof Error ? e.message : 'Remove failed';
		}
	}

	function focusScan() {
		setTimeout(() => document.getElementById('cartScanInput')?.focus(), 60);
	}

	$effect(() => {
		if (form?.checkAndStart) {
			const r = form.checkAndStart as any;
			if (r.success && r.lotId) { lotId = r.lotId; step = 'session'; focusScan(); }
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
				scannedCarts = [...(r.cartridgeIds ?? [])].reverse();
				step = 'session';
				focusScan();
			}
		}
	});

	function resetAll() {
		step = 'config';
		lot1 = ''; lot2 = ''; lot3 = ''; ovenId = '';
		startError = '';
		lotId = '';
		scannedCarts = [];
		cartScanInput = '';
		cartScanError = '';
		scrapCartridge = 0; scrapThermoseal = 0; scrapBarcode = 0;
		scrapReason = '';
		sessionNotes = '';
		handoffOpen = false;
		handoffPrompt = '';
	}
</script>

{#if data.error || !data.config}
	<p class="text-[var(--color-tron-error)]">{data.error ?? 'Config not found'}</p>
{:else}
	<div class="space-y-6">
		<h1 class="text-2xl font-semibold text-[var(--color-tron-text)]">{data.config.processName}</h1>

		{#if lowInventoryItems.length > 0}
			<div class="rounded-lg border border-[var(--color-tron-yellow)]/50 bg-[var(--color-tron-yellow)]/10 p-3">
				<p class="text-sm font-medium text-[var(--color-tron-yellow)]">⚠ Low inventory (below {LOW_INVENTORY_THRESHOLD}):</p>
				<p class="mt-1 text-xs text-[var(--color-tron-text-secondary)]">
					{lowInventoryItems.map((i) => `${i.name} (${i.quantity} ${i.unit})`).join(' · ')}
				</p>
			</div>
		{/if}

		<!-- Inventory Cards -->
		<div class="grid grid-cols-2 gap-3 sm:grid-cols-4">
			<div class="rounded-lg border border-[var(--color-tron-border)] bg-[var(--color-tron-surface)] p-4">
				<p class="text-xs font-medium text-[var(--color-tron-text-secondary)]">{data.inventory.rawCartridges.name}</p>
				<p class="mt-1 text-2xl font-bold text-[var(--color-tron-text)]">{data.inventory.rawCartridges.quantity}<span class="text-sm font-normal text-[var(--color-tron-text-secondary)]"> {data.inventory.rawCartridges.unit}</span></p>
			</div>
			<div class="rounded-lg border border-[var(--color-tron-border)] bg-[var(--color-tron-surface)] p-4">
				<p class="text-xs font-medium text-[var(--color-tron-text-secondary)]">{data.inventory.cutThermosealStrips.name}</p>
				<p class="mt-1 text-2xl font-bold text-[var(--color-tron-text)]">{data.inventory.cutThermosealStrips.quantity}<span class="text-sm font-normal text-[var(--color-tron-text-secondary)]"> {data.inventory.cutThermosealStrips.unit}</span></p>
			</div>
			<div class="rounded-lg border border-[var(--color-tron-border)] bg-[var(--color-tron-surface)] p-4">
				<p class="text-xs font-medium text-[var(--color-tron-text-secondary)]">{data.inventory.barcodeLabels.name}</p>
				<p class="mt-1 text-2xl font-bold text-[var(--color-tron-text)]">{data.inventory.barcodeLabels.quantity}<span class="text-sm font-normal text-[var(--color-tron-text-secondary)]"> {data.inventory.barcodeLabels.unit}</span></p>
			</div>
			<div class="rounded-lg border border-[var(--color-tron-cyan)]/30 bg-[var(--color-tron-cyan)]/5 p-4">
				<p class="text-xs font-medium text-[var(--color-tron-cyan)]/70">Can Make</p>
				<p class="mt-1 text-2xl font-bold text-[var(--color-tron-cyan)]">{maxFromInventory}<span class="text-sm font-normal text-[var(--color-tron-cyan)]/70"> cartridges</span></p>
			</div>
		</div>

		<!-- Main flow area -->
		<div class="rounded-lg border border-[var(--color-tron-border)] bg-[var(--color-tron-bg-secondary)] p-6">

			{#if step === 'config'}
				<!-- SET UP BATCH: choose material lots + oven, then start a scan session -->
				<form method="POST" action="?/checkAndStart" use:enhance>
					<input type="hidden" name="lot1" value={lot1} />
					<input type="hidden" name="lot2" value={lot2} />
					<input type="hidden" name="lot3" value={lot3} />

					<div class="space-y-4">
						<div>
							<p class="text-lg font-semibold text-[var(--color-tron-text)]">Set up batch</p>
							<p class="text-xs text-[var(--color-tron-text-secondary)]">Pick the material lots + oven once, then rapid-fire scan cartridges.</p>
						</div>

						<div class="space-y-3">
							<div>
								<label for="lot1" class="block text-xs font-medium text-[var(--color-tron-text-secondary)]">Cartridge blank lot (PT-CT-104)</label>
								<select id="lot1" bind:value={lot1} class="mt-1 w-full rounded border border-[var(--color-tron-border)] bg-[var(--color-tron-bg-primary)] px-3 py-2 text-[var(--color-tron-text)]">
									<option value="">{lots1.length ? '— Select lot —' : 'No lots available'}</option>
									{#each lots1 as l (l.lotId)}
										<option value={l.lotId}>{l.lotId} — {l.remaining} left</option>
									{/each}
								</select>
							</div>
							<div>
								<label for="lot2" class="block text-xs font-medium text-[var(--color-tron-text-secondary)]">Thermoseal laser-cut sheet lot (PT-CT-112)</label>
								<select id="lot2" bind:value={lot2} class="mt-1 w-full rounded border border-[var(--color-tron-border)] bg-[var(--color-tron-bg-primary)] px-3 py-2 text-[var(--color-tron-text)]">
									<option value="">{lots2.length ? '— Select lot —' : 'No lots available'}</option>
									{#each lots2 as l (l.lotId)}
										<option value={l.lotId}>{l.lotId} — {l.remaining} left</option>
									{/each}
								</select>
							</div>
							<div>
								<label for="lot3" class="block text-xs font-medium text-[var(--color-tron-text-secondary)]">Barcode label lot (PT-CT-106)</label>
								<select id="lot3" bind:value={lot3} class="mt-1 w-full rounded border border-[var(--color-tron-border)] bg-[var(--color-tron-bg-primary)] px-3 py-2 text-[var(--color-tron-text)]">
									<option value="">{lots3.length ? '— Select lot —' : 'No lots available'}</option>
									{#each lots3 as l (l.lotId)}
										<option value={l.lotId}>{l.lotId} — {l.remaining} left</option>
									{/each}
								</select>
							</div>
							<div>
								<label for="ovenSel" class="block text-xs font-medium text-[var(--color-tron-text-secondary)]">Oven</label>
								<select id="ovenSel" bind:value={ovenId} class="mt-1 w-full rounded border border-[var(--color-tron-border)] bg-[var(--color-tron-bg-primary)] px-3 py-2 text-[var(--color-tron-text)]">
									<option value="">{(data.ovens ?? []).length ? '— Select oven —' : 'No ovens available'}</option>
									{#each (data.ovens ?? []) as oven (oven._id)}
										<option value={oven._id}>{oven.name}</option>
									{/each}
								</select>
							</div>
						</div>

						{#if startError || (form?.checkAndStart && (form.checkAndStart as any).error)}
							<p class="text-sm text-[var(--color-tron-error)]">{startError || (form.checkAndStart as any).error}</p>
						{/if}

						<button
							type="submit"
							disabled={!configReady || starting}
							class="w-full rounded-lg bg-[var(--color-tron-cyan)] py-4 text-lg font-bold text-[var(--color-tron-bg-primary)] transition-opacity hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-30"
						>
							Start session
						</button>
					</div>
				</form>

				<!-- Resume in-progress batches -->
				{#each data.recentLots.filter((l) => l.status === 'In Progress') as ipLot (ipLot.lotId)}
					<div class="mt-4 rounded-lg border border-[var(--color-tron-yellow)]/50 bg-[var(--color-tron-yellow)]/5 p-3">
						<div class="flex items-center justify-between">
							<div>
								<span class="font-mono text-sm text-[var(--color-tron-yellow)]">{ipLot.lotId}</span>
								<span class="ml-2 text-xs text-[var(--color-tron-text-secondary)]">{ipLot.operatorName}</span>
							</div>
							<div class="flex items-center gap-2">
								<form method="POST" action="?/resumeLot" use:enhance>
									<input type="hidden" name="lotId" value={ipLot.lotId} />
									<button type="submit" class="rounded border border-[var(--color-tron-yellow)]/50 bg-[var(--color-tron-yellow)]/20 px-4 py-2 text-sm font-medium text-[var(--color-tron-yellow)] hover:bg-[var(--color-tron-yellow)]/30">Resume</button>
								</form>
								<form method="POST" action="?/deleteLot" use:enhance onsubmit={(e) => { if (!confirm(`Delete in-progress batch ${ipLot.lotId}? No inventory was withdrawn yet.`)) e.preventDefault(); }}>
									<input type="hidden" name="lotId" value={ipLot.lotId} />
									<button type="submit" class="rounded border border-red-500/50 bg-red-900/20 px-4 py-2 text-sm font-medium text-red-300 hover:bg-red-900/30">Delete</button>
								</form>
							</div>
						</div>
					</div>
				{/each}

			{:else if step === 'session'}
				<!-- Rapid-fire scan backed cartridges into the configured oven -->
				<div class="space-y-5">
					<div class="text-center">
						<p class="text-lg font-semibold text-[var(--color-tron-text)]">Scan cartridges into oven</p>
						<p class="mt-1 text-xs text-[var(--color-tron-text-secondary)]">Each scan creates the cartridge record with the batch's lots + oven entry time.</p>
					</div>

					<!-- Locked batch config -->
					<div class="rounded border border-[var(--color-tron-border)] bg-[var(--color-tron-bg-primary)] p-3 text-xs">
						{#if ovenId}
							<div class="flex flex-wrap gap-x-4 gap-y-1 text-[var(--color-tron-text-secondary)]">
								<span>Oven <span class="font-mono text-[var(--color-tron-text)]">{ovenName}</span></span>
								{#if lot1}<span>blank <span class="font-mono text-[var(--color-tron-text)]">{lot1}</span></span>{/if}
								{#if lot2}<span>sheet <span class="font-mono text-[var(--color-tron-text)]">{lot2}</span></span>{/if}
								{#if lot3}<span>label <span class="font-mono text-[var(--color-tron-text)]">{lot3}</span></span>{/if}
							</div>
						{:else}
							<!-- Resumed batch with no client-side oven yet: pick the oven to continue -->
							<label for="ovenResume" class="block text-[var(--color-tron-text-secondary)]">Select oven to continue scanning</label>
							<select id="ovenResume" bind:value={ovenId} class="mt-1 w-full rounded border border-[var(--color-tron-border)] bg-[var(--color-tron-bg-primary)] px-3 py-2 text-[var(--color-tron-text)]">
								<option value="">— Select oven —</option>
								{#each (data.ovens ?? []) as oven (oven._id)}
									<option value={oven._id}>{oven.name}</option>
								{/each}
							</select>
						{/if}
					</div>

					<div>
						<label for="cartScanInput" class="block text-xs font-medium text-[var(--color-tron-text-secondary)]">Scan cartridge barcode</label>
						<input
							type="text"
							id="cartScanInput"
							bind:value={cartScanInput}
							onkeydown={(e) => { if (e.key === 'Enter') { e.preventDefault(); handleCartScan(); } }}
							disabled={!ovenId || cartScanBusy}
							placeholder={ovenId ? 'Scan cartridge…' : 'Select an oven first'}
							autocomplete="off"
							class="mt-1 w-full rounded border border-[var(--color-tron-cyan)]/50 bg-[var(--color-tron-bg-primary)] px-3 py-3 font-mono text-[var(--color-tron-text)] placeholder:text-[var(--color-tron-text-secondary)]/50 focus:border-[var(--color-tron-cyan)] focus:outline-none disabled:opacity-50"
						/>
						{#if cartScanError}
							<p class="mt-1 text-sm text-[var(--color-tron-error)]">{cartScanError}</p>
						{/if}
					</div>

					<div class="rounded border border-[var(--color-tron-border)] bg-[var(--color-tron-bg-primary)] p-3">
						<div class="flex items-center justify-between">
							<p class="text-xs text-[var(--color-tron-text-secondary)]">Scanned into oven</p>
							<p class="text-sm font-bold text-[var(--color-tron-cyan)]">{scannedCarts.length}</p>
						</div>
						{#if scannedCarts.length > 0}
							<ul class="mt-2 max-h-60 space-y-1 overflow-y-auto">
								{#each scannedCarts as barcode (barcode)}
									<li class="flex items-center justify-between rounded bg-[var(--color-tron-surface)] px-2 py-1">
										<span class="font-mono text-xs text-[var(--color-tron-text)]">{barcode}</span>
										<button type="button" onclick={() => removeCartScan(barcode)} class="text-xs text-[var(--color-tron-error)] hover:underline">Remove</button>
									</li>
								{/each}
							</ul>
						{/if}
					</div>

					<div class="flex justify-center gap-3 pt-2">
						<button type="button" disabled={scannedCarts.length === 0} onclick={() => { step = 'confirm'; }} class="rounded-lg bg-green-600 px-6 py-3 font-bold text-white transition-colors hover:bg-green-500 disabled:opacity-40">
							Finish session
						</button>
					</div>
				</div>

			{:else if step === 'confirm'}
				<!-- Confirm count + scrap, then withdraw inventory -->
				<form method="POST" action="?/confirmComplete" use:enhance>
					<input type="hidden" name="lotId" value={lotId} />
					<input type="hidden" name="notes" value={sessionNotes} />
					<div class="space-y-5">
						<div class="text-center">
							<p class="text-lg font-semibold text-[var(--color-tron-text)]">Good cartridges (scanned into oven)</p>
							<p class="mt-2 text-4xl font-bold text-[var(--color-tron-cyan)]">{scannedCarts.length}</p>
							<p class="mt-1 text-xs text-[var(--color-tron-text-secondary)]">Go back to scan more or remove mis-scans</p>
						</div>

						<div>
							<p class="text-lg font-semibold text-[var(--color-tron-text)]">Scrapped parts</p>
							<p class="text-xs text-[var(--color-tron-text-secondary)]">How many of each part were scrapped (0 if none)</p>
							<div class="mt-3 grid grid-cols-3 gap-3">
								<div class="rounded border border-[var(--color-tron-border)] bg-[var(--color-tron-bg-primary)] p-3 text-center">
									<p class="text-xs text-[var(--color-tron-text-secondary)]">Cartridges</p>
									<input type="number" name="scrapCartridge" bind:value={scrapCartridge} min="0" class="mt-1 w-full rounded border border-[var(--color-tron-border)] bg-[var(--color-tron-bg-primary)] px-2 py-2 text-center text-xl font-bold text-[var(--color-tron-text)]" />
								</div>
								<div class="rounded border border-[var(--color-tron-border)] bg-[var(--color-tron-bg-primary)] p-3 text-center">
									<p class="text-xs text-[var(--color-tron-text-secondary)]">Thermoseal</p>
									<input type="number" name="scrapThermoseal" bind:value={scrapThermoseal} min="0" class="mt-1 w-full rounded border border-[var(--color-tron-border)] bg-[var(--color-tron-bg-primary)] px-2 py-2 text-center text-xl font-bold text-[var(--color-tron-text)]" />
								</div>
								<div class="rounded border border-[var(--color-tron-border)] bg-[var(--color-tron-bg-primary)] p-3 text-center">
									<p class="text-xs text-[var(--color-tron-text-secondary)]">Barcodes</p>
									<input type="number" name="scrapBarcode" bind:value={scrapBarcode} min="0" class="mt-1 w-full rounded border border-[var(--color-tron-border)] bg-[var(--color-tron-bg-primary)] px-2 py-2 text-center text-xl font-bold text-[var(--color-tron-text)]" />
								</div>
							</div>
							{#if hasScrap}
								<div class="mt-3">
									<label for="scrapReason" class="block text-xs font-medium text-[var(--color-tron-text-secondary)]">Scrap reason (required)</label>
									<input type="text" id="scrapReason" name="scrapReason" bind:value={scrapReason} required placeholder="Why were these scrapped?" class="mt-1 w-full rounded border border-[var(--color-tron-border)] bg-[var(--color-tron-bg-primary)] px-3 py-2 text-sm text-[var(--color-tron-text)] placeholder:text-[var(--color-tron-text-secondary)]/50" />
								</div>
							{/if}
						</div>

						<div class="rounded border border-[var(--color-tron-border)] bg-[var(--color-tron-bg-primary)] p-3">
							<p class="mb-2 text-center text-xs text-[var(--color-tron-text-secondary)]">Withdrawal summary</p>
							<div class="grid grid-cols-3 gap-2 text-center text-sm">
								<div><p class="text-xs text-[var(--color-tron-text-secondary)]">Cartridges</p><p class="font-bold text-[var(--color-tron-text)]">{scannedCarts.length + scrapCartridge}</p></div>
								<div><p class="text-xs text-[var(--color-tron-text-secondary)]">Thermoseal</p><p class="font-bold text-[var(--color-tron-text)]">{scannedCarts.length + scrapThermoseal}</p></div>
								<div><p class="text-xs text-[var(--color-tron-text-secondary)]">Barcodes</p><p class="font-bold text-[var(--color-tron-text)]">{scannedCarts.length + scrapBarcode}</p></div>
							</div>
						</div>

						<div>
							<label for="notes" class="block text-xs font-medium text-[var(--color-tron-text-secondary)]">Notes</label>
							<textarea id="notes" bind:value={sessionNotes} rows="2" placeholder="Optional notes…" class="mt-1 w-full rounded border border-[var(--color-tron-border)] bg-[var(--color-tron-bg-primary)] px-3 py-2 text-sm text-[var(--color-tron-text)] placeholder:text-[var(--color-tron-text-secondary)]/50"></textarea>
						</div>

						{#if form?.confirmComplete && (form.confirmComplete as any).error}
							<p class="text-center text-sm text-[var(--color-tron-error)]">{(form.confirmComplete as any).error}</p>
						{/if}

						<div class="flex justify-center gap-3 pt-2">
							<button type="submit" class="rounded-lg bg-green-600 px-6 py-3 font-bold text-white transition-colors hover:bg-green-500">Confirm &amp; withdraw</button>
							<button type="button" onclick={() => { step = 'session'; focusScan(); }} class="rounded-lg border border-[var(--color-tron-border)] px-4 py-3 text-sm text-[var(--color-tron-text-secondary)]">Go back</button>
						</div>
					</div>
				</form>
			{/if}
		</div>

		<!-- Recent Batches (config screen only) -->
		{#if data.recentLots.length > 0 && step === 'config'}
			<div class="border-t border-[var(--color-tron-border)] pt-4">
				<h2 class="text-sm font-medium text-[var(--color-tron-text-secondary)]">Recent batches</h2>
				<div class="mt-2 overflow-x-auto">
					<table class="w-full text-left text-sm">
						<thead>
							<tr class="border-b border-[var(--color-tron-border)] text-[var(--color-tron-text-secondary)]">
								<th class="px-3 py-2">Lot</th>
								<th class="px-3 py-2">Qty</th>
								<th class="px-3 py-2">Operator</th>
								<th class="px-3 py-2">Status</th>
								<th class="px-3 py-2">Time</th>
							</tr>
						</thead>
						<tbody>
							{#each data.recentLots as lot (lot.lotId)}
								<tr class="border-b border-[var(--color-tron-border)]">
									<td class="px-3 py-2 font-mono text-xs"><a href="/manufacturing/lots/{lot.lotId}" class="text-[var(--color-tron-cyan)] hover:underline">{lot.outputLotNumber ?? lot.bucketBarcode ?? '(in progress)'}</a></td>
									<td class="px-3 py-2 text-[var(--color-tron-text)]">{lot.quantityProduced}</td>
									<td class="px-3 py-2 text-[var(--color-tron-text)]">{lot.operatorName}</td>
									<td class="px-3 py-2 text-[var(--color-tron-text)]">{lot.status}</td>
									<td class="px-3 py-2 text-[var(--color-tron-text-secondary)]">{lot.finishTime ? new Date(lot.finishTime).toLocaleString() : new Date(lot.createdAt).toLocaleString()}</td>
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
			<div class="max-w-sm rounded-lg border border-green-500/30 bg-[var(--color-tron-bg-secondary)] p-6 text-center shadow-lg">
				<div class="mb-3 text-4xl">&#10003;</div>
				<h3 class="text-lg font-semibold text-green-400">Batch complete</h3>
				<p class="mt-2 text-[var(--color-tron-text)]">{handoffPrompt}</p>
				<p class="mt-1 text-sm text-[var(--color-tron-text-secondary)]">Inventory has been withdrawn.</p>
				<button type="button" onclick={resetAll} class="mt-4 rounded bg-[var(--color-tron-cyan)] px-6 py-2 font-semibold text-[var(--color-tron-bg-primary)]">Done</button>
			</div>
		</div>
	{/if}
{/if}
