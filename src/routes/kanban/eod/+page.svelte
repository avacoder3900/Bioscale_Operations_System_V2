<script lang="ts">
	/**
	 * VOICE-01 — EOD check-in: who sent an end-of-day voice note, Monday–Friday.
	 * Rows are the roster (edited below by kanban admins) plus anyone who sent one.
	 */
	import { enhance } from '$app/forms';

	let { data } = $props();

	const fmtCol = (d: string) =>
		new Date(`${d}T12:00:00`).toLocaleDateString('en-US', { weekday: 'short', month: 'numeric', day: 'numeric' });
	const fmtWeek = (d: string) =>
		new Date(`${d}T12:00:00`).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
</script>

<svelte:head><title>EOD check-in — Kanban</title></svelte:head>

<div class="space-y-4">
	<div class="flex flex-wrap items-center justify-between gap-3">
		<div>
			<h1 class="tron-text-primary text-sm font-bold uppercase tracking-wide">EOD check-in — week of {fmtWeek(data.monday)}</h1>
			<p class="text-xs tron-text-muted">
				An ✕ means that person sent an end-of-day voice note that day (title it
				<span class="font-mono tron-text-primary">EOD</span> + initials, e.g.
				<span class="font-mono tron-text-primary">EOD JQ</span>).
			</p>
		</div>
		<nav class="flex items-center gap-1 text-xs" aria-label="Week">
			<a class="rounded border border-[var(--color-tron-border)] px-2 py-1 tron-text-primary" href="?week={data.prevWeek}">← Prev</a>
			{#if !data.isThisWeek}
				<a class="rounded border border-[var(--color-tron-border)] px-2 py-1 tron-text-primary" href="/kanban/eod">This week</a>
				<a class="rounded border border-[var(--color-tron-border)] px-2 py-1 tron-text-primary" href="?week={data.nextWeek}">Next →</a>
			{/if}
		</nav>
	</div>

	{#if data.rows.length === 0}
		<div class="rounded-lg border border-[var(--color-tron-border)] bg-[var(--color-tron-bg-secondary)] p-6 text-sm tron-text-muted">
			Nobody is on the roster and no notes came in this week.
			{#if data.canEdit}Pick the team under "Who is on this table" below.{/if}
		</div>
	{:else}
		<div class="overflow-x-auto rounded-lg border border-[var(--color-tron-border)] bg-[var(--color-tron-bg-secondary)]">
			<table class="w-full text-sm">
				<thead>
					<tr class="border-b border-[var(--color-tron-border)] text-xs uppercase tron-text-muted">
						<th class="px-4 py-2 text-left font-medium">Who</th>
						{#each data.days as d (d)}
							<th class="px-3 py-2 text-center font-medium {d === data.today ? 'text-[var(--color-tron-cyan)]' : ''}">{fmtCol(d)}</th>
						{/each}
						<th class="px-3 py-2 text-center font-medium">Sent</th>
					</tr>
				</thead>
				<tbody class="divide-y divide-[var(--color-tron-border)]">
					{#each data.rows as r (r.username)}
						<tr>
							<td class="px-4 py-2">
								<a class="flex items-baseline gap-2" href="/kanban/journal?who={encodeURIComponent(r.username)}" title="Open {r.name}'s notes">
									<span class="font-mono font-bold tron-text-primary">{r.initials}</span>
									<span class="text-xs tron-text-muted">{r.name}{r.onRoster ? '' : ' · not on roster'}</span>
								</a>
							</td>
							{#each r.cells as n, i (data.days[i])}
								{@const day = data.days[i]}
								<td class="px-3 py-2 text-center" title={n ? `${n} note${n === 1 ? '' : 's'}` : day < data.today ? 'No note' : ''}>
									{#if n}
										<span class="font-bold text-[var(--color-tron-cyan)]">✕{n > 1 ? ` ${n}` : ''}</span>
									{:else if day < data.today}
										<span class="text-red-400/70">–</span>
									{/if}
								</td>
							{/each}
							<td class="px-3 py-2 text-center font-mono text-xs tron-text-muted">{r.sent}/5</td>
						</tr>
					{/each}
				</tbody>
			</table>
		</div>
		<p class="text-xs tron-text-muted">
			✕ sent · <span class="text-red-400/70">–</span> day passed with no note · blank = today or later. Days are US Central; a note recorded before 4 a.m. counts for the day before.
		</p>
	{/if}

	{#if data.canEdit}
		<details class="rounded-lg border border-[var(--color-tron-border)] bg-[var(--color-tron-bg-secondary)]" open={data.roster.length === 0}>
			<summary class="cursor-pointer px-4 py-2 text-sm tron-text-primary">
				Who is on this table <span class="tron-text-muted">({data.roster.length})</span>
			</summary>
			<form method="POST" action="?/setRoster" use:enhance class="space-y-3 border-t border-[var(--color-tron-border)] px-4 py-3">
				<div class="grid grid-cols-1 gap-x-6 gap-y-1 sm:grid-cols-2 lg:grid-cols-3">
					{#each data.people as p (p.username)}
						<label class="flex items-center gap-2 text-xs tron-text-primary">
							<input type="checkbox" name="username" value={p.username} checked={data.roster.includes(p.username)} />
							<span class="w-8 font-mono font-bold">{p.initials}</span>
							<span class="tron-text-muted">{p.name}</span>
						</label>
					{/each}
				</div>
				<button type="submit" class="rounded border border-[var(--color-tron-cyan)] px-3 py-1 text-xs text-[var(--color-tron-cyan)]">Save roster</button>
			</form>
		</details>
	{/if}
</div>
