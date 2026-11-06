<script lang="ts">
	import { enhance } from '$app/forms';
	import { labelTitle } from '$lib/robot-arm/change-labels';
	import { statusTitle, unitFileTitle, type ArmTestStatus } from '$lib/robot-arm/arm-tests';

	let { data, form } = $props();

	let running = $state<string | null>(null);
	let logHidden = $state(false);
	let moveSetId = $state('');

	function when(iso: string): string {
		const d = new Date(iso);
		return isNaN(d.getTime()) ? '' : d.toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
	}

	function statusClass(s: ArmTestStatus): string {
		return s === 'pass' ? 'text-green-300' : s === 'skipped' ? 'text-[var(--color-tron-text-secondary)]' : 'text-red-300';
	}

	const ctl = 'rounded border px-2.5 py-1 text-[11px] font-medium transition-colors disabled:opacity-50';
	const ctlBlue = `${ctl} border-[var(--color-tron-cyan)] text-[var(--color-tron-cyan)]`;
</script>

<div class="mx-auto max-w-5xl space-y-4 p-4">
	<div class="flex items-center justify-between">
		<h1 class="text-base font-semibold" style="color: var(--color-tron-cyan)">Tests</h1>
		<a
			href="/manufacturing/cart-mfg/robot-arm/maintenance"
			class="text-xs transition-colors hover:text-[var(--color-tron-cyan)]"
			style="color: var(--color-tron-text-secondary)"
		>
			← Maintenance
		</a>
	</div>

	{#if form?.error}
		<div class="rounded border border-red-500/40 bg-red-900/10 p-3 text-sm text-red-300">{form.error}</div>
	{/if}

	<section class="rounded-lg border border-[var(--color-tron-border)] bg-[var(--color-tron-surface)] p-3">
		<h3 class="text-sm font-bold uppercase tracking-wider" style="color: var(--color-tron-text-secondary)">Unit Tests</h3>
		{#if !data.unit}
			<p class="mt-2 text-xs" style="color: var(--color-tron-text-secondary)">Not Run</p>
		{:else}
			{@const u = data.unit}
			<div class="mt-2 flex flex-wrap items-baseline gap-3">
				<span class="text-2xl font-semibold {u.failed ? 'text-red-300' : 'text-green-300'}">{u.passed}/{u.total} Passed</span>
				<span class="text-xs" style="color: var(--color-tron-text-secondary)">
					{when(u.at)}{u.commit ? ` · ${u.commit}` : ''}{u.branch ? ` · ${u.branch}` : ''}
				</span>
			</div>
			<table class="mt-2 w-full text-left text-xs">
				<thead style="color: var(--color-tron-text-secondary)">
					<tr><th class="py-1 pr-3">Area</th><th class="pr-3">Passed</th><th class="pr-3">Failed</th></tr>
				</thead>
				<tbody>
					{#each u.files as f (f.file)}
						<tr class="border-t border-[var(--color-tron-border)] align-top" style="color: var(--color-tron-text)">
							<td class="whitespace-nowrap py-1 pr-3">{unitFileTitle(f.file)}</td>
							<td class="pr-3 font-mono {f.passed === f.total ? 'text-green-300' : 'text-red-300'}">{f.passed}/{f.total}</td>
							<td class="pr-3 text-red-300">
								{#each f.failures as name (name)}<div>{name}</div>{/each}
							</td>
						</tr>
					{/each}
				</tbody>
			</table>
		{/if}
	</section>

	<section class="rounded-lg border border-[var(--color-tron-border)] bg-[var(--color-tron-surface)] p-3">
		<table class="w-full text-left text-xs">
			<thead style="color: var(--color-tron-text-secondary)">
				<tr><th class="py-1 pr-3">Test</th><th class="pr-3">Hardware</th><th class="pr-3">Expected</th><th class="pr-3">Last Result</th><th></th></tr>
			</thead>
			<tbody>
				{#each data.tests as t (t.key)}
					{@const last = form?.result?.key === t.key ? form.result : data.latest[t.key]}
					<tr class="border-t border-[var(--color-tron-border)] align-top" style="color: var(--color-tron-text)">
						<td class="py-1.5 pr-3">
							<div class="font-medium">{t.title}</div>
							{#if t.moves}<div class="text-[10px]" style="color: var(--color-tron-text-secondary)">Moves</div>{/if}
						</td>
						<td class="whitespace-nowrap py-1.5 pr-3">{labelTitle(t.hardware)}</td>
						<td class="py-1.5 pr-3" style="color: var(--color-tron-text-secondary)">{t.expected}</td>
						<td class="py-1.5 pr-3">
							{#if last}
								<span class="font-medium {statusClass(last.status)}">{statusTitle(last.status)}</span>
								<span class="ml-1" style="color: var(--color-tron-text-secondary)">{when(last.at)}</span>
								<div class="text-[11px]">{last.message}</div>
							{:else}
								<span style="color: var(--color-tron-text-secondary)">Not Run</span>
							{/if}
						</td>
						<td class="py-1.5 text-right">
							{#if data.canRun}
								<form
									method="POST"
									action="?/run"
									class="flex items-center justify-end gap-2"
									use:enhance={() => {
										running = t.key;
										return async ({ update }) => {
											await update({ reset: false });
											running = null;
										};
									}}
								>
									<input type="hidden" name="key" value={t.key} />
									{#if t.needsMoveSet}
										<select name="moveSetId" bind:value={moveSetId} class="rounded border bg-transparent px-1.5 py-1 text-[11px]" style="border-color: var(--color-tron-border); color: var(--color-tron-text)">
											<option value="">Move Set</option>
											{#each data.moveSets as m (m._id)}
												<option value={m._id}>{m.name}</option>
											{/each}
										</select>
									{/if}
									<button type="submit" class={ctlBlue} disabled={running !== null}>
										{running === t.key ? 'Running…' : 'Run'}
									</button>
								</form>
							{/if}
						</td>
					</tr>
				{/each}
			</tbody>
		</table>
	</section>

	<section class="rounded-lg border border-[var(--color-tron-border)] bg-[var(--color-tron-surface)] p-3">
		<div class="flex items-center justify-between gap-2">
			<h3 class="text-sm font-bold uppercase tracking-wider" style="color: var(--color-tron-text-secondary)">Test Log</h3>
			<button
				type="button"
				onclick={() => (logHidden = !logHidden)}
				class="rounded border px-2 py-0.5 text-xs"
				style="border-color: var(--color-tron-cyan); color: var(--color-tron-cyan)"
				aria-expanded={!logHidden}
			>
				{logHidden ? 'Show' : 'Hide'}
			</button>
		</div>
		{#if !logHidden}
			{#if data.logError}
				<p class="mt-2 text-xs text-red-300">{data.logError}</p>
			{:else if !data.runs.length}
				<p class="mt-2 text-xs" style="color: var(--color-tron-text-secondary)">No Tests Run Yet</p>
			{:else}
				<table class="mt-2 w-full text-left text-xs">
					<thead style="color: var(--color-tron-text-secondary)">
						<tr><th class="py-1 pr-3">When</th><th class="pr-3">Test</th><th class="pr-3">Result</th><th class="pr-3">Measured</th><th class="pr-3">Time</th><th class="pr-3">By</th></tr>
					</thead>
					<tbody>
						{#each data.runs as r (r._id)}
							<tr class="border-t border-[var(--color-tron-border)]" style="color: var(--color-tron-text)">
								<td class="whitespace-nowrap py-1 pr-3" style="color: var(--color-tron-text-secondary)">{when(r.at)}</td>
								<td class="whitespace-nowrap pr-3">{r.title}</td>
								<td class="whitespace-nowrap pr-3 font-medium {statusClass(r.status)}">{statusTitle(r.status)}</td>
								<td class="pr-3">{r.message}</td>
								<td class="whitespace-nowrap pr-3 font-mono" style="color: var(--color-tron-text-secondary)">{r.durationMs != null ? `${(r.durationMs / 1000).toFixed(1)} s` : ''}</td>
								<td class="whitespace-nowrap pr-3">{r.ranBy?.username ?? ''}</td>
							</tr>
						{/each}
					</tbody>
				</table>
			{/if}
		{/if}
	</section>
</div>
