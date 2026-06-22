<script lang="ts">
	import { enhance } from '$app/forms';

	interface Props {
		data: {
			assays: Array<{ id: string; name: string; skuCode: string; duration: number | null; bcodeSteps: number }>;
			cartridges: Array<{
				id: string; serialNumber: string; assayName: string | null;
				status: string; ran: boolean;
				assignedAt: string | null; underwayAt: string | null; completedAt: string | null;
				result: { profileName: string | null; computedAt: string | null } | null;
			}>;
		};
		form: {
			success?: boolean; error?: string;
			createdCount?: number; skipped?: Array<{ barcode: string; reason: string }>;
			bcodeSteps?: number; assayName?: string;
		} | null;
	}

	let { data, form }: Props = $props();

	// Single optical assay — preselected, not user-changeable.
	const assay = $derived(data.assays[0] ?? null);

	let count = $state(1);
	let barcodes = $state('');
	let groupName = $state('');
	let isSubmitting = $state(false);

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
			case 'completed': return 'bg-[var(--color-tron-green)]/15 text-[var(--color-tron-green)]';
			case 'underway': return 'bg-[var(--color-tron-cyan)]/15 text-[var(--color-tron-cyan)]';
			case 'failed': case 'wax_rejected': return 'bg-[var(--color-tron-red)]/15 text-[var(--color-tron-red)]';
			case 'linked': return 'bg-[var(--color-tron-orange)]/15 text-[var(--color-tron-orange)]';
			default: return 'bg-[var(--color-tron-text-secondary)]/15 text-[var(--color-tron-text-secondary)]';
		}
	}

	const ranCount = $derived(data.cartridges.filter((c) => c.ran).length);
</script>

<div class="space-y-6">
	<!-- Header -->
	<div>
		<h1 class="tron-heading text-2xl font-bold">Optical Confirmation — Assign Validation Cartridges</h1>
		<p class="tron-text-muted mt-1">
			Assign the optical-confirmation assay to a cartridge. The assay's runnable program is
			embedded onto the cartridge so the device can run it on scan.
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
			<!-- Fixed assay (only one in use) -->
			<input type="hidden" name="assayId" value={assay?.id ?? ''} />
			<div>
				<div class="tron-text-muted mb-2 block text-sm font-medium">Assay</div>
				{#if assay}
					<div class="rounded-lg border border-[var(--color-tron-border)] bg-[var(--color-tron-bg-tertiary)] px-4 py-3">
						<div class="tron-text-primary font-medium">{assay.name}</div>
						<div class="mt-1 flex flex-wrap gap-4 text-xs text-[var(--color-tron-text-secondary)]">
							<span>Assay ID: <span class="tron-text-primary">{assay.id}</span></span>
							<span>BCODE steps: <span class="tron-text-primary">{assay.bcodeSteps}</span></span>
							<span>Duration: <span class="tron-text-primary">{fmtDuration(assay.duration)}</span></span>
						</div>
					</div>
				{:else}
					<div class="rounded-lg bg-[var(--color-tron-red)]/10 p-3 text-sm text-[var(--color-tron-red)]">
						Optical assay not found.
					</div>
				{/if}
			</div>

			<!-- Barcode + qty + group, all on one page -->
			<div class="grid gap-6 md:grid-cols-2">
				<div class="md:col-span-2">
					<label for="barcodes" class="tron-text-muted mb-2 block text-sm font-medium">
						Scan / paste barcode(s)
					</label>
					<textarea id="barcodes" name="barcodes" bind:value={barcodes} rows="3"
						placeholder="Scan or paste one barcode per line (or comma-separated). Leave blank to generate by quantity."
						class="tron-input w-full rounded-lg px-4 py-3 font-mono text-sm"></textarea>
				</div>

				<div>
					<label for="count" class="tron-text-muted mb-2 block text-sm font-medium">Quantity</label>
					<input id="count" name="count" type="number" min="1" max="200" bind:value={count}
						class="tron-input w-full rounded-lg px-4 py-3" />
					<p class="tron-text-muted mt-1 text-xs">Used only when no barcodes are scanned.</p>
				</div>

				<div>
					<label for="groupName" class="tron-text-muted mb-2 block text-sm font-medium">Group (optional)</label>
					<input id="groupName" name="groupName" type="text" bind:value={groupName}
						placeholder="e.g. group a" class="tron-input w-full rounded-lg px-4 py-3" />
				</div>
			</div>

			{#if form?.success}
				<div class="rounded-lg bg-[var(--color-tron-green)]/10 p-4 text-sm text-[var(--color-tron-green)]">
					Assigned <span class="font-semibold">{form.createdCount}</span> cartridge(s) of
					<span class="font-semibold">{form.assayName}</span> — {form.bcodeSteps} BCODE steps embedded onto each.
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

			<button type="submit" disabled={!assay || isSubmitting}
				class="w-full rounded-lg bg-[var(--color-tron-cyan)] px-6 py-4 text-lg font-semibold text-[var(--color-tron-bg-primary)] transition-all hover:bg-[var(--color-tron-cyan)]/90 disabled:cursor-not-allowed disabled:opacity-50">
				{isSubmitting ? 'Assigning…' : 'Assign validation cartridges'}
			</button>
		</form>
	</div>

	<!-- Optical test cartridge log -->
	<div class="tron-card">
		<div class="flex items-center justify-between border-b border-[var(--color-tron-border)] p-4">
			<h2 class="tron-heading text-lg font-semibold">Optical Test Cartridge Log ({data.cartridges.length})</h2>
			<span class="text-sm text-[var(--color-tron-text-secondary)]">{ranCount} run</span>
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
							<th class="p-3 font-medium">Serial</th>
							<th class="p-3 font-medium">Assay</th>
							<th class="p-3 font-medium">Status</th>
							<th class="p-3 font-medium">Result</th>
							<th class="p-3 font-medium">Assigned</th>
							<th class="p-3 font-medium">Completed</th>
						</tr>
					</thead>
					<tbody class="divide-y divide-[var(--color-tron-border)]">
						{#each data.cartridges as c (c.id)}
							<tr>
								<td class="p-3 font-mono text-xs text-[var(--color-tron-text-primary)]">{c.serialNumber}</td>
								<td class="p-3">{c.assayName ?? '—'}</td>
								<td class="p-3">
									<span class="rounded-full px-2 py-1 text-xs font-medium {statusClass(c.status)}">{c.status}</span>
								</td>
								<td class="p-3 text-[var(--color-tron-text-secondary)]">
									{#if c.result}
										{c.result.profileName ?? 'analyzed'}
									{:else if c.ran}
										ran
									{:else}
										—
									{/if}
								</td>
								<td class="p-3 text-xs text-[var(--color-tron-text-secondary)]">{fmtDate(c.assignedAt)}</td>
								<td class="p-3 text-xs text-[var(--color-tron-text-secondary)]">{fmtDate(c.completedAt)}</td>
							</tr>
						{/each}
					</tbody>
				</table>
			</div>
		{/if}
	</div>
</div>
