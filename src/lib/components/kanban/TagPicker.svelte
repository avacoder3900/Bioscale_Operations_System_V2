<script lang="ts">
	import { enhance } from '$app/forms';
	import TronButton from '$lib/components/ui/TronButton.svelte';

	interface Tag {
		id: string;
		name: string;
		color: string;
	}

	interface Props {
		allTags: Tag[];
		selectedTagIds: string[];
		taskId: string;
	}

	let { allTags, selectedTagIds, taskId }: Props = $props();
	let showPicker = $state(false);

	function isSelected(tagId: string): boolean {
		return selectedTagIds.includes(tagId);
	}
</script>

<!-- Selected tags display -->
<div class="flex flex-wrap gap-1.5">
	{#each allTags.filter((t) => selectedTagIds.includes(t.id)) as tag (tag.id)}
		<span
			class="inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs font-medium"
			style="background: {tag.color}25; color: {tag.color};"
		>
			{tag.name}
			<form method="POST" action="/kanban/task/{taskId}?/removeTag" use:enhance class="inline">
				<input type="hidden" name="tagId" value={tag.id} />
				<button type="submit" class="ml-0.5 opacity-60 hover:opacity-100" title="Remove tag">
					&times;
				</button>
			</form>
		</span>
	{:else}
		<span class="tron-text-muted text-xs">No tags</span>
	{/each}
	<button
		type="button"
		class="inline-flex h-5 w-5 items-center justify-center rounded-full bg-[var(--color-tron-bg-tertiary)] text-xs text-[var(--color-tron-text-secondary)] hover:text-[var(--color-tron-cyan)]"
		onclick={() => (showPicker = !showPicker)}
		title="Manage tags"
	>
		+
	</button>
</div>

<!-- Tag picker dropdown -->
{#if showPicker}
	<div
		class="mt-2 rounded border border-[var(--color-tron-border)] bg-[var(--color-tron-bg-secondary)] p-3"
	>
		<div class="mb-2 flex items-center justify-between">
			<span class="tron-text-primary text-xs font-bold">Tags</span>
			<button
				type="button"
				class="tron-text-muted text-xs hover:text-[var(--color-tron-cyan)]"
				onclick={() => (showPicker = false)}
			>
				Close
			</button>
		</div>
		{#if allTags.length === 0}
			<p class="tron-text-muted text-xs">No tags created yet.</p>
		{:else}
			<div class="space-y-1.5">
				{#each allTags as tag (tag.id)}
					{@const selected = isSelected(tag.id)}
					{#if selected}
						<form method="POST" action="/kanban/task/{taskId}?/removeTag" use:enhance>
							<input type="hidden" name="tagId" value={tag.id} />
							<button
								type="submit"
								class="flex w-full items-center gap-2 rounded px-2 py-1.5 text-xs transition-colors hover:bg-[var(--color-tron-bg-tertiary)]"
							>
								<span
									class="flex h-4 w-4 items-center justify-center rounded border"
									style="border-color: {tag.color}; background: {tag.color};"
								>
									<svg
										class="h-3 w-3 text-white"
										fill="none"
										viewBox="0 0 24 24"
										stroke="currentColor"
									>
										<path
											stroke-linecap="round"
											stroke-linejoin="round"
											stroke-width="3"
											d="M5 13l4 4L19 7"
										/>
									</svg>
								</span>
								<span style="color: {tag.color};">{tag.name}</span>
							</button>
						</form>
					{:else}
						<form method="POST" action="/kanban/task/{taskId}?/addTag" use:enhance>
							<input type="hidden" name="tagId" value={tag.id} />
							<button
								type="submit"
								class="flex w-full items-center gap-2 rounded px-2 py-1.5 text-xs transition-colors hover:bg-[var(--color-tron-bg-tertiary)]"
							>
								<span class="h-4 w-4 rounded border" style="border-color: {tag.color}40;"></span>
								<span class="tron-text-muted">{tag.name}</span>
							</button>
						</form>
					{/if}
				{/each}
			</div>
		{/if}
	</div>
{/if}
