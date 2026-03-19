<script lang="ts">
	import { enhance } from '$app/forms';
	import ScanInput from '$lib/components/assembly/ScanInput.svelte';

	let { data, form } = $props();

	let barcodeValue = $state('');
	let formElement: HTMLFormElement | undefined = $state();

	function handleScan(value: string) {
		barcodeValue = value;
		// Submit the form after setting the value
		setTimeout(() => formElement?.requestSubmit(), 0);
	}

	const statusColors: Record<string, string> = {
		open: 'var(--color-tron-cyan)',
		in_progress: 'var(--color-tron-blue)',
		pending_parts: 'var(--color-tron-orange)',
		resolved: 'var(--color-tron-green)',
		closed: 'var(--color-tron-text-secondary)'
	};
</script>

<svelte:head>
	<title>SPU Servicing</title>
</svelte:head>

<div class="space-y-6 p-6">
	<div class="flex items-center justify-between">
		<h1 class="text-2xl font-bold text-[var(--color-tron-text)]">SPU Servicing</h1>
		<a href="/spu" class="tron-btn tron-btn-ghost text-sm">Back to SPUs</a>
	</div>

	<!-- Scan Entry -->
	<div class="rounded-lg border border-[var(--color-tron-border)] bg-[var(--color-tron-bg-secondary)] p-6">
		<h2 class="mb-4 text-lg font-semibold text-[var(--color-tron-text)]">Scan SPU to Begin Servicing</h2>
		<form bind:this={formElement} method="POST" action="?/scan" use:enhance>
			<input type="hidden" name="barcode" value={barcodeValue} />
			<ScanInput
				label="Scan SPU Barcode"
				placeholder="Scan or enter SPU barcode/UDI..."
				onScan={handleScan}
			/>
		</form>
		{#if form?.error}
			<p class="mt-3 text-sm text-[var(--color-tron-red)]">{form.error}</p>
		{/if}
	</div>

	<!-- Active Tickets -->
	<div class="rounded-lg border border-[var(--color-tron-border)] bg-[var(--color-tron-bg-secondary)] p-6">
		<h2 class="mb-4 text-lg font-semibold text-[var(--color-tron-text)]">
			Active Service Tickets ({data.tickets.length})
		</h2>

		{#if data.tickets.length === 0}
			<p class="text-sm text-[var(--color-tron-text-secondary)]">No active service tickets.</p>
		{:else}
			<div class="overflow-x-auto">
				<table class="tron-table w-full">
					<thead>
						<tr>
							<th class="tron-th">SPU UDI</th>
							<th class="tron-th">Status</th>
							<th class="tron-th">Priority</th>
							<th class="tron-th">Opened By</th>
							<th class="tron-th">Opened</th>
							<th class="tron-th">Work Items</th>
						</tr>
					</thead>
					<tbody>
						{#each data.tickets as ticket}
							<tr
								class="tron-tr cursor-pointer hover:bg-[var(--color-tron-bg-tertiary)]"
								onclick={() => window.location.href = `/spu/servicing/${ticket.id}`}
							>
								<td class="tron-td font-mono text-[var(--color-tron-cyan)]">{ticket.spuUdi}</td>
								<td class="tron-td">
									<span
										class="inline-block rounded px-2 py-0.5 text-xs font-medium"
										style="color: {statusColors[ticket.status] ?? 'var(--color-tron-text)'}; border: 1px solid {statusColors[ticket.status] ?? 'var(--color-tron-border)'};"
									>
										{ticket.status.replace('_', ' ')}
									</span>
								</td>
								<td class="tron-td capitalize">{ticket.priority}</td>
								<td class="tron-td">{ticket.openedBy}</td>
								<td class="tron-td text-sm text-[var(--color-tron-text-secondary)]">
									{new Date(ticket.openedAt).toLocaleDateString()}
								</td>
								<td class="tron-td text-sm">
									{ticket.partsCount + ticket.firmwareCount + ticket.otherCount}
								</td>
							</tr>
						{/each}
					</tbody>
				</table>
			</div>
		{/if}
	</div>
</div>
