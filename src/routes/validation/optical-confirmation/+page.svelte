<script lang="ts">
	import { enhance } from '$app/forms';

	interface Props {
		data: {
			assays: Array<{ id: string; name: string; skuCode: string; duration: number | null; bcodeSteps: number }>;
			cartridges: Array<{
				id: string; barcode: string; serialNumber: string;
				assayId: string | null; assayName: string | null; status: string;
				groupId: string | null; bcodeSteps: number; duration: number | null; createdAt: string | null;
			}>;
		};
		form: {
			success?: boolean; error?: string;
			createdCount?: number; skipped?: Array<{ barcode: string; reason: string }>;
			bcodeSteps?: number; assayName?: string;
		} | null;
	}

	let { data, form }: Props = $props();

	let selectedAssayId = $state('');
	let mode = $state<'count' | 'barcodes'>('count');
	let count = $state(1);
	let barcodes = $state('');
	let groupName = $state('');
	let isSubmitting = $state(false);

	let selectedAssay = $derived(data.assays.find((a) => a.id === selectedAssayId) ?? null);

	function fmtDuration(sec: number | null): string {
		if (sec == null) return '—';
		const m = Math.floor(sec / 60);
		const s = sec % 60;
		return m > 0 ? `${m}m ${s}s` : `${s}s`;
	}
	function fmtDate(d: string | null): string {
		return d ? new Date(d).toLocaleString() : '—';
	}
	function statusClass(status: string): string {
		switch (status) {
			case 'available': return 'bg-[var(--color-tron-green)]/15 text-[var(--color-tron-green)]';
			case 'in_use': return 'bg-[var(--color-tron-cyan)]/15 text-[var(--color-tron-cyan)]';
			case 'depleted': return 'bg-[var(--color-tron-text-secondary)]/15 text-[var(--color-tron-text-secondary)]';
			default: return 'bg-[var(--color-tron-orange)]/15 text-[var(--color-tron-orange)]';
		}
	}
</script>

<div class="space-y-6">
	<!-- Header -->
	<div>
		<h1 class="tron-heading text-2xl font-bold">Optical Confirmation — Assign Validation Cartridges</h1>
		<p class="tron-text-muted mt-1">
			Assign a known-good assay as an optical-confirmation validation cartridge. The assay's
			runnable program (BCODE) is snapshotted onto each cartridge, so the cartridge document is
			a complete, frozen, runnable record.
		</p>
	</div>

	<!-- Assign form -->
	<div class="tron-card p-6">
		<h2 class="tron-heading mb-4 text-lg font-semibold">Assign Cartridges</h2>

		<form
			method="POST"
			action="?/assign"
			use:enhance={() => {
				isSubmitting = true;
				return async ({ update }) => { await update({ reset: false }); isSubmitting = false; };
			}}
			class="space-y-6"
		>
			<!-- Assay picker -->
			<div>
				<label for="assayId" class="tron-text-muted mb-2 block text-sm font-medium">Assay</label>
				<select
					id="assayId"
					name="assayId"
					bind:value={selectedAssayId}
					class="tron-input w-full rounded-lg px-4 py-3"
				>
					<option value="" disabled>Select an assay with a runnable program…</option>
					{#each data.assays as a (a.id)}
						<option value={a.id}>{a.name} · {a.skuCode} · {a.bcodeSteps} steps</option>
					{/each}
				</select>
				{#if selectedAssay}
					<div class="mt-2 flex flex-wrap gap-4 text-xs text-[var(--color-tron-text-secondary)]">
						<span>Assay ID: <span class="tron-text-primary">{selectedAssay.id}</span></span>
						<span>BCODE steps: <span class="tron-text-primary">{selectedAssay.bcodeSteps}</span></span>
						<span>Duration: <span class="tron-text-primary">{fmtDuration(selectedAssay.duration)}</span></span>
					</div>
				{/if}
			</div>

			<!-- Mode toggle -->
			<div class="flex gap-2">
				<button
					type="button"
					onclick={() => (mode = 'count')}
					class="rounded-lg px-4 py-2 text-sm font-medium transition-colors
						{mode === 'count'
							? 'bg-[var(--color-tron-cyan)] text-[var(--color-tron-bg-primary)]'
							: 'bg-[var(--color-tron-bg-tertiary)] text-[var(--color-tron-text-secondary)]'}"
				>
					Generate by count
				</button>
				<button
					type="button"
					onclick={() => (mode = 'barcodes')}
					class="rounded-lg px-4 py-2 text-sm font-medium transition-colors
						{mode === 'barcodes'
							? 'bg-[var(--color-tron-cyan)] text-[var(--color-tron-bg-primary)]'
							: 'bg-[var(--color-tron-bg-tertiary)] text-[var(--color-tron-text-secondary)]'}"
				>
					Scan / paste barcodes
				</button>
			</div>

			<div class="grid gap-6 md:grid-cols-2">
				{#if mode === 'count'}
					<div>
						<label for="count" class="tron-text-muted mb-2 block text-sm font-medium">How many</label>
						<input id="count" name="count" type="number" min="1" max="200" bind:value={count}
							class="tron-input w-full rounded-lg px-4 py-3" />
						<p class="tron-text-muted mt-1 text-xs">Barcodes generated as OPT-&lt;assayId&gt;-NNN.</p>
					</div>
				{:else}
					<div class="md:col-span-2">
						<label for="barcodes" class="tron-text-muted mb-2 block text-sm font-medium">Barcodes</label>
						<textarea id="barcodes" name="barcodes" bind:value={barcodes} rows="4"
							placeholder="Scan or paste one barcode per line (or comma-separated)"
							class="tron-input w-full rounded-lg px-4 py-3 font-mono text-sm"></textarea>
					</div>
				{/if}

				<div>
					<label for="groupName" class="tron-text-muted mb-2 block text-sm font-medium">Group (optional)</label>
					<input id="groupName" name="groupName" type="text" bind:value={groupName}
						placeholder="e.g. group a" class="tron-input w-full rounded-lg px-4 py-3" />
				</div>
			</div>

			{#if form?.success}
				<div class="rounded-lg bg-[var(--color-tron-green)]/10 p-4 text-sm text-[var(--color-tron-green)]">
					Assigned <span class="font-semibold">{form.createdCount}</span> cartridge(s) of
					<span class="font-semibold">{form.assayName}</span> — {form.bcodeSteps} BCODE steps snapshotted onto each.
					{#if form.skipped && form.skipped.length > 0}
						<div class="mt-1 text-[var(--color-tron-orange)]">
							Skipped {form.skipped.length}: {form.skipped.map((s) => `${s.barcode} (${s.reason})`).join('; ')}
						</div>
					{/if}
				</div>
			{/if}
			{#if form?.error}
				<div class="rounded-lg bg-[var(--color-tron-red)]/10 p-4 text-sm text-[var(--color-tron-red)]">{form.error}</div>
			{/if}

			<button type="submit" disabled={!selectedAssayId || isSubmitting}
				class="w-full rounded-lg bg-[var(--color-tron-cyan)] px-6 py-4 text-lg font-semibold text-[var(--color-tron-bg-primary)] transition-all hover:bg-[var(--color-tron-cyan)]/90 disabled:cursor-not-allowed disabled:opacity-50">
				{isSubmitting ? 'Assigning…' : 'Assign validation cartridges'}
			</button>
		</form>
	</div>

	<!-- Existing cartridges -->
	<div class="tron-card">
		<div class="border-b border-[var(--color-tron-border)] p-4">
			<h2 class="tron-heading text-lg font-semibold">Optical Test Cartridges ({data.cartridges.length})</h2>
		</div>
		{#if data.cartridges.length === 0}
			<div class="p-8 text-center">
				<p class="tron-text-muted">No optical test cartridges assigned yet.</p>
			</div>
		{:else}
			<div class="overflow-x-auto">
				<table class="w-full text-sm">
					<thead class="text-left text-[var(--color-tron-text-secondary)]">
						<tr class="border-b border-[var(--color-tron-border)]">
							<th class="p-3 font-medium">Barcode / Serial</th>
							<th class="p-3 font-medium">Assay</th>
							<th class="p-3 font-medium">Run program</th>
							<th class="p-3 font-medium">Status</th>
							<th class="p-3 font-medium">Assigned</th>
						</tr>
					</thead>
					<tbody class="divide-y divide-[var(--color-tron-border)]">
						{#each data.cartridges as c (c.id)}
							<tr>
								<td class="p-3 font-mono text-xs text-[var(--color-tron-text-primary)]">{c.serialNumber}</td>
								<td class="p-3">{c.assayName ?? c.assayId ?? '—'}</td>
								<td class="p-3 text-[var(--color-tron-text-secondary)]">
									{c.bcodeSteps} steps · {fmtDuration(c.duration)}
								</td>
								<td class="p-3"><span class="rounded-full px-2 py-1 text-xs font-medium {statusClass(c.status)}">{c.status}</span></td>
								<td class="p-3 text-xs text-[var(--color-tron-text-secondary)]">{fmtDate(c.createdAt)}</td>
							</tr>
						{/each}
					</tbody>
				</table>
			</div>
		{/if}
	</div>
</div>
