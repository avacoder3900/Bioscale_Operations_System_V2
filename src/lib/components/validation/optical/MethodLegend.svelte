<script lang="ts">
	interface Props {
		thresholdK: number;
		windowK: number;
		minGroupN: number;
	}
	let { thresholdK, windowK, minGroupN }: Props = $props();
</script>

<div
	class="rounded-lg border border-[var(--color-tron-border)] p-4 text-xs leading-relaxed text-[var(--color-tron-text-secondary)]"
>
	<h3 class="tron-heading mb-2 text-xs font-semibold uppercase tracking-wide">
		How outliers are found
	</h3>

	<p class="mb-2">
		A cartridge is flagged <span class="text-amber-400">⚠</span> when its F7/F3 on a well sits more
		than <span class="tron-text-primary font-semibold">{thresholdK} robust SDs</span> from
		<span class="tron-text-primary font-semibold">its own group's median</span>.
	</p>

	<p class="mb-2">
		<em>Median</em> is the middle value. <em>MAD</em> is the median of the distances from that middle
		value, scaled ×1.4826 so it reads on the same scale as a standard deviation. Median and MAD are
		used instead of average and standard deviation because a single bad cartridge cannot drag them.
	</p>

	<p class="mb-2">
		<span class="tron-text-primary font-semibold">This replaces the previous mean ± 1σ band.</span> A
		cartridge is no longer flagged simply for being one standard deviation from the average — under
		that older rule roughly a third of a perfectly healthy group got flagged.
	</p>

	<p class="mb-2">
		Groups with fewer than {minGroupN} cartridges are not checked for outliers at all. If every cartridge
		in a group has the same F7/F3, no outliers are flagged — there is no spread to measure against.
		Where the spread had to be estimated from something other than MAD, the table says so.
	</p>

	<p class="mb-2">
		<span class="text-amber-400">⚠</span> means <em>outlier versus its group</em>. Text chips such as
		<span class="rounded border border-[var(--color-tron-border)] px-1">CV 22%</span> mean
		<em>this cartridge's own readings were noisy</em> — a different thing.
	</p>

	<p>
		Statistics use the endpoint window: the last {windowK} readings per well, because the readings are
		a kinetic curve rather than repeated measurements. F3 = 480 nm reference · F7 = 630 nm signal.
		These are descriptive statistics — no statistical test is performed and no p-values are computed,
		so treat flags as review signals rather than a pass/fail gate. Derived and non-destructive:
		cartridge records are never modified.
	</p>
</div>
