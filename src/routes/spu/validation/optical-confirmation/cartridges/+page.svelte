<script lang="ts">
	interface Assay {
		_id: string;
		name: string;
		skuCode: string;
	}

	interface Cartridge {
		_id: string;
		barcode: string;
		assay?: { _id?: string; name?: string; skuCode?: string } | null;
		status?: string;
		expirationDate?: string | null;
		createdAt?: string;
	}

	interface Props {
		data: {
			assays: Assay[];
			cartridges: Cartridge[];
		};
	}

	let { data }: Props = $props();

	// Form fields
	let barcode = $state('');
	let assaySkuCode = $state('');
	let lotNumber = $state('');
	let serialNumber = $state('');
	let expirationDate = $state('');

	// UI state
	let isSubmitting = $state(false);
	let errorMessage = $state<string | null>(null);
	let successMessage = $state<string | null>(null);

	// Local copy of the cartridge list so we can prepend on success
	let cartridges = $state<Cartridge[]>(data.cartridges ?? []);

	// Only assays that actually have a SKU code can be selected (blank-SKU options would leave the value empty)
	let validAssays = $derived(data.assays.filter((a) => a.skuCode && a.skuCode.trim().length > 0));
	let isValid = $derived(barcode.trim().length > 0 && assaySkuCode.trim().length > 0);

	// Live "is this barcode already used?" check
	let barcodeStatus = $state<{
		checking: boolean;
		exists: boolean;
		used?: boolean;
		status?: string;
		cartridgeType?: string;
	} | null>(null);

	async function checkBarcode() {
		const b = barcode.trim();
		if (!b) {
			barcodeStatus = null;
			return;
		}
		barcodeStatus = { checking: true, exists: false };
		try {
			const res = await fetch(
				'/api/validation/optical-confirmation/cartridges?barcode=' + encodeURIComponent(b)
			);
			const r = await res.json();
			barcodeStatus = {
				checking: false,
				exists: !!r.exists,
				used: r.used,
				status: r.status,
				cartridgeType: r.cartridgeType
			};
		} catch {
			barcodeStatus = null;
		}
	}

	function statusBadge(status?: string) {
		switch (status) {
			case 'available':
				return { label: 'Available', class: 'bg-[var(--color-tron-green)]/20 text-[var(--color-tron-green)]' };
			case 'in_use':
				return { label: 'In Use', class: 'bg-[var(--color-tron-cyan)]/20 text-[var(--color-tron-cyan)]' };
			case 'expired':
			case 'disposed':
			case 'depleted':
				return { label: status, class: 'bg-[var(--color-tron-red)]/20 text-[var(--color-tron-red)]' };
			case 'quarantine':
				return { label: 'Quarantine', class: 'bg-[var(--color-tron-orange)]/20 text-[var(--color-tron-orange)]' };
			default:
				return {
					label: status ?? 'unknown',
					class: 'bg-[var(--color-tron-text-secondary)]/20 text-[var(--color-tron-text-secondary)]'
				};
		}
	}

	function formatDate(value?: string | null): string {
		if (!value) return '—';
		const d = new Date(value);
		if (isNaN(d.getTime())) return '—';
		return d.toLocaleDateString();
	}

	async function handleSubmit(e: SubmitEvent) {
		e.preventDefault();
		if (!isValid || isSubmitting) return;

		isSubmitting = true;
		errorMessage = null;
		successMessage = null;

		try {
			const res = await fetch('/api/validation/optical-confirmation/cartridges', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({
					barcode: barcode.trim(),
					assaySkuCode: assaySkuCode.trim(),
					lotNumber: lotNumber.trim() || undefined,
					serialNumber: serialNumber.trim() || undefined,
					expirationDate: expirationDate || undefined
				})
			});

			const result = await res.json();

			if (!res.ok || result.error) {
				errorMessage = result.error ?? 'Failed to capture cartridge';
				return;
			}

			if (result.cartridge) {
				cartridges = [result.cartridge as Cartridge, ...cartridges];
			}

			successMessage = `Cartridge ${barcode.trim()} captured.`;

			// Clear the form
			barcode = '';
			assaySkuCode = '';
			lotNumber = '';
			serialNumber = '';
			expirationDate = '';
		} catch (err) {
			errorMessage = err instanceof Error ? err.message : 'Network error';
		} finally {
			isSubmitting = false;
		}
	}
</script>

<div class="space-y-6">
	<div class="flex items-start justify-between">
		<div>
			<h1 class="tron-heading text-2xl font-bold">Capture Optical-Test Cartridges</h1>
			<p class="tron-text-muted mt-1">
				Register optical_test cartridges made outside the standard workflow
			</p>
		</div>
		<a
			href="/spu/validation/optical-confirmation"
			class="tron-text-muted text-sm hover:text-[var(--color-tron-cyan)]"
		>
			← Back to run page
		</a>
	</div>

	<div class="tron-card p-6">
		<form class="space-y-4" onsubmit={handleSubmit}>
			<div>
				<label for="barcode" class="tron-text-muted mb-2 block text-sm font-medium">
					Barcode <span class="text-[var(--color-tron-red)]">*</span>
				</label>
				<input
					id="barcode"
					type="text"
					bind:value={barcode}
					onblur={checkBarcode}
					placeholder="Scan or type barcode"
					class="tron-input w-full rounded-lg px-4 py-3 text-lg"
				/>
				{#if barcodeStatus && !barcodeStatus.checking}
					{#if !barcodeStatus.exists}
						<p class="mt-1 text-xs text-[var(--color-tron-green)]">✓ Barcode is free — available to capture.</p>
					{:else}
						<p class="mt-1 text-xs text-[var(--color-tron-red)]">
							⚠ Already in the system (type: {barcodeStatus.cartridgeType}, status: {barcodeStatus.status}){barcodeStatus.used ? ' — in use' : ''}. Pick a different barcode.
						</p>
					{/if}
				{/if}
			</div>

			<div>
				<label for="assay" class="tron-text-muted mb-2 block text-sm font-medium">
					Assay <span class="text-[var(--color-tron-red)]">*</span>
				</label>
				{#if validAssays.length > 0}
					<select id="assay" bind:value={assaySkuCode} class="tron-input w-full rounded-lg px-4 py-3">
						<option value="">Select an assay…</option>
						{#each validAssays as assay (assay._id)}
							<option value={assay.skuCode}>{assay.name} ({assay.skuCode})</option>
						{/each}
					</select>
				{:else}
					<input
						id="assay"
						type="text"
						bind:value={assaySkuCode}
						placeholder="Enter assay SKU code"
						class="tron-input w-full rounded-lg px-4 py-3"
					/>
					<p class="tron-text-muted mt-1 text-xs">No assays returned from the catalog — type the assay SKU code manually.</p>
				{/if}
			</div>

			<div class="grid grid-cols-1 gap-4 sm:grid-cols-2">
				<div>
					<label for="lotNumber" class="tron-text-muted mb-2 block text-sm font-medium">
						Lot Number
					</label>
					<input
						id="lotNumber"
						type="text"
						bind:value={lotNumber}
						class="tron-input w-full rounded-lg px-4 py-3"
					/>
				</div>
				<div>
					<label for="serialNumber" class="tron-text-muted mb-2 block text-sm font-medium">
						Serial Number
					</label>
					<input
						id="serialNumber"
						type="text"
						bind:value={serialNumber}
						class="tron-input w-full rounded-lg px-4 py-3"
					/>
				</div>
			</div>

			<div>
				<label for="expirationDate" class="tron-text-muted mb-2 block text-sm font-medium">
					Expiration Date
				</label>
				<input
					id="expirationDate"
					type="date"
					bind:value={expirationDate}
					class="tron-input w-full rounded-lg px-4 py-3"
				/>
			</div>

			{#if errorMessage}
				<div class="rounded-lg bg-[var(--color-tron-red)]/10 p-4 text-[var(--color-tron-red)]">
					{errorMessage}
				</div>
			{/if}

			{#if successMessage}
				<div
					class="rounded-lg border border-[var(--color-tron-green)]/30 bg-[var(--color-tron-green)]/10 p-4 text-[var(--color-tron-green)]"
				>
					{successMessage}
				</div>
			{/if}

			<button
				type="submit"
				disabled={!isValid || isSubmitting}
				class="flex w-full items-center justify-center gap-3 rounded-lg bg-[var(--color-tron-orange)] px-6 py-4 text-lg font-semibold text-[var(--color-tron-bg-primary)] transition-all hover:bg-[var(--color-tron-orange)]/90 disabled:cursor-not-allowed disabled:opacity-50"
			>
				{isSubmitting ? 'Capturing…' : 'Capture Cartridge'}
			</button>
			{#if !isValid}
				<p class="tron-text-muted text-center text-xs">
					To enable — barcode: {barcode.trim() ? '✓' : '✗ empty'} · assay SKU: {assaySkuCode.trim() ? `✓ ${assaySkuCode}` : '✗ empty'}
				</p>
			{/if}
		</form>
	</div>

	<div class="tron-card">
		<div class="flex items-center justify-between border-b border-[var(--color-tron-border)] p-4">
			<h2 class="tron-heading text-lg font-semibold">Optical-Test Cartridges</h2>
			<span class="tron-text-muted text-sm">{cartridges.length} shown</span>
		</div>

		{#if cartridges.length === 0}
			<p class="tron-text-muted p-4 text-sm">No optical-test cartridges captured yet.</p>
		{:else}
			<div class="max-h-96 overflow-y-auto">
				<table class="w-full text-sm">
					<thead class="sticky top-0 bg-[var(--color-tron-bg-secondary)]">
						<tr class="text-left">
							<th class="tron-text-muted p-2">Barcode</th>
							<th class="tron-text-muted p-2">Assay SKU</th>
							<th class="tron-text-muted p-2">Status</th>
							<th class="tron-text-muted p-2">Expiration</th>
						</tr>
					</thead>
					<tbody>
						{#each cartridges as cartridge (cartridge._id)}
							{@const badge = statusBadge(cartridge.status)}
							<tr class="border-t border-[var(--color-tron-border)]">
								<td class="p-2 font-mono">{cartridge.barcode}</td>
								<td class="tron-text-muted p-2">{cartridge.assay?.skuCode ?? '—'}</td>
								<td class="p-2">
									<span class="rounded-full px-2 py-1 text-xs font-medium {badge.class}">
										{badge.label}
									</span>
								</td>
								<td class="tron-text-muted p-2">{formatDate(cartridge.expirationDate)}</td>
							</tr>
						{/each}
					</tbody>
				</table>
			</div>
		{/if}
	</div>
</div>
