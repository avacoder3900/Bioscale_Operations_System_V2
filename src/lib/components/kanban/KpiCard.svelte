<script lang="ts">
	interface Props {
		label: string;
		value: string;
		subline?: string;
		accent?: string;
	}

	let { label, value, subline, accent = '#00d4ff' }: Props = $props();
</script>

<div
	class="tron-card flex flex-col gap-1 p-4"
	style="border-top: 3px solid {accent};"
>
	<span class="tron-text-muted text-[10px] uppercase tracking-wide">{label}</span>
	<span class="tron-text-primary text-3xl font-bold leading-tight" style="color: {accent};">
		{value}
	</span>
	{#if subline}
		<span class="tron-text-muted text-xs">{subline}</span>
	{/if}
</div>
