<script lang="ts">
	import BadgeCard from '$lib/components/admin/BadgeCard.svelte';

	interface Props {
		data: { badge: { badgeId: string; code: string; displayName: string; username: string | null; status: 'active' | 'revoked'; issuedAt: string | null; photoUrl: string | null } };
	}
	let { data }: Props = $props();
</script>

<svelte:head><title>Badge — {data.badge.displayName}</title></svelte:head>

<div class="space-y-4">
	<div class="no-print flex flex-wrap items-center justify-between gap-2">
		<div>
			<h3 class="text-base font-semibold text-[var(--color-tron-text)]">Print badge</h3>
			<p class="text-xs text-[var(--color-tron-text-secondary)]">One CR80 card (85.6 × 54 mm). Print at 100% scale, no fit-to-page; cut on the outline and slide into a badge holder.</p>
		</div>
		<div class="flex gap-2">
			<a href="/admin/badges" class="rounded border border-[var(--color-tron-border)] px-3 py-1.5 text-xs text-[var(--color-tron-text-secondary)] hover:border-[var(--color-tron-cyan)]/60">← Badges</a>
			<button type="button" onclick={() => window.print()} class="rounded border border-[var(--color-tron-cyan)]/50 bg-[var(--color-tron-cyan)]/20 px-4 py-1.5 text-xs font-medium text-[var(--color-tron-cyan)]">Print</button>
		</div>
	</div>

	<div class="print-area">
		<BadgeCard code={data.badge.code} displayName={data.badge.displayName} username={data.badge.username} status={data.badge.status} photoUrl={data.badge.photoUrl} />
	</div>
</div>

<style>
	/* Print strips the app chrome and puts the card at the top-left of the page. */
	@media print {
		:global(body *) { visibility: hidden; }
		.print-area, .print-area :global(*) { visibility: visible; }
		.print-area { position: absolute; left: 10mm; top: 10mm; }
		.no-print { display: none; }
	}
</style>
