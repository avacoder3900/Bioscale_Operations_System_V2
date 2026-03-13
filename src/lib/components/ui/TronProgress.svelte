<script lang="ts">
	interface Props {
		value: number;
		max?: number;
		showLabel?: boolean;
		class?: string;
	}

	let { value, max = 100, showLabel = false, class: className = '' }: Props = $props();

	let percentage = $derived(Math.min(Math.max((value / max) * 100, 0), 100));
</script>

<div class="w-full {className}">
	{#if showLabel}
		<div class="mb-1 flex justify-between">
			<span class="tron-text-secondary text-sm">Progress</span>
			<span class="tron-text-cyan text-sm">{Math.round(percentage)}%</span>
		</div>
	{/if}
	<div class="tron-progress">
		<div class="tron-progress-bar" style="width: {percentage}%"></div>
	</div>
</div>
