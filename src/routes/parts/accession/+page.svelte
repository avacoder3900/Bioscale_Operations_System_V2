<script lang="ts">
	import { enhance } from '$app/forms';

	let { data, form } = $props();

	// Part barcode scan state
	let partScan = $state('');
	let partScanStatus = $state<'idle' | 'checking' | 'found' | 'not-found'>('idle');
	let partScanInfo = $state('');
	let selectedPartId = $state('');
	let selectedPartDisplay = $state('');

	// Inline registration state (when part barcode not found)
	let showRegister = $state(false);
	let registerPartId = $state('');
	let registerBarcode = $state('');
	let registerSubmitting = $state(false);

	// Lot scan state
	let lotBarcode = $state('');
	let lotLookupStatus = $state<'idle' | 'checking' | 'available' | 'exists'>('idle');
	let lotLookupInfo = $state('');
	let lotLookupTimer: ReturnType<typeof setTimeout> | undefined;

	// Quantity
	let quantity = $state('');

	// Session log
	let sessionLog = $state<Array<{ part: string; lotBarcode: string; qty: number; status: 'ok' | 'error'; message?: string }>>([]);

	// Element refs
	let partScanInput: HTMLInputElement | undefined = $state();
	let lotBarcodeInput: HTMLInputElement | undefined = $state();
	let quantityInput: HTMLInputElement | undefined = $state();

	// Computed
	let totalUnits = $derived(sessionLog.filter(s => s.status === 'ok').reduce((sum, s) => sum + s.qty, 0));
	let allParts = $derived([...data.registered, ...data.unregistered]);

	async function handlePartScan(e: KeyboardEvent) {
		if (e.key !== 'Enter') return;
		e.preventDefault();
		const barcode = partScan.trim();
		if (!barcode) return;

		showRegister = false;
		partScanStatus = 'checking';

		try {
			const res = await fetch(`/api/parts/lookup-by-barcode?barcode=${encodeURIComponent(barcode)}`);
			if (res.ok) {
				const result = await res.json();
				selectedPartId = result.id;
				selectedPartDisplay = `${result.partNumber} — ${result.name}`;
				partScanStatus = 'found';
				partScanInfo = selectedPartDisplay;
				setTimeout(() => lotBarcodeInput?.focus(), 50);
			} else {
				partScanStatus = 'not-found';
				partScanInfo = barcode;
				registerBarcode = barcode;
				registerPartId = '';
				showRegister = true;
			}
		} catch {
			partScanStatus = 'not-found';
			partScanInfo = 'Lookup failed — check connection';
		}
	}

	async function handleRegister() {
		if (!registerPartId || !registerBarcode) return;
		registerSubmitting = true;

		try {
			const formData = new FormData();
			formData.set('partId', registerPartId);
			formData.set('barcode', registerBarcode);
			const res = await fetch('?/registerBarcode', { method: 'POST', body: formData });
			const result = await res.json();

			// SvelteKit form action responses have a specific shape
			if (result.type === 'success' && result.data?.registerSuccess) {
				selectedPartId = result.data.registeredPartId;
				selectedPartDisplay = `${result.data.registeredPartNumber} — ${result.data.registeredPartName}`;
				partScanStatus = 'found';
				partScanInfo = selectedPartDisplay;
				showRegister = false;
				setTimeout(() => lotBarcodeInput?.focus(), 50);
			} else {
				partScanInfo = result.data?.registerError ?? 'Registration failed';
			}
		} catch {
			partScanInfo = 'Registration failed — check connection';
		} finally {
			registerSubmitting = false;
		}
	}

	function handleLotInput(value: string) {
		lotBarcode = value;
		lotLookupStatus = 'idle';
		lotLookupInfo = '';
		if (lotLookupTimer) clearTimeout(lotLookupTimer);
		if (!value.trim()) return;
		lotLookupTimer = setTimeout(async () => {
			lotLookupStatus = 'checking';
			try {
				const res = await fetch(`/api/parts/lookup?barcode=${encodeURIComponent(value.trim())}`);
				if (res.ok) {
					const data = await res.json();
					lotLookupStatus = 'exists';
					lotLookupInfo = `Already registered as Lot #${data.lot.lotNumber}`;
				} else if (res.status === 404) {
					lotLookupStatus = 'available';
					lotLookupInfo = '';
				} else {
					lotLookupStatus = 'idle';
				}
			} catch {
				lotLookupStatus = 'idle';
			}
		}, 300);
	}

	function handleLotKeydown(e: KeyboardEvent) {
		if (e.key === 'Enter') {
			e.preventDefault();
			setTimeout(() => quantityInput?.focus(), 50);
		}
	}

	function handleQtyKeydown(e: KeyboardEvent) {
		if (e.key === 'Enter') {
			e.preventDefault();
			// Submit form
			const formEl = (e.target as HTMLElement).closest('form');
			if (formEl) formEl.requestSubmit();
		}
	}
</script>

<svelte:head>
	<title>Part Accession</title>
</svelte:head>

<div class="mx-auto max-w-7xl p-4 md:p-6">
	<!-- Header -->
	<div class="mb-6 flex items-center justify-between">
		<div>
			<h1 class="tron-text-primary font-mono text-2xl font-bold">Part Accession</h1>
			<p class="tron-text-muted mt-1 text-sm">Scan barcodes to accession inventory</p>
		</div>
		<a href="/parts" class="text-sm text-[var(--color-tron-cyan)] hover:underline">&larr; Back to Parts</a>
	</div>

	<!-- Two-panel layout -->
	<div class="grid grid-cols-1 gap-6 lg:grid-cols-2">
		<!-- LEFT PANEL: Register & Scan -->
		<div class="tron-card">
			<h2 class="tron-text-primary mb-4 font-mono text-lg font-bold">Register & Scan</h2>

			<!-- Step 1: Scan Part Barcode -->
			<div class="mb-4">
				<label for="part-scan" class="tron-text-muted mb-1 block text-xs font-medium uppercase tracking-wider">Step 1 — Scan Part Barcode</label>
				<input
					id="part-scan"
					type="text"
					bind:this={partScanInput}
					bind:value={partScan}
					onkeydown={handlePartScan}
					onfocus={() => { partScan = ''; partScanStatus = 'idle'; showRegister = false; }}
					autofocus
					placeholder="Scan part label..."
					class="tron-input w-full text-lg"
				/>
				{#if partScanStatus === 'checking'}
					<p class="tron-text-muted mt-1 text-sm">Checking...</p>
				{/if}
				{#if partScanStatus === 'found'}
					<p class="mt-1 text-sm text-[var(--color-tron-green)]">&#10003; {partScanInfo}</p>
				{/if}
				{#if partScanStatus === 'not-found' && !showRegister}
					<p class="mt-1 text-sm text-[var(--color-tron-red)]">{partScanInfo}</p>
				{/if}
			</div>

			<!-- Inline Registration (when barcode not found) -->
			{#if showRegister}
				<div class="mb-4 rounded border border-[var(--color-tron-yellow)] border-opacity-40 bg-[color-mix(in_srgb,var(--color-tron-yellow)_8%,var(--color-tron-bg-secondary))] p-3">
					<p class="mb-2 text-sm text-[var(--color-tron-yellow)]">
						Barcode "<span class="font-mono">{registerBarcode}</span>" not registered — register it now?
					</p>
					<div class="flex items-end gap-2">
						<div class="flex-1">
							<label for="reg-part" class="tron-text-muted mb-1 block text-xs">Select Part</label>
							<select
								id="reg-part"
								bind:value={registerPartId}
								class="tron-select w-full"
							>
								<option value="">Pick a part...</option>
								{#each allParts as part}
									<option value={part.id}>{part.partNumber} — {part.name}</option>
								{/each}
							</select>
						</div>
						<button
							onclick={handleRegister}
							disabled={!registerPartId || registerSubmitting}
							class="tron-btn-primary whitespace-nowrap px-4 py-2 text-sm"
						>
							{registerSubmitting ? 'Registering...' : 'Register & Continue'}
						</button>
					</div>
				</div>
			{/if}

			<!-- Step 2: Scan Lot Barcode -->
			<div class="mb-4">
				<label for="lot-scan" class="tron-text-muted mb-1 block text-xs font-medium uppercase tracking-wider">Step 2 — Scan Lot Barcode</label>
				<input
					id="lot-scan"
					type="text"
					bind:this={lotBarcodeInput}
					value={lotBarcode}
					oninput={(e) => handleLotInput(e.currentTarget.value)}
					onkeydown={handleLotKeydown}
					disabled={!selectedPartId}
					placeholder={selectedPartId ? 'Scan bag/lot barcode...' : 'Select part first'}
					class="tron-input w-full text-lg"
				/>
				{#if lotLookupStatus === 'checking'}
					<p class="tron-text-muted mt-1 text-sm">Checking...</p>
				{/if}
				{#if lotLookupStatus === 'exists'}
					<p class="mt-1 text-sm text-[var(--color-tron-red)]">{lotLookupInfo}</p>
				{/if}
				{#if lotLookupStatus === 'available'}
					<p class="mt-1 text-sm text-[var(--color-tron-green)]">&#10003; Available</p>
				{/if}
			</div>

			<!-- Step 3: Quantity -->
			<div class="mb-5">
				<label for="qty" class="tron-text-muted mb-1 block text-xs font-medium uppercase tracking-wider">Step 3 — Quantity</label>
				<input
					id="qty"
					type="number"
					min="1"
					bind:this={quantityInput}
					bind:value={quantity}
					onkeydown={handleQtyKeydown}
					disabled={!selectedPartId}
					placeholder="0"
					class="tron-input w-full text-lg"
				/>
			</div>

			<!-- Accession Button -->
			<form method="POST" action="?/quickScan" use:enhance={() => {
				return async ({ result, update }) => {
					if (result.type === 'success' && result.data?.quickScanSuccess) {
						sessionLog = [{
							part: result.data.partNumber as string,
							lotBarcode: result.data.bagBarcode as string,
							qty: result.data.quantity as number,
							status: 'ok' as const
						}, ...sessionLog];
						lotBarcode = '';
						quantity = '';
						lotLookupStatus = 'idle';
						lotLookupInfo = '';
						await update();
						setTimeout(() => lotBarcodeInput?.focus(), 50);
					} else {
						const errorMsg = result.type === 'failure' ? (result.data as any)?.error : 'Accession failed';
						if (lotBarcode && selectedPartDisplay) {
							sessionLog = [{
								part: selectedPartDisplay.split(' — ')[0] || selectedPartDisplay,
								lotBarcode,
								qty: parseInt(quantity) || 0,
								status: 'error',
								message: errorMsg
							}, ...sessionLog];
						}
						await update();
					}
				};
			}}>
				<input type="hidden" name="partId" value={selectedPartId} />
				<input type="hidden" name="bagBarcode" value={lotBarcode} />
				<input type="hidden" name="quantity" value={quantity} />
				<input type="hidden" name="notes" value="Bulk accession - existing inventory" />
				<button
					type="submit"
					disabled={!selectedPartId || !lotBarcode || !quantity || lotLookupStatus === 'exists'}
					class="tron-btn-primary w-full py-4 text-lg font-bold tracking-wide"
				>
					ACCESSION
				</button>
			</form>

			<!-- Inline error from form action -->
			{#if form?.error}
				<p class="mt-3 text-sm text-[var(--color-tron-red)]">{form.error}</p>
			{/if}
			{#if form?.quickScanSuccess}
				<p class="mt-3 text-sm text-[var(--color-tron-green)]">
					&#10003; Accessioned {form.quantity} units of {form.partNumber} as Lot {form.lotNumber}
				</p>
			{/if}
		</div>

		<!-- RIGHT PANEL: Session Log -->
		<div class="tron-card">
			<div class="mb-4 flex items-center justify-between">
				<h2 class="tron-text-primary font-mono text-lg font-bold">Session Log</h2>
				{#if sessionLog.length > 0}
					<span class="tron-badge tron-badge-info">{sessionLog.length} scan{sessionLog.length !== 1 ? 's' : ''}</span>
				{/if}
			</div>

			{#if sessionLog.length === 0}
				<div class="flex h-48 items-center justify-center">
					<p class="tron-text-muted text-sm">No scans yet — start scanning to see results here</p>
				</div>
			{:else}
				<div class="max-h-[60vh] overflow-y-auto">
					<table class="tron-table w-full text-sm">
						<thead>
							<tr>
								<th class="text-left">Part</th>
								<th class="text-left">Lot Barcode</th>
								<th class="text-right">Qty</th>
								<th class="text-center">Status</th>
							</tr>
						</thead>
						<tbody>
							{#each sessionLog as scan}
								<tr>
									<td class="font-mono text-xs">{scan.part}</td>
									<td class="font-mono text-xs">{scan.lotBarcode}</td>
									<td class="text-right">{scan.qty}</td>
									<td class="text-center">
										{#if scan.status === 'ok'}
											<span class="text-[var(--color-tron-green)]">&#10003;</span>
										{:else}
											<span class="text-[var(--color-tron-red)]" title={scan.message}>&#10007;</span>
										{/if}
									</td>
								</tr>
							{/each}
						</tbody>
					</table>
				</div>

				<div class="mt-3 border-t border-[var(--color-tron-border)] pt-3">
					<div class="flex justify-between text-sm">
						<span class="tron-text-muted">Total units accessioned</span>
						<span class="font-mono font-bold text-[var(--color-tron-cyan)]">{totalUnits}</span>
					</div>
				</div>
			{/if}
		</div>
	</div>
</div>
