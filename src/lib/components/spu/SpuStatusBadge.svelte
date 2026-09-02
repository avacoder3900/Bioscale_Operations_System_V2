<script lang="ts">
	import TronBadge from '$lib/components/ui/TronBadge.svelte';

	type BadgeVariant = 'info' | 'success' | 'warning' | 'error' | 'neutral';

	interface Props {
		status: string;
	}

	let { status }: Props = $props();

	// Current lifecycle (SPU-INV-07): draft → assembling → validating →
	// released ⇄ servicing → retired. Keep in sync with
	// src/lib/server/spu-status.ts.
	const statusConfig: Record<string, { variant: BadgeVariant; label: string }> = {
		draft: { variant: 'neutral', label: 'Draft' },
		assembling: { variant: 'info', label: 'Assembling' },
		validating: { variant: 'warning', label: 'Validating' },
		released: { variant: 'success', label: 'Released' },
		servicing: { variant: 'warning', label: 'Servicing' },
		retired: { variant: 'neutral', label: 'Retired' },
		// Legacy (pre-collapse) values — render-only aliases so the immutable
		// statusTransitions history keeps displaying nicely. Never write these.
		assembled: { variant: 'info', label: 'Assembled' },
		validated: { variant: 'success', label: 'Validated' },
		'released-rnd': { variant: 'success', label: 'Released — R&D' },
		'released-manufacturing': { variant: 'success', label: 'Released — Mfg' },
		'released-field': { variant: 'success', label: 'Released — Field' },
		deployed: { variant: 'success', label: 'Deployed' },
		voided: { variant: 'error', label: 'Voided' }
	};

	let config = $derived(
		statusConfig[status] ?? { variant: 'neutral' as BadgeVariant, label: status }
	);
</script>

<TronBadge variant={config.variant}>{config.label}</TronBadge>
