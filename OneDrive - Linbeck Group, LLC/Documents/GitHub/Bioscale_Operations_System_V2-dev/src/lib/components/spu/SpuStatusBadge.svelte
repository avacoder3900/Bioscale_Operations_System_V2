<script lang="ts">
	import TronBadge from '$lib/components/ui/TronBadge.svelte';

	type BadgeVariant = 'info' | 'success' | 'warning' | 'error' | 'neutral';

	interface Props {
		status: string;
	}

	let { status }: Props = $props();

	const statusConfig: Record<string, { variant: BadgeVariant; label: string }> = {
		draft: { variant: 'neutral', label: 'Draft' },
		assembling: { variant: 'info', label: 'Assembling' },
		assembled: { variant: 'info', label: 'Assembled' },
		validating: { variant: 'warning', label: 'Validating' },
		validated: { variant: 'success', label: 'Validated' },
		'released-rnd': { variant: 'success', label: 'Released — R&D' },
		'released-manufacturing': { variant: 'success', label: 'Released — Mfg' },
		'released-field': { variant: 'success', label: 'Released — Field' },
		deployed: { variant: 'success', label: 'Deployed' },
		servicing: { variant: 'warning', label: 'Servicing' },
		retired: { variant: 'neutral', label: 'Retired' },
		voided: { variant: 'error', label: 'Voided' }
	};

	let config = $derived(
		statusConfig[status] ?? { variant: 'neutral' as BadgeVariant, label: status }
	);
</script>

<TronBadge variant={config.variant}>{config.label}</TronBadge>
