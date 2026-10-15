<script lang="ts">
	import BadgeCard from '$lib/components/admin/BadgeCard.svelte';

	type Badge = { badgeId: string; code: string; displayName: string; username: string | null; status: 'active' | 'revoked'; photoUrl: string | null };
	interface Props { data: { badges: Badge[]; missing: number } }
	let { data }: Props = $props();

	const revokedCount = $derived(data.badges.filter(b => b.status === 'revoked').length);
</script>

<svelte:head><title>Print {data.badges.length} badges</title></svelte:head>

<div class="space-y-4">
	<div class="no-print flex flex-wrap items-center justify-between gap-2">
		<div>
			<h3 class="text-base font-semibold text-[var(--color-tron-text)]">Print {data.badges.length} badge{data.badges.length === 1 ? '' : 's'}</h3>
			<p class="text-xs text-[var(--color-tron-text-secondary)]">
				Eight CR80 cards per Letter page (two across). Print at 100% scale, no fit-to-page; cut on the outlines.
				{#if revokedCount > 0}<span class="text-[var(--color-tron-yellow)]">{revokedCount} of these {revokedCount === 1 ? 'is' : 'are'} revoked and will print with a REVOKED band.</span>{/if}
				{#if data.missing > 0}<span class="text-[var(--color-tron-yellow)]">{data.missing} selected id{data.missing === 1 ? '' : 's'} no longer exist{data.missing === 1 ? 's' : ''}.</span>{/if}
			</p>
		</div>
		<div class="flex gap-2">
			<a href="/admin/badges" class="rounded border border-[var(--color-tron-border)] px-3 py-1.5 text-xs text-[var(--color-tron-text-secondary)] hover:border-[var(--color-tron-cyan)]/60">← Badges</a>
			<button type="button" onclick={() => window.print()} class="rounded border border-[var(--color-tron-cyan)]/50 bg-[var(--color-tron-cyan)]/20 px-4 py-1.5 text-xs font-medium text-[var(--color-tron-cyan)]">Print all</button>
		</div>
	</div>

	<div class="print-area sheet">
		{#each data.badges as b (b.badgeId)}
			<BadgeCard code={b.code} displayName={b.displayName} username={b.username} status={b.status} photoUrl={b.photoUrl} />
		{/each}
	</div>
</div>

<style>
	/* Two columns of cards with a 6 mm gutter: 2 × 85.6 + 6 = 177 mm, inside a
	   Letter or A4 printable width; four rows per page (4 × 54 + 3 × 6 = 234 mm). */
	.sheet {
		display: grid;
		grid-template-columns: repeat(2, 85.6mm);
		gap: 6mm;
		justify-content: start;
	}
	@media print {
		:global(body *) { visibility: hidden; }
		.print-area, .print-area :global(*) { visibility: visible; }
		.print-area { position: absolute; left: 10mm; top: 10mm; }
		.no-print { display: none; }
	}
</style>
