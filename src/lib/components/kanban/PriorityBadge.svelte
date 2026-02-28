<script lang="ts">
	interface Props {
		priority: string;
		class?: string;
	}

	let { priority, class: className = '' }: Props = $props();

	const priorityConfig: Record<string, { label: string; color: string; bg: string }> = {
		high: {
			label: 'H',
			color: 'var(--color-tron-red)',
			bg: 'rgba(255, 51, 102, 0.15)'
		},
		medium: {
			label: 'M',
			color: 'var(--color-tron-orange)',
			bg: 'rgba(255, 102, 0, 0.15)'
		},
		low: {
			label: 'L',
			color: 'var(--color-tron-text-secondary)',
			bg: 'rgba(160, 160, 160, 0.15)'
		}
	};

	let config = $derived(priorityConfig[priority] ?? priorityConfig.medium);
</script>

<span
	class="inline-flex h-6 w-6 items-center justify-center rounded text-xs font-bold {className}"
	style="color: {config.color}; background: {config.bg};"
	title="Priority: {priority}"
>
	{config.label}
</span>
