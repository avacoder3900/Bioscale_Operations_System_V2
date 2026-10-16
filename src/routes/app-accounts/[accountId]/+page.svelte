<script lang="ts">
	import { enhance } from '$app/forms';
	import { TronCard, TronBadge, TronButton } from '$lib/components/ui';

	let { data, form } = $props();

	const fmt = (iso: string | null) => (iso ? new Date(iso).toLocaleString() : '—');
	const a = $derived(data.account);
	const activeLinks = $derived(data.links.filter((l) => l.status === 'active'));
</script>

<svelte:head><title>{a.email || a.accountId} · App accounts · BIMS</title></svelte:head>

<div class="space-y-6">
	<div>
		<a href="/app-accounts" class="text-xs text-[var(--color-tron-text-secondary)] hover:text-[var(--color-tron-cyan)]">&larr; Back to App accounts</a>
		<div class="mt-2 flex flex-wrap items-start justify-between gap-3">
			<div>
				<h1 class="text-2xl font-bold text-[var(--color-tron-text)]">{a.name ?? a.email}</h1>
				<p class="mt-1 text-sm text-[var(--color-tron-text-secondary)]">
					{a.email} · <TronBadge variant="neutral">{a.provider}</TronBadge> · <span class="font-mono text-xs">{a.accountId}</span>
				</p>
			</div>
			{#if data.block}
				<TronBadge variant="error">blocked</TronBadge>
			{/if}
		</div>
	</div>

	{#if form?.error}
		<div class="rounded border border-[var(--color-tron-red)] bg-[rgba(255,51,102,0.1)] p-3"><p class="text-sm text-[var(--color-tron-red)]">{form.error}</p></div>
	{:else if form?.success}
		<div class="rounded border border-[var(--color-tron-green)] bg-[rgba(0,255,136,0.1)] p-3"><p class="text-sm text-[var(--color-tron-green)]">{form.message}</p></div>
	{/if}

	<!-- Identity (read-only: the app owns app_users) -->
	<TronCard>
		<h3 class="tron-text-primary mb-3 font-mono text-lg font-bold">Identity</h3>
		<dl class="grid gap-4 text-sm sm:grid-cols-3">
			<div><dt class="tron-text-muted">Sign-in email</dt><dd class="tron-text-primary mt-1">{a.email || '—'}</dd></div>
			<div><dt class="tron-text-muted">Name</dt><dd class="tron-text-primary mt-1">{a.name ?? '—'} {#if a.nameSource}<span class="tron-text-muted text-xs">(set by {a.nameSource})</span>{/if}</dd></div>
			<div><dt class="tron-text-muted">Results email</dt><dd class="tron-text-primary mt-1">{a.bioscaleEmail ?? '—'} {#if a.bioscaleEmail}<span class="text-xs {a.verifiedAt ? 'text-[var(--color-tron-green)]' : 'text-[var(--color-tron-yellow)]'}">{a.verifiedAt ? 'verified' : 'unverified'}</span>{/if}</dd></div>
			<div><dt class="tron-text-muted">First sign-in</dt><dd class="tron-text-primary mt-1">{fmt(a.createdAt)}</dd></div>
			<div><dt class="tron-text-muted">Last sign-in</dt><dd class="tron-text-primary mt-1">{fmt(a.lastSignInAt)}</dd></div>
		</dl>
		<p class="tron-text-muted mt-3 text-xs">Profile fields are owned by the app; the person edits them there. BIMS manages what is below.</p>
	</TronCard>

	<!-- Block -->
	<TronCard>
		<h3 class="tron-text-primary mb-3 font-mono text-lg font-bold">Access</h3>
		{#if data.block}
			<p class="text-sm text-[var(--color-tron-red)]">Blocked {fmt(data.block.at)}{#if data.block.by} by {data.block.by}{/if}: {data.block.reason}</p>
			<form method="POST" action="?/unblock" use:enhance class="mt-3">
				<TronButton type="submit" variant="primary">Unblock</TronButton>
			</form>
		{:else}
			<form method="POST" action="?/block" use:enhance class="flex flex-wrap items-end gap-2">
				<div class="min-w-[16rem] flex-1">
					<label class="tron-text-muted mb-1 block text-sm" for="blockReason">Block this account (reason required)</label>
					<input id="blockReason" name="reason" required class="tron-input w-full" placeholder="e.g. duplicate account, abuse report" />
				</div>
				<button type="submit" class="rounded border border-[var(--color-tron-red)] px-3 py-2 text-sm text-[var(--color-tron-red)] hover:bg-[var(--color-tron-red)]/10">Block</button>
			</form>
			<p class="tron-text-muted mt-2 text-xs">The app refuses the sign-in immediately. Nothing is deleted; unblocking restores everything.</p>
		{/if}
	</TronCard>

	<!-- Customers -->
	<TronCard>
		<h3 class="tron-text-primary mb-3 font-mono text-lg font-bold">
			Customers
			<span class="ml-2 inline-block rounded-full bg-[var(--color-tron-cyan)] px-2 py-0.5 text-xs text-black">{activeLinks.length}</span>
		</h3>
		<form method="POST" action="?/link" use:enhance class="mb-4 flex flex-wrap items-end gap-2">
			<div class="min-w-[16rem] flex-1">
				<label class="tron-text-muted mb-1 block text-sm" for="customerId">Link to a customer</label>
				<select id="customerId" name="customerId" required class="tron-input w-full">
					<option value="">Choose…</option>
					{#each data.customers as c (c.id)}<option value={c.id}>{c.name}{c.customerType ? ` (${c.customerType})` : ''}</option>{/each}
				</select>
			</div>
			<div>
				<label class="tron-text-muted mb-1 block text-sm" for="role">Role</label>
				<select id="role" name="role" class="tron-input">
					<option value="member">Member (own tests)</option>
					<option value="admin">Clinic admin</option>
					<option value="staff">Clinic staff</option>
				</select>
			</div>
			<TronButton type="submit" variant="primary">Link</TronButton>
		</form>
		{#if data.links.length === 0}
			<p class="tron-text-muted py-2 text-center text-sm">Not linked to any customer. Shipments cannot be assigned to this account until it is.</p>
		{:else}
			<div class="overflow-x-auto">
				<table class="tron-table">
					<thead><tr><th>Customer</th><th>Role</th><th>Status</th><th>Linked</th><th></th></tr></thead>
					<tbody>
						{#each data.links as l (l.id)}
							<tr class={l.status === 'revoked' ? 'opacity-60' : ''}>
								<td class="text-sm"><a href="/customers/{l.customerId}" class="text-[var(--color-tron-cyan)] hover:underline">{l.customerName}</a></td>
								<td><TronBadge variant={l.role === 'admin' ? 'info' : 'neutral'}>{l.role}</TronBadge></td>
								<td><TronBadge variant={l.status === 'active' ? 'success' : 'warning'}>{l.status}</TronBadge></td>
								<td class="text-sm">{fmt(l.linkedAt)}{#if l.linkedBy}<span class="tron-text-muted block text-xs">by {l.linkedBy}</span>{/if}</td>
								<td>
									{#if l.status === 'active'}
										<form method="POST" action="?/revoke" use:enhance>
											<input type="hidden" name="linkId" value={l.id} />
											<button type="submit" class="text-xs text-[var(--color-tron-red)] hover:underline">Revoke</button>
										</form>
									{/if}
								</td>
							</tr>
						{/each}
					</tbody>
				</table>
			</div>
		{/if}
	</TronCard>

	<!-- Cartridges -->
	{#snippet cartridgeTable(rows: typeof data.owned, showOwner: boolean)}
		<div class="overflow-x-auto">
			<table class="tron-table">
				<thead><tr><th>Cartridge</th><th>Assay</th><th>Run</th><th>Source</th>{#if showOwner}<th>Customer / patient</th>{/if}<th>Since</th><th></th></tr></thead>
				<tbody>
					{#each rows as r (r.id)}
						<tr>
							<td class="font-mono text-xs"><a href="/cartridge-admin/dhr/{r.cartridgeId}" class="text-[var(--color-tron-cyan)] hover:underline">{r.cartridgeId}</a>{#if r.status}<span class="tron-text-muted ml-1">({r.status})</span>{/if}</td>
							<td class="text-sm">{r.assayName ?? '—'}</td>
							<td class="text-sm whitespace-nowrap">{r.ranAt ? new Date(r.ranAt).toLocaleString() : '—'}</td>
							<td><TronBadge variant={r.source === 'shipment' || r.matchedShipment ? 'success' : 'warning'}>{r.source}{r.source === 'claim' && !r.matchedShipment ? ' · unmatched' : ''}</TronBadge></td>
							{#if showOwner}<td class="text-sm">{r.customerName ?? '—'}{#if r.subjectName}<span class="tron-text-muted block text-xs">{r.subjectName}</span>{:else if r.customerName}<span class="tron-text-muted block text-xs">unassigned</span>{/if}</td>{/if}
							<td class="text-sm whitespace-nowrap">{fmt(r.claimedAt)}</td>
							<td>
								<form method="POST" action="?/release" use:enhance>
									<input type="hidden" name="cartridgeId" value={r.cartridgeId} />
									<button type="submit" class="text-xs text-[var(--color-tron-red)] hover:underline">Release</button>
								</form>
							</td>
						</tr>
					{/each}
				</tbody>
			</table>
		</div>
	{/snippet}

	<TronCard>
		<h3 class="tron-text-primary mb-3 font-mono text-lg font-bold">
			Cartridges linked to this account
			<span class="ml-2 inline-block rounded-full bg-[var(--color-tron-cyan)] px-2 py-0.5 text-xs text-black">{data.owned.length}</span>
		</h3>
		{#if data.owned.length === 0}
			<p class="tron-text-muted py-2 text-center text-sm">None. They appear when the account scans a cartridge in the app or a shipment goes to its customer.</p>
		{:else}
			{@render cartridgeTable(data.owned, false)}
		{/if}
	</TronCard>

	{#if data.clinicOwned.length > 0}
		<TronCard>
			<h3 class="tron-text-primary mb-3 font-mono text-lg font-bold">
				Visible through clinic roles
				<span class="ml-2 inline-block rounded-full bg-[var(--color-tron-cyan)] px-2 py-0.5 text-xs text-black">{data.clinicOwned.length}</span>
			</h3>
			{@render cartridgeTable(data.clinicOwned, true)}
		</TronCard>
	{/if}

	<!-- Invites and attempts -->
	<div class="grid gap-6 lg:grid-cols-2">
		<TronCard>
			<h3 class="tron-text-primary mb-3 font-mono text-lg font-bold">Invites to this email</h3>
			{#if data.invites.length === 0}
				<p class="tron-text-muted text-sm">None.</p>
			{:else}
				<ul class="space-y-1 text-sm">
					{#each data.invites as i (i.id)}
						<li class="flex items-center justify-between rounded border border-[var(--color-tron-border)] px-3 py-2">
							<span>{i.customerName} <TronBadge variant="neutral">{i.role}</TronBadge></span>
							<span class="tron-text-muted text-xs">{i.status} · expires {fmt(i.expiresAt)}{#if i.createdBy} · by {i.createdBy}{/if}</span>
						</li>
					{/each}
				</ul>
			{/if}
		</TronCard>
		<TronCard>
			<h3 class="tron-text-primary mb-3 font-mono text-lg font-bold">Claim attempts (last 24 h)</h3>
			{#if data.attempts.length === 0}
				<p class="tron-text-muted text-sm">None.</p>
			{:else}
				<ul class="space-y-1 text-xs">
					{#each data.attempts as t (t.id)}
						<li class="flex justify-between gap-2 rounded border border-[var(--color-tron-border)] px-3 py-1.5">
							<span class="font-mono">{t.cartridgeId ?? '—'}</span>
							<span class={t.outcome === 'claimed' ? 'text-[var(--color-tron-green)]' : 'text-[var(--color-tron-yellow)]'}>{t.outcome}</span>
							<span class="tron-text-muted whitespace-nowrap">{fmt(t.at)}</span>
						</li>
					{/each}
				</ul>
			{/if}
		</TronCard>
	</div>
</div>
