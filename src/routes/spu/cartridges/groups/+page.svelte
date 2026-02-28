<script lang="ts">
	import { enhance } from '$app/forms';

	let { data } = $props();

	let showCreateModal = $state(false);
	let selectedColor = $state('#00ffff');

	const COLORS = [
		{ label: 'Cyan', value: '#00ffff' },
		{ label: 'Green', value: '#39ff14' },
		{ label: 'Yellow', value: '#fbbf24' },
		{ label: 'Orange', value: '#f97316' },
		{ label: 'Red', value: '#ef4444' },
		{ label: 'Purple', value: '#a855f7' },
		{ label: 'Blue', value: '#3b82f6' },
		{ label: 'White', value: '#e2e8f0' }
	];
</script>

<div class="mx-auto max-w-4xl space-y-6 p-4">
	<div class="flex items-center justify-between">
		<div>
			<a
				href="/spu/cartridges"
				class="text-sm"
				style="color: var(--color-tron-text-secondary, #9ca3af)"
			>
				&larr; Back to Cartridges
			</a>
			<h1
				class="mt-1 text-2xl font-bold"
				style="color: var(--color-tron-cyan, #00ffff)"
			>
				Cartridge Groups
			</h1>
		</div>
		<button
			class="tron-button"
			style="min-height: 44px; background: var(--color-tron-cyan, #00ffff); color: #000"
			onclick={() => (showCreateModal = true)}
		>
			+ Create Group
		</button>
	</div>

	{#if data.groups.length === 0}
		<div class="tron-card p-8 text-center">
			<p style="color: var(--color-tron-text-secondary)">No groups yet. Create one to organize cartridges.</p>
		</div>
	{:else}
		<table class="tron-table w-full">
			<thead>
				<tr>
					<th>Color</th>
					<th>Name</th>
					<th>Description</th>
					<th>Cartridges</th>
					<th>Actions</th>
				</tr>
			</thead>
			<tbody>
				{#each data.groups as g (g.id)}
					<tr>
						<td>
							<span
								class="inline-block h-4 w-4 rounded-full"
								style="background: {g.color ?? '#6b7280'}"
							></span>
						</td>
						<td style="font-weight: 600">{g.name}</td>
						<td style="color: var(--color-tron-text-secondary)">{g.description ?? '—'}</td>
						<td>{g.cartridgeCount}</td>
						<td>
							<form method="POST" action="?/deleteGroup" use:enhance class="inline">
								<input type="hidden" name="id" value={g.id} />
								<button
									type="submit"
									class="tron-button text-xs"
									style="min-height: 36px; opacity: {g.cartridgeCount > 0 ? '0.3' : '1'}"
									disabled={g.cartridgeCount > 0}
									title={g.cartridgeCount > 0 ? 'Remove all cartridges from this group first' : 'Delete group'}
								>
									Delete
								</button>
							</form>
						</td>
					</tr>
				{/each}
			</tbody>
		</table>
	{/if}
</div>

<!-- Create Modal -->
{#if showCreateModal}
	<div
		class="fixed inset-0 z-50 flex items-center justify-center bg-black/70"
		role="dialog"
		onclick={() => (showCreateModal = false)}
		onkeydown={(e) => e.key === 'Escape' && (showCreateModal = false)}
	>
		<div class="tron-card w-full max-w-md p-6" onclick={(e) => e.stopPropagation()} role="document">
			<h2 class="mb-4 text-lg font-bold" style="color: var(--color-tron-cyan, #00ffff)">
				Create Group
			</h2>
			<form
				method="POST"
				action="?/createGroup"
				use:enhance={() => {
					return async ({ result, update }) => {
						if (result.type === 'success') showCreateModal = false;
						await update();
					};
				}}
				class="space-y-4"
			>
				<input
					name="name"
					type="text"
					class="tron-input w-full"
					style="min-height: 44px"
					placeholder="Group Name *"
					required
				/>
				<input
					name="description"
					type="text"
					class="tron-input w-full"
					style="min-height: 44px"
					placeholder="Description"
				/>
				<input type="hidden" name="color" value={selectedColor} />
				<div>
					<span class="mb-2 block text-sm" style="color: var(--color-tron-text-secondary)">
						Color
					</span>
					<div class="flex flex-wrap gap-2">
						{#each COLORS as c (c.value)}
							<button
								type="button"
								class="h-8 w-8 rounded-full border-2"
								style="background: {c.value}; border-color: {selectedColor === c.value ? '#fff' : 'transparent'}"
								onclick={() => (selectedColor = c.value)}
								title={c.label}
							></button>
						{/each}
					</div>
				</div>
				<div class="flex justify-end gap-2">
					<button
						type="button"
						class="tron-button"
						style="min-height: 44px"
						onclick={() => (showCreateModal = false)}
					>
						Cancel
					</button>
					<button
						type="submit"
						class="tron-button"
						style="min-height: 44px; background: var(--color-tron-cyan, #00ffff); color: #000"
					>
						Create
					</button>
				</div>
			</form>
		</div>
	</div>
{/if}
