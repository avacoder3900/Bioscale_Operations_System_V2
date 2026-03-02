<script lang="ts">
	import TronBadge from '$lib/components/ui/TronBadge.svelte';

	type BadgeVariant = 'info' | 'success' | 'warning' | 'error' | 'neutral';

	interface Props {
		status: string;
	}

	let { status }: Props = $props();

	const statusConfig: Record<string, { variant: BadgeVariant; label: string }> = {
		draft: { variant: 'neutral', label: 'Draft' },
		in_assembly: { variant: 'info', label: 'In Assembly' },
		assembly_complete: { variant: 'warning', label: 'Assembly Complete' },
		validated: { variant: 'success', label: 'Validated' },
		shipped: { variant: 'info', label: 'Shipped' },
		retired: { variant: 'neutral', label: 'Retired' }
	};

	let config = $derived(
		statusConfig[status] ?? { variant: 'neutral' as BadgeVariant, label: status }
	);
</script>

<TronBadge variant={config.variant}>{config.label}</TronBadge>
