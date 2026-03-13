<script lang="ts">
	interface PartRequirement {
		partNumber: string;
		partName: string;
		partDefinitionId: string;
		requiredTotal: number;
		availableInventory: number;
		shortfall: number;
		status: 'sufficient' | 'insufficient' | 'no_tracking' | 'unlinked';
	}

	interface Props {
		requirements: PartRequirement[];
		allSufficient: boolean;
	}

	let { requirements, allSufficient }: Props = $props();

	let sufficientCount = $derived(requirements.filter((r) => r.status === 'sufficient').length);
	let unlinkedCount = $derived(requirements.filter((r) => r.status === 'unlinked').length);
</script>

<div class="tron-card inventory-preview">
	<div class="header">
		<h3 class="title">Inventory Check</h3>
		{#if allSufficient}
			<span class="tron-badge tron-badge-success">System Approved</span>
		{:else}
			<span class="tron-badge tron-badge-error">Inventory Insufficient</span>
		{/if}
	</div>

	<p class="summary tron-text-muted">
		{sufficientCount} of {requirements.length} parts have sufficient inventory
	</p>

	{#if unlinkedCount > 0}
		<p class="summary" style="color: var(--color-tron-orange); font-size: 0.875rem; margin: 0;">
			{unlinkedCount} part{unlinkedCount !== 1 ? 's' : ''} not linked to inventory — assign in step config to track
		</p>
	{/if}

	<div class="table-wrap">
		<table class="tron-table">
			<thead>
				<tr>
					<th>Part Number</th>
					<th>Part Name</th>
					<th>Required</th>
					<th>Available</th>
					<th>Status</th>
				</tr>
			</thead>
			<tbody>
				{#each requirements as req, i (req.partDefinitionId || `unlinked-${i}`)}
					<tr class="row-{req.status}">
						<td class="part-number">{req.partNumber}</td>
						<td>{req.partName}</td>
						<td>{req.requiredTotal}</td>
						<td>
							{#if req.status === 'unlinked'}
								&mdash;
							{:else}
								{req.availableInventory}
							{/if}
						</td>
						<td>
							{#if req.status === 'sufficient'}
								OK
							{:else if req.status === 'insufficient'}
								Short {req.shortfall}
							{:else if req.status === 'unlinked'}
								Not linked
							{:else}
								No tracking
							{/if}
						</td>
					</tr>
				{/each}
			</tbody>
		</table>
	</div>
</div>

<style>
	.inventory-preview {
		display: flex;
		flex-direction: column;
		gap: 0.75rem;
	}

	.header {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 0.5rem;
	}

	.title {
		margin: 0;
		font-size: 1rem;
		font-weight: 600;
		color: var(--color-tron-text-primary);
	}

	.summary {
		margin: 0;
		font-size: 0.875rem;
	}

	.table-wrap {
		overflow-x: auto;
	}

	.part-number {
		font-family: monospace;
		color: var(--color-tron-cyan);
	}

	:global(.row-sufficient) td {
		color: var(--color-tron-green);
	}

	:global(.row-insufficient) td {
		color: var(--color-tron-red);
	}

	:global(.row-no_tracking) td {
		color: var(--color-tron-orange);
	}

	:global(.row-unlinked) td {
		color: var(--color-tron-orange);
	}
</style>
