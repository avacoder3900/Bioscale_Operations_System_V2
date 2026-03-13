<script lang="ts">
	interface Tool {
		tool_id: string;
		name: string;
	}

	interface Props {
		tools: Tool[];
		onconfirm: () => void;
	}

	let { tools, onconfirm }: Props = $props();

	let checked = $state<Record<string, boolean>>({});
	const allChecked = $derived(tools.length > 0 && tools.every((t) => checked[t.tool_id]));
</script>

<div class="tron-card space-y-4 p-4">
	<div>
		<h2 class="tron-text text-sm font-semibold tracking-wider uppercase">
			Required Tools & Equipment
		</h2>
		<p class="tron-text-muted mt-1 text-sm">
			Confirm all required tools are ready before beginning inspection.
		</p>
	</div>

	{#if tools.length === 0}
		<p class="tron-text-muted text-sm italic">No tools specified in form definition.</p>
	{:else}
		<div class="space-y-2">
			{#each tools as tool (tool.tool_id)}
				<label
					class="flex cursor-pointer items-center gap-3 rounded border p-3 transition hover:bg-white/5 {checked[
						tool.tool_id
					]
						? 'border-[color-mix(in_srgb,var(--color-tron-cyan)_30%,transparent)] bg-[color-mix(in_srgb,var(--color-tron-cyan)_5%,transparent)]'
						: 'border-transparent hover:border-[var(--color-tron-border)]'}"
				>
					<input
						type="checkbox"
						bind:checked={checked[tool.tool_id]}
						class="h-5 w-5 shrink-0 accent-cyan-500"
					/>
					<div>
						<span class="font-mono text-xs text-[var(--color-tron-text-secondary)]"
							>{tool.tool_id}</span
						>
						<span class="tron-text ml-2 text-sm">{tool.name}</span>
					</div>
					{#if checked[tool.tool_id]}
						<span class="ml-auto text-xs text-[var(--color-tron-green)]">Ready</span>
					{/if}
				</label>
			{/each}
		</div>
	{/if}

	<div class="flex items-center justify-between border-t border-[var(--color-tron-border)] pt-4">
		<span class="text-xs text-[var(--color-tron-text-secondary)]">
			{tools.filter((t) => checked[t.tool_id]).length} of {tools.length} tools confirmed
		</span>
		<button
			type="button"
			disabled={!allChecked}
			onclick={onconfirm}
			class="tron-button px-6 py-2 text-sm font-medium disabled:opacity-50"
		>
			All Tools Ready — Begin Inspection
		</button>
	</div>
</div>
