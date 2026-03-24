<script lang="ts">
	interface Material {
		materialId: string;
		name: string;
		unit: string;
		currentQuantity: number;
		updatedAt: string;
	}

	interface Props {
		data: {
			materials: Material[];
			derived: {
				individualBacks: number;
				cartridgesPerSheet: number;
			};
		};
	}

	let { data }: Props = $props();
</script>

<div class="space-y-6">
	<h1 class="text-2xl font-semibold text-[var(--color-tron-text)]">Material Inventory</h1>

	<!-- Summary Cards -->
	<div class="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4">
		{#each data.materials as mat (mat.materialId)}
			<div class="rounded-lg border border-[var(--color-tron-border)] bg-[var(--color-tron-surface)] p-4">
				<p class="text-xs font-medium text-[var(--color-tron-text-secondary)]">{mat.name}</p>
				<p class="mt-1 text-2xl font-bold text-[var(--color-tron-text)]">
					{mat.currentQuantity}
					<span class="text-sm font-normal text-[var(--color-tron-text-secondary)]">{mat.unit}</span>
				</p>
			</div>
		{/each}
		<!-- Derived: Individual Backs -->
		<div class="rounded-lg border border-[var(--color-tron-cyan)]/30 bg-[var(--color-tron-cyan)]/5 p-4">
			<p class="text-xs font-medium text-[var(--color-tron-cyan)]/70">Individual Backs Available</p>
			<p class="mt-1 text-2xl font-bold text-[var(--color-tron-cyan)]">
				{data.derived.individualBacks}
				<span class="text-sm font-normal text-[var(--color-tron-cyan)]/70">pcs</span>
			</p>
			<p class="mt-1 text-xs text-[var(--color-tron-text-secondary)]">
				(sheets &times; {data.derived.cartridgesPerSheet})
			</p>
		</div>
	</div>

	<!-- Detail Table -->
	<section>
		<h2 class="mb-3 text-lg font-medium text-[var(--color-tron-cyan)]">All Materials</h2>
		<div class="overflow-x-auto">
			<table class="tron-table w-full text-sm">
				<thead>
					<tr>
						<th>Material</th>
						<th>Quantity</th>
						<th>Unit</th>
						<th>Last Updated</th>
					</tr>
				</thead>
				<tbody>
					{#each data.materials as mat (mat.materialId)}
						<tr>
							<td class="text-[var(--color-tron-text)]">{mat.name}</td>
							<td class="font-mono text-[var(--color-tron-cyan)]">{mat.currentQuantity}</td>
							<td class="text-[var(--color-tron-text-secondary)]">{mat.unit}</td>
							<td class="whitespace-nowrap text-[var(--color-tron-text-secondary)]">{new Date(mat.updatedAt).toLocaleString()}</td>
						</tr>
					{/each}
					<tr class="border-t-2 border-[var(--color-tron-cyan)]/30">
						<td class="text-[var(--color-tron-cyan)]">Individual Backs Available (derived)</td>
						<td class="font-mono text-[var(--color-tron-cyan)]">{data.derived.individualBacks}</td>
						<td class="text-[var(--color-tron-text-secondary)]">pcs</td>
						<td class="text-xs text-[var(--color-tron-text-secondary)]">sheets &times; {data.derived.cartridgesPerSheet}</td>
					</tr>
				</tbody>
			</table>
		</div>
	</section>
</div>
