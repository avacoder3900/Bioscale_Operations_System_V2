<script lang="ts">
	import { TronCard, TronBadge } from '$lib/components/ui';

	let { data } = $props();

	const FILTERS = [
		{ key: 'all', label: 'All' },
		{ key: 'unlinked', label: 'Not linked to a customer' },
		{ key: 'clinic', label: 'Clinic roles' },
		{ key: 'blocked', label: 'Blocked' }
	];
	const fmt = (iso: string | null) => (iso ? new Date(iso).toLocaleString() : '—');
	const pages = $derived(Math.max(1, Math.ceil(data.total / data.limit)));
	const link = (p: Record<string, string | number>) => {
		const sp = new URLSearchParams();
		if (data.q) sp.set('q', data.q);
		sp.set('filter', String(p.filter ?? data.filter));
		if (p.page && Number(p.page) > 1) sp.set('page', String(p.page));
		return `/app-accounts?${sp}`;
	};
</script>

<svelte:head><title>App accounts · BIMS</title></svelte:head>

<div class="space-y-6">
	<div>
		<h1 class="text-2xl font-bold text-[var(--color-tron-text)]">App accounts</h1>
		<p class="mt-1 text-sm text-[var(--color-tron-text-secondary)]">
			Everyone who has signed in to the Bioscale app. {data.total} account{data.total === 1 ? '' : 's'}
			{#if data.blockedTotal}· <span class="text-[var(--color-tron-red)]">{data.blockedTotal} blocked</span>{/if}
		</p>
	</div>

	<form method="GET" class="flex flex-wrap items-center gap-2">
		<input name="q" value={data.q} placeholder="Search email, name or account id" class="tron-input min-w-[18rem] flex-1" />
		<input type="hidden" name="filter" value={data.filter} />
		<button type="submit" class="rounded border border-[var(--color-tron-cyan)] px-3 py-2 text-sm text-[var(--color-tron-cyan)]">Search</button>
		{#if data.q}<a href="/app-accounts?filter={data.filter}" class="tron-text-muted text-sm hover:underline">Clear</a>{/if}
	</form>

	<div class="flex flex-wrap gap-2">
		{#each FILTERS as f (f.key)}
			<a
				href={link({ filter: f.key })}
				class="rounded border px-3 py-1 text-sm {data.filter === f.key
					? 'border-[var(--color-tron-cyan)] text-[var(--color-tron-cyan)]'
					: 'border-[var(--color-tron-border)] text-[var(--color-tron-text-secondary)] hover:text-[var(--color-tron-text)]'}"
			>
				{f.label}
			</a>
		{/each}
	</div>

	<TronCard>
		{#if data.rows.length === 0}
			<p class="tron-text-muted py-6 text-center text-sm">No accounts match.</p>
		{:else}
			<div class="overflow-x-auto">
				<table class="tron-table">
					<thead>
						<tr><th>Account</th><th>Sign-in</th><th>Customers</th><th>Cartridges</th><th>Last sign-in</th><th></th></tr>
					</thead>
					<tbody>
						{#each data.rows as r (r.accountId)}
							<tr>
								<td class="text-sm">
									<a href="/app-accounts/{encodeURIComponent(r.accountId)}" class="text-[var(--color-tron-cyan)] hover:underline">{r.email || r.accountId}</a>
									{#if r.name}<span class="tron-text-muted block text-xs">{r.name}</span>{/if}
									{#if r.bioscaleEmail && r.bioscaleEmail !== r.email}
										<span class="tron-text-muted block text-xs">results email: {r.bioscaleEmail} {r.verified ? '✓' : '(unverified)'}</span>
									{/if}
								</td>
								<td><TronBadge variant="neutral">{r.provider}</TronBadge></td>
								<td class="text-sm">
									{#if r.customers.length === 0}
										<span class="tron-text-muted">—</span>
									{:else}
										{#each r.customers as c (c.customerId)}
											<span class="block"><a href="/customers/{c.customerId}" class="hover:underline">{c.name}</a> <span class="tron-text-muted text-xs">({c.role})</span></span>
										{/each}
									{/if}
								</td>
								<td class="font-mono">{r.owned}</td>
								<td class="text-sm whitespace-nowrap">{fmt(r.lastSignInAt)}</td>
								<td>{#if r.blocked}<TronBadge variant="error">blocked</TronBadge>{/if}</td>
							</tr>
						{/each}
					</tbody>
				</table>
			</div>
			{#if pages > 1}
				<div class="tron-text-muted mt-4 flex items-center justify-between text-sm">
					<span>Page {data.page} of {pages} · {data.total} accounts</span>
					<span class="flex gap-2">
						{#if data.page > 1}<a class="text-[var(--color-tron-cyan)] hover:underline" href={link({ page: data.page - 1 })}>Previous</a>{/if}
						{#if data.page < pages}<a class="text-[var(--color-tron-cyan)] hover:underline" href={link({ page: data.page + 1 })}>Next</a>{/if}
					</span>
				</div>
			{/if}
		{/if}
	</TronCard>
</div>
