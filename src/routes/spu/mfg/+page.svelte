<script lang="ts">
	import { enhance } from '$app/forms';
	import { goto } from '$app/navigation';
	import { TronCard, TronButton } from '$lib/components/ui';
	import SpuStatusBadge from '$lib/components/spu/SpuStatusBadge.svelte';

	let { data, form } = $props();

	let lookupInput = $state('');
	let showRegisterForm = $state(false);
	let registering = $state(false);
	let registerSuccess = $state<{ spuId: string } | null>(null);
	let showCreateModal = $state(false);
	let creating = $state(false);

	function extractShortId(udi: string): string {
		const match = udi.match(/\(21\)(.+)/);
		if (!match) return udi.slice(0, 8).toUpperCase();
		return `SPU-${match[1].slice(0, 8).toUpperCase()}`;
	}

	function qcColor(status: string): string {
		if (status === 'passed' || status === 'pass') return 'var(--color-tron-green)';
		if (status === 'failed' || status === 'fail') return 'var(--color-tron-red)';
		return 'var(--color-tron-orange)';
	}

	// The lookup bar doubles as a live filter over the SPU cards.
	let filteredSpus = $derived.by(() => {
		const q = lookupInput.trim().toLowerCase();
		if (!q) return data.spus;
		return data.spus.filter(
			(s) =>
				s.udi.toLowerCase().includes(q) ||
				extractShortId(s.udi).toLowerCase().includes(q) ||
				(s.barcode && s.barcode.toLowerCase().includes(q)) ||
				(s.owner && s.owner.toLowerCase().includes(q)) ||
				(s.batchNumber && s.batchNumber.toLowerCase().includes(q))
		);
	});

	// Enter / Lookup → navigate to an exact match, otherwise offer to register.
	function handleLookup() {
		const term = lookupInput.trim();
		if (!term) return;
		const existing = data.spus.find(
			(s) =>
				(s.barcode && s.barcode.toLowerCase() === term.toLowerCase()) ||
				s.udi.toLowerCase() === term.toLowerCase() ||
				extractShortId(s.udi).toLowerCase() === term.toLowerCase()
		);
		if (existing) {
			goto(`/spu/${existing.id}`);
		} else {
			showRegisterForm = true;
		}
	}

	$effect(() => {
		if (form?.success && form?.spuId) {
			registerSuccess = { spuId: form.spuId };
			showRegisterForm = false;
			lookupInput = '';
		}
	});

	function formatDate(date: Date | string): string {
		return new Date(date).toLocaleDateString();
	}
</script>

<div class="space-y-6">
	<div class="flex items-center justify-between">
		<div>
			<h2 class="tron-text-primary text-2xl font-bold">SPU Manufacturing</h2>
			<p class="tron-text-muted text-sm">Look up a unit by UDI / serial, or open its record below</p>
		</div>
		<TronButton variant="primary" onclick={() => (showCreateModal = true)} style="min-height: 44px;">
			+ New SPU
		</TronButton>
	</div>

	<!-- UDI / Serial Lookup -->
	<TronCard>
		<h3 class="tron-text-primary mb-3 text-lg font-bold">UDI / Serial Lookup</h3>
		<div class="flex gap-3">
			<input
				type="text"
				class="tron-input flex-1"
				placeholder="Scan or type UDI / serial number..."
				bind:value={lookupInput}
				onkeydown={(e) => {
					if (e.key === 'Enter') handleLookup();
				}}
				style="min-height: 44px;"
			/>
			<TronButton variant="primary" onclick={handleLookup} style="min-height: 44px;">Lookup</TronButton>
		</div>

		{#if registerSuccess}
			<div class="mt-3 rounded border border-[var(--color-tron-green)] bg-[rgba(0,255,128,0.1)] p-3">
				<p class="text-sm text-[var(--color-tron-green)]">
					SPU registered successfully!
					<a href="/spu/{registerSuccess.spuId}" class="underline hover:text-[var(--color-tron-cyan)]">
						View SPU
					</a>
				</p>
			</div>
		{/if}

		{#if showRegisterForm}
			<div class="mt-4 rounded border border-[var(--color-tron-cyan)] bg-[rgba(0,255,255,0.03)] p-4">
				<h4 class="tron-text-primary mb-3 font-medium">Register New SPU</h4>
				<p class="tron-text-muted mb-4 text-sm">
					No SPU found for "{lookupInput}". Fill in the details to register it.
				</p>
				<form
					method="POST"
					action="?/register"
					use:enhance={() => {
						registering = true;
						return async ({ update }) => {
							registering = false;
							await update();
						};
					}}
					class="space-y-4"
				>
					<div>
						<label for="reg-udi" class="tron-label">UDI (Unique Device Identifier)</label>
						<input
							id="reg-udi"
							name="udi"
							type="text"
							class="tron-input"
							placeholder="Enter the Unique Device Identifier"
							value={lookupInput}
							disabled={registering}
							required
							style="min-height: 44px;"
						/>
					</div>

					<div>
						<label for="reg-deviceState" class="tron-label">Device State</label>
						<select
							id="reg-deviceState"
							name="deviceState"
							class="tron-select"
							required
							disabled={registering}
							style="min-height: 44px;"
						>
							<option value="draft">Draft</option>
							<option value="assembling">Assembling</option>
							<option value="assembled">Assembled</option>
							<option value="validating">Validating</option>
							<option value="validated">Validated</option>
							<option value="released-rnd">Released R&D</option>
							<option value="released-manufacturing">Released Mfg</option>
							<option value="released-field">Released Field</option>
							<option value="deployed">Deployed</option>
							<option value="servicing">Servicing</option>
							<option value="retired">Retired</option>
							<option value="voided">Voided</option>
						</select>
					</div>

					<div>
						<label for="reg-owner" class="tron-label">Owner (Optional)</label>
						<input
							id="reg-owner"
							name="owner"
							type="text"
							class="tron-input"
							placeholder="Person, team, or customer"
							disabled={registering}
							style="min-height: 44px;"
						/>
					</div>

					<div>
						<label for="reg-batchId" class="tron-label">Batch (Optional)</label>
						<select
							id="reg-batchId"
							name="batchId"
							class="tron-select"
							disabled={registering}
							style="min-height: 44px;"
						>
							<option value="">No batch</option>
							{#each data.batches as batchOption (batchOption.id)}
								<option value={batchOption.id}>{batchOption.batchNumber}</option>
							{/each}
						</select>
					</div>

					{#if form?.error}
						<div class="rounded border border-[var(--color-tron-red)] bg-[rgba(255,51,102,0.1)] p-3">
							<p class="text-sm text-[var(--color-tron-red)]">{form.error}</p>
						</div>
					{/if}

					<div class="flex gap-3 pt-2">
						<TronButton type="button" class="flex-1" onclick={() => (showRegisterForm = false)} disabled={registering}>
							Cancel
						</TronButton>
						<TronButton type="submit" variant="primary" class="flex-1" disabled={registering}>
							{registering ? 'Registering...' : 'Register SPU'}
						</TronButton>
					</div>
				</form>
			</div>
		{/if}
	</TronCard>

	<!-- SPU Widgets -->
	{#if data.spus.length === 0}
		<TronCard>
			<div class="py-12 text-center">
				<svg class="mx-auto mb-4 h-16 w-16 text-[var(--color-tron-text-secondary)]" fill="none" viewBox="0 0 24 24" stroke="currentColor">
					<path stroke-linecap="round" stroke-linejoin="round" stroke-width="1.5" d="M9 3v2m6-2v2M9 19v2m6-2v2M5 9H3m2 6H3m18-6h-2m2 6h-2M7 19h10a2 2 0 002-2V7a2 2 0 00-2-2H7a2 2 0 00-2 2v10a2 2 0 002 2zM9 9h6v6H9V9z" />
				</svg>
				<h3 class="tron-text-primary mb-2 text-lg font-medium">No SPUs Found</h3>
				<p class="tron-text-muted">Use the lookup above or "+ New SPU" to register your first unit.</p>
			</div>
		</TronCard>
	{:else}
		<div class="flex items-center justify-between">
			<h3 class="tron-text-primary text-lg font-bold">SPU Units</h3>
			<span class="tron-text-muted text-sm">
				{#if lookupInput.trim()}Showing {filteredSpus.length} of {data.spus.length}{:else}{data.spus.length} total{/if}
			</span>
		</div>

		{#if filteredSpus.length === 0}
			<TronCard>
				<p class="tron-text-muted py-8 text-center">No SPUs match "{lookupInput}".</p>
			</TronCard>
		{:else}
			<div class="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
				{#each filteredSpus as spuItem (spuItem.id)}
					<a href="/spu/{spuItem.id}" class="block">
						<TronCard interactive>
							<div class="mb-3 flex items-start justify-between">
								<div class="min-w-0">
									<div class="text-sm font-bold text-[var(--color-tron-cyan)]">
										{extractShortId(spuItem.udi)}
									</div>
									<div class="tron-text-muted mt-0.5 max-w-[200px] truncate font-mono text-xs" title={spuItem.udi}>
										{spuItem.udi}
									</div>
								</div>
								<SpuStatusBadge status={spuItem.status} />
							</div>

							<div class="flex flex-wrap items-center gap-1.5">
								<span
									class="rounded px-1.5 py-0.5 text-xs font-medium"
									style="background: color-mix(in srgb, {qcColor(spuItem.qcStatus)} 20%, transparent); color: {qcColor(spuItem.qcStatus)};"
								>
									QC: {spuItem.qcStatus}
								</span>
								<span
									class="rounded px-1.5 py-0.5 text-xs font-medium"
									style="background: color-mix(in srgb, {qcColor(spuItem.validationStatus)} 20%, transparent); color: {qcColor(spuItem.validationStatus)};"
								>
									Val: {spuItem.validationStatus}
								</span>
							</div>

							{#if spuItem.owner}
								<div class="mt-2 text-sm text-[var(--color-tron-cyan)]">Owner: {spuItem.owner}</div>
							{/if}
							{#if spuItem.batchNumber}
								<div class="tron-text-muted mt-1 text-sm">Batch: {spuItem.batchNumber}</div>
							{/if}
							<div class="tron-text-muted mt-2 text-xs">Created: {formatDate(spuItem.createdAt)}</div>
						</TronCard>
					</a>
				{/each}
			</div>
		{/if}
	{/if}
</div>

<!-- Create SPU Modal -->
{#if showCreateModal}
	<div class="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4">
		<div class="w-full max-w-md">
			<TronCard>
				<div class="mb-6 flex items-center justify-between">
					<h3 class="tron-text-primary text-xl font-bold">Create New SPU</h3>
					<button type="button" class="tron-text-muted hover:tron-text-primary" onclick={() => (showCreateModal = false)} aria-label="Close modal">
						<svg class="h-6 w-6" fill="none" viewBox="0 0 24 24" stroke="currentColor">
							<path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M6 18L18 6M6 6l12 12" />
						</svg>
					</button>
				</div>

				<form
					method="POST"
					action="?/create"
					use:enhance={() => {
						creating = true;
						return async ({ result, update }) => {
							creating = false;
							await update();
							if (result.type === 'success') showCreateModal = false;
						};
					}}
					class="space-y-4"
				>
					<div>
						<label for="serialNumber" class="tron-label">Serial Number</label>
						<input id="serialNumber" name="serialNumber" type="text" class="tron-input" placeholder="Enter serial number" required disabled={creating} />
						<p class="tron-text-muted mt-1 text-xs">This will be used to generate the UDI (SPU-&lt;serial&gt;)</p>
					</div>

					<div>
						<label for="batchId" class="tron-label">Batch (Optional)</label>
						<select id="batchId" name="batchId" class="tron-select" disabled={creating}>
							<option value="">No batch</option>
							{#each data.batches as batch (batch.id)}
								<option value={batch.id}>{batch.batchNumber}</option>
							{/each}
						</select>
					</div>

					{#if form?.error}
						<div class="rounded border border-[var(--color-tron-red)] bg-[rgba(255,51,102,0.1)] p-3">
							<p class="text-sm text-[var(--color-tron-red)]">{form.error}</p>
						</div>
					{/if}

					<div class="flex gap-3 pt-2">
						<TronButton type="button" class="flex-1" onclick={() => (showCreateModal = false)} disabled={creating}>Cancel</TronButton>
						<TronButton type="submit" variant="primary" class="flex-1" disabled={creating}>
							{creating ? 'Creating...' : 'Create SPU'}
						</TronButton>
					</div>
				</form>
			</TronCard>
		</div>
	</div>
{/if}
