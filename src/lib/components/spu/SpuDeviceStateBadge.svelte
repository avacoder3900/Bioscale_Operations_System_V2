<script lang="ts">
	import TronBadge from '$lib/components/ui/TronBadge.svelte';

	type BadgeVariant = 'info' | 'success' | 'warning' | 'error' | 'neutral';

	interface Props {
		deviceState: string;
	}

	let { deviceState }: Props = $props();

	const stateConfig: Record<string, { variant: BadgeVariant; label: string }> = {
		production: { variant: 'success', label: 'Production' },
		development_a: { variant: 'info', label: 'Dev A' },
		development_b: { variant: 'info', label: 'Dev B' },
		assembly: { variant: 'warning', label: 'Assembly' },
		out_of_service: { variant: 'error', label: 'Out of Service' }
	};

	let config = $derived(
		stateConfig[deviceState] ?? { variant: 'neutral' as BadgeVariant, label: deviceState }
	);
</script>

<TronBadge variant={config.variant}>{config.label}</TronBadge>
