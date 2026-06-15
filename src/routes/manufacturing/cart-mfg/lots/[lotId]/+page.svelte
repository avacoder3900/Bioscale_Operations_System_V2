<script lang="ts">
	import { resolve } from '$app/paths';

	interface Props {
		data: {
			lot: {
				lotId: string;
				bucketBarcode: string | null;
				outputLotNumber: string | null;
				configId: string;
				qrCodeRef: string;
				quantityProduced: number;
				status: string | null;
				startTime: string | null;
				finishTime: string | null;
				cycleTime: number | null;
				createdAt: string;
				oven: string | null;
				inputLots: { materialName: string; barcode: string }[];
			} | null;
			cartridges: {
				barcode: string;
				status: string;
				scannedAt: string | null;
				scannedBy: string;
				oven: string;
			}[];
			batchNotes: {
				id: string;
				note: string | null;
				imageUrl: string | null;
				operatorName: string;
				createdAt: string;
			}[];
		};
	}

	let { data }: Props = $props();
</script>

<div class="space-y-6">
	<a
		href={resolve('/manufacturing')}
		class="text-sm text-[var(--color-tron-cyan)] hover:underline"
	>
		&larr; Back to Manufacturing
	</a>

	{#if !data.lot}
		<p class="text-lg font-semibold text-[var(--color-tron-error)]">Lot not found.</p>
	{:else}
		<h1 class="text-2xl font-semibold text-[var(--color-tron-text)]">
			Backing lot {data.lot.outputLotNumber ?? data.lot.bucketBarcode ?? data.lot.lotId}
		</h1>

		{#if data.lot.bucketBarcode}
			<div class="rounded-lg border border-[var(--color-tron-cyan)]/40 bg-[var(--color-tron-bg-secondary)] p-4">
				<div class="text-xs text-[var(--color-tron-text-secondary)]">Bucket Barcode (scan / copy)</div>
				<div class="mt-1 select-all font-mono text-2xl font-bold text-[var(--color-tron-cyan)]">{data.lot.bucketBarcode}</div>
			</div>
		{/if}

		<div class="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
			<div class="rounded-lg border border-[var(--color-tron-border)] bg-[var(--color-tron-bg-secondary)] p-4">
				<div class="text-xs text-[var(--color-tron-text-secondary)]">Config</div>
				<div class="mt-1 text-lg font-semibold text-[var(--color-tron-text)]">{data.lot.configId}</div>
			</div>
			<div class="rounded-lg border border-[var(--color-tron-border)] bg-[var(--color-tron-bg-secondary)] p-4">
				<div class="text-xs text-[var(--color-tron-text-secondary)]">QR Code</div>
				<div class="mt-1 text-lg font-semibold text-[var(--color-tron-text)]">{data.lot.qrCodeRef}</div>
			</div>
			<div class="rounded-lg border border-[var(--color-tron-border)] bg-[var(--color-tron-bg-secondary)] p-4">
				<div class="text-xs text-[var(--color-tron-text-secondary)]">Quantity</div>
				<div class="mt-1 text-lg font-semibold text-[var(--color-tron-text)]">{data.lot.quantityProduced}</div>
			</div>
			<div class="rounded-lg border border-[var(--color-tron-border)] bg-[var(--color-tron-bg-secondary)] p-4">
				<div class="text-xs text-[var(--color-tron-text-secondary)]">Status</div>
				<div class="mt-1 text-lg font-semibold text-[var(--color-tron-text)]">{data.lot.status ?? 'Unknown'}</div>
			</div>
		</div>

		<div class="rounded-lg border border-[var(--color-tron-border)] bg-[var(--color-tron-bg-secondary)] p-4">
			<h2 class="text-sm font-medium text-[var(--color-tron-text)]">Details</h2>
			<div class="mt-3 space-y-2 text-sm text-[var(--color-tron-text-secondary)]">
				<p>Created: {new Date(data.lot.createdAt).toLocaleString()}</p>
				{#if data.lot.startTime}
					<p>Started: {new Date(data.lot.startTime).toLocaleString()}</p>
				{/if}
				{#if data.lot.finishTime}
					<p>Finished: {new Date(data.lot.finishTime).toLocaleString()}</p>
				{/if}
				{#if data.lot.cycleTime}
					<p>Cycle Time: {data.lot.cycleTime}s</p>
				{/if}
			</div>
		</div>

		{#if data.lot.inputLots.length > 0 || data.lot.oven}
			<div class="rounded-lg border border-[var(--color-tron-border)] bg-[var(--color-tron-bg-secondary)] p-4">
				<h2 class="text-sm font-medium text-[var(--color-tron-text)]">Materials &amp; oven</h2>
				<div class="mt-3 grid gap-2 text-sm sm:grid-cols-2">
					{#each data.lot.inputLots as m (m.materialName)}
						<div class="flex justify-between rounded border border-[var(--color-tron-border)] bg-[var(--color-tron-bg-primary)] px-3 py-2">
							<span class="text-[var(--color-tron-text-secondary)]">{m.materialName}</span>
							<span class="font-mono text-[var(--color-tron-text)]">{m.barcode}</span>
						</div>
					{/each}
					{#if data.lot.oven}
						<div class="flex justify-between rounded border border-[var(--color-tron-border)] bg-[var(--color-tron-bg-primary)] px-3 py-2">
							<span class="text-[var(--color-tron-text-secondary)]">Oven</span>
							<span class="font-mono text-[var(--color-tron-text)]">{data.lot.oven}</span>
						</div>
					{/if}
				</div>
			</div>
		{/if}

		{#if data.cartridges.length > 0}
			<div class="rounded-lg border border-[var(--color-tron-border)] bg-[var(--color-tron-bg-secondary)] p-4">
				<h2 class="text-sm font-medium text-[var(--color-tron-text)]">Cartridges in this batch ({data.cartridges.length})</h2>
				<div class="mt-3 overflow-x-auto">
					<table class="w-full text-left text-sm">
						<thead>
							<tr class="border-b border-[var(--color-tron-border)] text-[var(--color-tron-text-secondary)]">
								<th class="px-3 py-2">Cartridge</th>
								<th class="px-3 py-2">Scanned</th>
								<th class="px-3 py-2">By</th>
								<th class="px-3 py-2">Oven</th>
								<th class="px-3 py-2">Status</th>
							</tr>
						</thead>
						<tbody>
							{#each data.cartridges as c (c.barcode)}
								<tr class="border-b border-[var(--color-tron-border)]">
									<td class="px-3 py-2 font-mono text-xs text-[var(--color-tron-text)]">{c.barcode}</td>
									<td class="px-3 py-2 text-[var(--color-tron-text-secondary)]">{c.scannedAt ? new Date(c.scannedAt).toLocaleString() : '—'}</td>
									<td class="px-3 py-2 text-[var(--color-tron-text)]">{c.scannedBy}</td>
									<td class="px-3 py-2 text-[var(--color-tron-text-secondary)]">{c.oven}</td>
									<td class="px-3 py-2 text-[var(--color-tron-text)]">{c.status}</td>
								</tr>
							{/each}
						</tbody>
					</table>
				</div>
			</div>
		{/if}

		{#if data.batchNotes.length > 0}
			<div class="rounded-lg border border-[var(--color-tron-border)] bg-[var(--color-tron-bg-secondary)] p-4">
				<h2 class="text-sm font-medium text-[var(--color-tron-text)]">Batch Notes</h2>
				<div class="mt-3 space-y-2">
					{#each data.batchNotes as note (note.id)}
						<div class="rounded border border-[var(--color-tron-border)] bg-[var(--color-tron-bg-primary)] p-2">
							{#if note.note}
								<p class="text-sm text-[var(--color-tron-text)]">"{note.note}"</p>
							{/if}
							{#if note.imageUrl}
								<img src={note.imageUrl} alt="Batch photo" class="mt-1 max-h-32 rounded border border-[var(--color-tron-border)]" />
							{/if}
							<p class="mt-1 text-xs text-[var(--color-tron-text-secondary)]">
								{note.operatorName} &mdash; {new Date(note.createdAt).toLocaleString()}
							</p>
						</div>
					{/each}
				</div>
			</div>
		{/if}
	{/if}
</div>
