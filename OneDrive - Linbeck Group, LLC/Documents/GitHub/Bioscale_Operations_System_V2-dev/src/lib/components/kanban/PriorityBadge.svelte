<script lang="ts">
	interface Props {
		prioritized: boolean;
		class?: string;
	}

	let { prioritized, class: className = '' }: Props = $props();
</script>

{#if prioritized}
	<span
		class="inline-flex h-6 w-6 items-center justify-center rounded text-xs font-bold {className}"
		style="color: var(--color-tron-red); background: rgba(255, 51, 102, 0.15);"
		title="Prioritized"
	>
		P
	</span>
{:else}
	<span
		class="inline-flex h-6 w-6 items-center justify-center rounded text-xs font-bold {className}"
		style="color: var(--color-tron-text-secondary); background: rgba(160, 160, 160, 0.15);"
		title="Not prioritized"
	>
		—
	</span>
{/if}
