<script lang="ts">
	import { resolve } from '$app/paths';

	interface Props {
		data: {
			lot: {
				lotId: string;
				configId: string;
				qrCodeRef: string;
				quantityProduced: number;
				status: string | null;
				startTime: string | null;
				finishTime: string | null;
				cycleTime: number | null;
				createdAt: string;
			} | null;
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
		<h1 class="text-2xl font-semibold text-[var(--color-tron-text)]">Lot {data.lot.lotId}</h1>

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
