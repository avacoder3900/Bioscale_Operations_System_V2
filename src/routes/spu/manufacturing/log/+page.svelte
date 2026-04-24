<script lang="ts">
	import type { PageData } from './$types';

	interface Props {
		data: PageData;
	}

	let { data }: Props = $props();

	function formatDateTime(iso: string | null): string {
		if (!iso) return '—';
		const d = new Date(iso);
		if (Number.isNaN(d.getTime())) return '—';
		return d.toLocaleString();
	}
</script>

<div class="space-y-6">
	<!-- Header -->
	<div class="flex items-center justify-between">
		<div>
			<h1 class="text-2xl font-bold text-[var(--color-tron-cyan)]">Completed Build Log</h1>
			<p class="mt-1 text-sm text-[var(--color-tron-text-secondary)]">
				Every completed SPU assembly with operator and wall-clock time.
			</p>
		</div>
		<a href="/spu/manufacturing" class="tron-btn-secondary text-xs">
			&larr; Back to Manufacturing
		</a>
	</div>

	<!-- Filter bar -->
	<form method="GET" class="tron-card flex flex-wrap items-end gap-3">
		<div class="flex-1 min-w-[200px]">
			<label
				for="operatorUsername"
				class="mb-1 block text-xs uppercase tracking-wide text-[var(--color-tron-text-secondary)]"
			>
				Operator
			</label>
			<select
				id="operatorUsername"
				name="operatorUsername"
				class="w-full rounded-md border border-[var(--color-tron-border)] bg-[var(--color-tron-bg-secondary)] px-3 py-2 text-sm text-[var(--color-tron-text-primary)] focus:border-[var(--color-tron-cyan)] focus:outline-none"
			>
				<option value="" selected={!data.filters.operatorUsername}>All operators</option>
				{#each data.distinctOperators as op (op.userId)}
					<option
						value={op.username}
						selected={data.filters.operatorUsername === op.username}
					>
						{op.username}
					</option>
				{/each}
			</select>
		</div>

		<div class="min-w-[160px]">
			<label
				for="dateFrom"
				class="mb-1 block text-xs uppercase tracking-wide text-[var(--color-tron-text-secondary)]"
			>
				From
			</label>
			<input
				type="date"
				id="dateFrom"
				name="dateFrom"
				value={data.filters.dateFrom ?? ''}
				class="w-full rounded-md border border-[var(--color-tron-border)] bg-[var(--color-tron-bg-secondary)] px-3 py-2 text-sm text-[var(--color-tron-text-primary)] focus:border-[var(--color-tron-cyan)] focus:outline-none"
			/>
		</div>

		<div class="min-w-[160px]">
			<label
				for="dateTo"
				class="mb-1 block text-xs uppercase tracking-wide text-[var(--color-tron-text-secondary)]"
			>
				To
			</label>
			<input
				type="date"
				id="dateTo"
				name="dateTo"
				value={data.filters.dateTo ?? ''}
				class="w-full rounded-md border border-[var(--color-tron-border)] bg-[var(--color-tron-bg-secondary)] px-3 py-2 text-sm text-[var(--color-tron-text-primary)] focus:border-[var(--color-tron-cyan)] focus:outline-none"
			/>
		</div>

		<div class="flex gap-2">
			<button type="submit" class="tron-btn-primary">Apply</button>
			<a href="/spu/manufacturing/log" class="tron-btn-secondary">Reset</a>
		</div>
	</form>

	<!-- Results -->
	<section class="space-y-3">
		<div class="flex items-baseline justify-between">
			<h2 class="text-lg font-semibold text-[var(--color-tron-text-primary)]">Completed Builds</h2>
			<span class="text-xs text-[var(--color-tron-text-secondary)]">
				{data.builds.length} result{data.builds.length === 1 ? '' : 's'}
			</span>
		</div>

		{#if data.builds.length === 0}
			<div class="tron-card text-center">
				<p class="text-sm text-[var(--color-tron-text-secondary)]">
					No completed builds yet
				</p>
			</div>
		{:else}
			<div class="overflow-x-auto rounded-lg border border-[var(--color-tron-border)]">
				<table class="tron-table">
					<thead>
						<tr>
							<th>UDI</th>
							<th>Operator</th>
							<th>Started</th>
							<th>Completed</th>
							<th>Elapsed</th>
						</tr>
					</thead>
					<tbody>
						{#each data.builds as build (build.spuId + ':' + (build.completedAt ?? ''))}
							<tr>
								<td class="font-mono text-sm text-[var(--color-tron-cyan)]">
									{build.udi || '—'}
								</td>
								<td class="text-sm">{build.operatorUsername || '—'}</td>
								<td class="text-sm">{formatDateTime(build.startedAt)}</td>
								<td class="text-sm">{formatDateTime(build.completedAt)}</td>
								<td class="text-sm font-mono text-[var(--color-tron-text-primary)]">
									{build.elapsedFormatted}
								</td>
							</tr>
						{/each}
					</tbody>
				</table>
			</div>
		{/if}
	</section>
</div>
