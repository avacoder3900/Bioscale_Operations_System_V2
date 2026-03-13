<script lang="ts">
	import TronBadge from '$lib/components/ui/TronBadge.svelte';

	type BadgeVariant = 'info' | 'success' | 'warning' | 'error' | 'neutral';

	type DocumentStatus =
		| 'draft'
		| 'in_review'
		| 'pending_approval'
		| 'approved'
		| 'effective'
		| 'retired';

	interface Props {
		status: DocumentStatus | string;
	}

	let { status }: Props = $props();

	const statusConfig: Record<string, { variant: BadgeVariant; label: string }> = {
		draft: { variant: 'neutral', label: 'Draft' },
		in_review: { variant: 'warning', label: 'In Review' },
		pending_approval: { variant: 'warning', label: 'Pending Approval' },
		approved: { variant: 'info', label: 'Approved' },
		effective: { variant: 'success', label: 'Effective' },
		retired: { variant: 'error', label: 'Retired' }
	};

	let config = $derived(
		statusConfig[status] ?? { variant: 'neutral' as BadgeVariant, label: status }
	);
</script>

<TronBadge variant={config.variant}>{config.label}</TronBadge>
