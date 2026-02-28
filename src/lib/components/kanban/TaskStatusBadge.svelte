<script lang="ts">
	import TronBadge from '$lib/components/ui/TronBadge.svelte';

	interface Props {
		status: string;
		class?: string;
	}

	let { status, class: className = '' }: Props = $props();

	const statusConfig: Record<
		string,
		{ label: string; variant: 'info' | 'success' | 'warning' | 'error' | 'neutral' }
	> = {
		backlog: { label: 'Backlog', variant: 'neutral' },
		ready: { label: 'Ready', variant: 'info' },
		wip: { label: 'WIP', variant: 'warning' },
		waiting: { label: 'Waiting', variant: 'error' },
		done: { label: 'Done', variant: 'success' }
	};

	let config = $derived(statusConfig[status] ?? { label: status, variant: 'neutral' as const });
</script>

<TronBadge variant={config.variant} class={className}>{config.label}</TronBadge>
