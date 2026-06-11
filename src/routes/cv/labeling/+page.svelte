<script lang="ts">
	import { enhance } from '$app/forms';
	import { goto } from '$app/navigation';
	import { page } from '$app/stores';

	let { data } = $props();

	let items = $state(data.items);
	$effect(() => {
		// Re-sync when the project filter reloads the page data.
		items = data.items;
	});

	const stats = $derived.by(() => {
		const reviewed = items.filter((i: any) => i.humanLabel).length;
		const agree = items.filter((i: any) => i.humanLabel && i.humanLabel === i.result).length;
		return { total: items.length, reviewed, agree, disagree: reviewed - agree };
	});

	function onProjectChange(e: Event) {
		const value = (e.target as HTMLSelectElement).value;
		const url = new URL($page.url);
		if (value) url.searchParams.set('projectId', value);
		else url.searchParams.delete('projectId');
		goto(url, { keepFocus: true });
	}

	function submitLabel() {
		return async ({ formData, update }: any) => {
			const id = formData.get('inspectionId');
			const humanLabel = formData.get('humanLabel');
			const it = items.find((x: any) => x._id === id);
			if (it) it.humanLabel = humanLabel; // optimistic
			await update({ reset: false });
		};
	}

	function pct(score: number | undefined): string {
		if (score === undefined || score === null) return '—';
		return `${Math.round(score * 100)}%`;
	}
</script>

<div class="space-y-6">
	<div class="flex flex-wrap items-end justify-between gap-4">
		<div>
			<h2 class="tron-text-primary tron-heading text-2xl font-bold">Review &amp; Label</h2>
			<p class="text-sm text-[var(--color-tron-text-secondary)]">
				Confirm or correct the model's verdict. Your decision becomes the training label.
			</p>
		</div>

		<label class="flex flex-col gap-1 text-xs text-[var(--color-tron-text-secondary)]">
			<span>Project</span>
			<select
				class="min-w-56 rounded border border-[var(--color-tron-border)] bg-[var(--color-tron-bg-secondary)] px-3 py-2 text-sm text-[var(--color-tron-text-primary)]"
				value={data.selectedProjectId ?? ''}
				onchange={onProjectChange}
			>
				<option value="">All projects</option>
				{#each data.projects as p (p._id)}
					<option value={p._id}>{p.name} ({p.modelStatus})</option>
				{/each}
			</select>
		</label>
	</div>

	<!-- Summary -->
	<div class="grid grid-cols-2 gap-3 sm:grid-cols-4">
		{@render stat('In queue', stats.total)}
		{@render stat('Reviewed', stats.reviewed)}
		{@render stat('Agree w/ model', stats.agree, 'text-[var(--color-tron-green,#22c55e)]')}
		{@render stat('Corrected', stats.disagree, 'text-[var(--color-tron-red,#ef4444)]')}
	</div>

	{#if items.length === 0}
		<div
			class="rounded-lg border border-dashed border-[var(--color-tron-border)] p-10 text-center text-sm text-[var(--color-tron-text-secondary)]"
		>
			No inspected images in the queue. Run inference on captured cartridges first.
		</div>
	{:else}
		<div class="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
			{#each items as item (item._id)}
				{@const agrees = item.humanLabel && item.humanLabel === item.result}
				<div
					class="flex flex-col overflow-hidden rounded-lg border bg-[var(--color-tron-bg-secondary)]
						{item.humanLabel
						? agrees
							? 'border-[var(--color-tron-green,#22c55e)]/60'
							: 'border-[var(--color-tron-red,#ef4444)]/60'
						: 'border-[var(--color-tron-border)]'}"
				>
					<!-- Image -->
					<div class="aspect-square w-full bg-black/40">
						{#if item.image?.imageUrl}
							<img
								src={item.image.imageUrl}
								alt={item.image?.filename ?? 'cartridge'}
								class="h-full w-full object-contain"
								loading="lazy"
							/>
						{:else}
							<div class="flex h-full items-center justify-center text-xs text-[var(--color-tron-text-secondary)]">
								image unavailable
							</div>
						{/if}
					</div>

					<div class="flex flex-1 flex-col gap-3 p-3">
						<!-- Model verdict -->
						<div class="flex items-center justify-between">
							<span class="text-xs uppercase tracking-wide text-[var(--color-tron-text-secondary)]">
								Model says
							</span>
							<span
								class="rounded px-2 py-0.5 text-xs font-bold uppercase
									{item.result === 'pass'
									? 'bg-[var(--color-tron-green,#22c55e)]/20 text-[var(--color-tron-green,#22c55e)]'
									: 'bg-[var(--color-tron-red,#ef4444)]/20 text-[var(--color-tron-red,#ef4444)]'}"
							>
								{item.result ?? 'n/a'} · {pct(item.confidenceScore)}
							</span>
						</div>

						<!-- Human decision -->
						<form method="POST" action="?/setLabel" use:enhance={submitLabel}>
							<input type="hidden" name="inspectionId" value={item._id} />
							<div class="grid grid-cols-2 gap-2">
								<button
									type="submit"
									name="humanLabel"
									value="pass"
									class="rounded px-3 py-2 text-sm font-semibold transition-colors
										{item.humanLabel === 'pass'
										? 'bg-[var(--color-tron-green,#22c55e)] text-black'
										: 'border border-[var(--color-tron-border)] text-[var(--color-tron-text-primary)] hover:bg-[var(--color-tron-bg-tertiary)]'}"
								>
									Pass
								</button>
								<button
									type="submit"
									name="humanLabel"
									value="fail"
									class="rounded px-3 py-2 text-sm font-semibold transition-colors
										{item.humanLabel === 'fail'
										? 'bg-[var(--color-tron-red,#ef4444)] text-black'
										: 'border border-[var(--color-tron-border)] text-[var(--color-tron-text-primary)] hover:bg-[var(--color-tron-bg-tertiary)]'}"
								>
									Fail
								</button>
							</div>
						</form>

						{#if item.humanLabel}
							<p class="text-center text-xs {agrees ? 'text-[var(--color-tron-green,#22c55e)]' : 'text-[var(--color-tron-red,#ef4444)]'}">
								{agrees ? 'Confirmed model' : 'Corrected model'}
							</p>
						{/if}
					</div>
				</div>
			{/each}
		</div>
	{/if}
</div>

{#snippet stat(label: string, value: number, color = 'text-[var(--color-tron-cyan)]')}
	<div class="rounded-lg border border-[var(--color-tron-border)] bg-[var(--color-tron-bg-secondary)] p-3">
		<div class="text-xs text-[var(--color-tron-text-secondary)]">{label}</div>
		<div class="text-2xl font-bold {color}">{value}</div>
	</div>
{/snippet}
