<script lang="ts">
	import { enhance } from '$app/forms';
	import { TronCard, TronBadge, TronButton } from '$lib/components/ui';

	let { data, form } = $props();

	const fmt = (iso: string | null) => (iso ? new Date(iso).toLocaleString() : '—');
	const a = $derived(data.account);
	const activeLinks = $derived(data.links.filter((l) => l.status === 'active'));

	// Bulk assign: what the scanner has typed so far, and how many distinct ids
	// that is (same split as the server's parseScannedIds).
	let scanned = $state('');
	const scannedCount = $derived(new Set(scanned.split(/[\s,;]+/).filter(Boolean)).size);
</script>

<svelte:head><title>{a.email || a.accountId} · App accounts · BIMS</title></svelte:head>

<div class="space-y-6">
	<div>
		<a href="/app-accounts" class="text-xs text-[var(--color-tron-text-secondary)] hover:text-[var(--color-tron-cyan)]">&larr; Back to App accounts</a>
		<div class="mt-2 flex flex-wrap items-start justify-between gap-3">
			<div>
				<h1 class="text-2xl font-bold text-[var(--color-tron-text)]">{a.name ?? a.email}</h1>
				<p class="mt-1 text-sm text-[var(--color-tron-text-secondary)]">
					{a.email} · <TronBadge variant={a.isDev ? 'warning' : 'neutral'}>{a.provider}</TronBadge> · <span class="font-mono text-xs">{a.accountId}</span>
				</p>
			</div>
			<div class="flex items-center gap-2">
				{#if a.isDev}<TronBadge variant="warning">dev account</TronBadge>{/if}
				{#if data.block}<TronBadge variant="error">blocked</TronBadge>{/if}
			</div>
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
			{#if a.isDev}
				<div><dt class="tron-text-muted">Dev account</dt><dd class="tron-text-primary mt-1">Created in BIMS{#if a.devCreatedBy} by {a.devCreatedBy}{/if}. No real person signs in to it.</dd></div>
			{/if}
		</dl>
		{#if data.canWrite}
			<form method="POST" action="?/setEmail" use:enhance class="mt-4 flex flex-wrap items-end gap-2 border-t border-[var(--color-tron-border)] pt-4">
				<div class="min-w-[16rem] flex-1">
					<label class="tron-text-muted mb-1 block text-sm" for="resultsEmail">Change results email</label>
					<input id="resultsEmail" name="email" type="email" value={a.bioscaleEmail ?? ''} class="tron-input w-full" placeholder={a.email || 'name@example.com'} />
				</div>
				<TronButton type="submit" variant="primary">Save email</TronButton>
			</form>
			<p class="tron-text-muted mt-2 text-xs">
				Saved as verified — you are vouching for the address. Leave it empty to fall back to the sign-in email.
				The sign-in email comes from {a.provider} and is refreshed by the app on every sign-in, so it can't be changed here.
			</p>
		{/if}
		<p class="tron-text-muted mt-3 text-xs">Other profile fields are owned by the app; the person edits them there. BIMS manages what is below.</p>
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
							<td><TronBadge variant={r.source === 'shipment' || r.source === 'operator' || r.matchedShipment ? 'success' : 'warning'}>{r.source}{r.source === 'claim' && !r.matchedShipment ? ' · unmatched' : ''}</TronBadge></td>
							{#if showOwner}<td class="text-sm">{r.customerName ?? '—'}{#if r.subjectName}<span class="tron-text-muted block text-xs">{r.subjectName}</span>{:else if r.customerName}<span class="tron-text-muted block text-xs">unassigned</span>{/if}</td>{/if}
							<td class="text-sm whitespace-nowrap">{fmt(r.claimedAt)}{#if r.claimedBy}<span class="tron-text-muted block text-xs">by {r.claimedBy}</span>{/if}</td>
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
		<form
			method="POST"
			action="?/assign"
			use:enhance={() => async ({ result, update }) => {
				await update({ reset: false });
				if (result.type === 'success') scanned = '';
			}}
			class="mb-4 flex flex-wrap items-end gap-2"
		>
			<div class="min-w-[18rem] flex-1">
				<label class="tron-text-muted mb-1 block text-sm" for="assignCartridgeIds">
					Assign cartridges to this account — scan one after another, each lands on its own line
					{#if scannedCount}<span class="ml-1 text-[var(--color-tron-cyan)]">({scannedCount} cartridge{scannedCount === 1 ? '' : 's'})</span>{/if}
				</label>
				<textarea
					id="assignCartridgeIds"
					name="cartridgeIds"
					bind:value={scanned}
					required
					rows="4"
					placeholder={'Scan or type cartridge ids — the QR payload (UUID) or CART-000123, one per line'}
					class="tron-input w-full font-mono"
					autocomplete="off"
					spellcheck="false"
				></textarea>
			</div>
			<div class="min-w-[12rem]">
				<label class="tron-text-muted mb-1 block text-sm" for="assignNote">Note (optional)</label>
				<input id="assignNote" name="note" placeholder="e.g. order #1234" class="tron-input w-full" />
			</div>
			<label class="tron-text-muted flex items-center gap-1 pb-2 text-sm"><input type="checkbox" name="replace" /> replace current owner</label>
			<TronButton type="submit" variant="primary">Assign{scannedCount > 1 ? ` ${scannedCount}` : ''}</TronButton>
		</form>
		{#if form?.results?.length}
			<ul class="mb-4 space-y-1 text-sm">
				{#each form.results as r (r.cartridgeId)}
					<li class="flex flex-wrap gap-2">
						<span class="font-mono">{r.cartridgeId}</span>
						<span class={r.ok ? 'text-[var(--color-tron-green)]' : 'text-[var(--color-tron-red)]'}>{r.text}</span>
					</li>
				{/each}
			</ul>
		{/if}
		{#if data.owned.length === 0}
			<p class="tron-text-muted py-2 text-center text-sm">None. People do not scan cartridges in the app; assign one here, from the cartridge's DHR page, or let a shipment to the account's customer do it.</p>
		{:else}
			{@render cartridgeTable(data.owned, false)}
		{/if}
	</TronCard>

	<!-- Account type and clinic enrollment (app_account_settings, written only by BIMS) -->
	<TronCard>
		<h3 class="tron-text-primary mb-3 font-mono text-lg font-bold">Account type</h3>
		<form method="POST" action="?/setType" use:enhance class="flex flex-wrap items-end gap-2">
			<div>
				<label class="tron-text-muted mb-1 block text-sm" for="accountType">Type</label>
				<select id="accountType" name="accountType" value={data.accountType} class="tron-input" disabled={!data.canWrite}>
					<option value="individual">Individual</option>
					<option value="clinic">Clinic</option>
					<option value="dev" disabled={!data.isAdmin && data.accountType !== 'dev'}>Dev{data.isAdmin ? '' : ' (admin only)'}</option>
				</select>
			</div>
			{#if data.canWrite}<TronButton type="submit" variant="primary">Save</TronButton>{/if}
		</form>
		<p class="tron-text-muted mt-2 text-xs">
			{#if data.accountType === 'dev'}
				<span class="text-[var(--color-tron-yellow)]">Dev: sees every user's results in the app.</span> Granting or removing Dev needs a BIMS admin.
			{:else if data.accountType === 'clinic'}
				Clinic: sees its own cartridges and those of every individual account enrolled under it.
			{:else}
				Individual (the default for every new account): sees only the cartridges assigned to it.
			{/if}
		</p>

		{#if data.accountType === 'individual'}
			<div class="mt-4 border-t border-[var(--color-tron-border)] pt-4">
				<h4 class="tron-text-primary mb-2 text-sm font-semibold">Clinic</h4>
				{#if data.clinic}
					<div class="flex flex-wrap items-center gap-3 text-sm">
						<span>Enrolled under <a href="/app-accounts/{encodeURIComponent(data.clinic.accountId)}" class="text-[var(--color-tron-cyan)] hover:underline">{data.clinic.label}</a>, which sees this account's results.</span>
						{#if data.canWrite}
							<form method="POST" action="?/unenroll" use:enhance>
								<button type="submit" class="text-xs text-[var(--color-tron-red)] hover:underline">Remove from clinic</button>
							</form>
						{/if}
					</div>
				{:else}
					<p class="tron-text-muted mb-2 text-sm">Not enrolled under a clinic (optional).</p>
				{/if}
				{#if data.canWrite && data.clinicOptions.length > 0}
					<form method="POST" action="?/enroll" use:enhance class="mt-2 flex flex-wrap items-end gap-2">
						<div class="min-w-[16rem] flex-1">
							<label class="tron-text-muted mb-1 block text-sm" for="clinicAccountId">{data.clinic ? 'Move to another clinic' : 'Enroll under a clinic'}</label>
							<select id="clinicAccountId" name="clinicAccountId" required class="tron-input w-full">
								<option value="">Choose…</option>
								{#each data.clinicOptions.filter((c) => c.accountId !== data.clinic?.accountId) as c (c.accountId)}<option value={c.accountId}>{c.label}</option>{/each}
							</select>
						</div>
						<TronButton type="submit" variant="primary">{data.clinic ? 'Move' : 'Enroll'}</TronButton>
					</form>
				{:else if data.canWrite && !data.clinic}
					<p class="tron-text-muted text-xs">No clinic accounts yet. Set an account's type to Clinic to enroll people under it.</p>
				{/if}
			</div>
		{:else if data.accountType === 'clinic'}
			<div class="mt-4 border-t border-[var(--color-tron-border)] pt-4">
				<h4 class="tron-text-primary mb-2 text-sm font-semibold">
					Enrolled accounts
					<span class="ml-2 inline-block rounded-full bg-[var(--color-tron-cyan)] px-2 py-0.5 text-xs text-black">{data.enrolled.length}</span>
				</h4>
				{#if data.enrolled.length === 0}
					<p class="tron-text-muted text-sm">Nobody yet. Enroll an individual account from its own page.</p>
				{:else}
					<div class="overflow-x-auto">
						<table class="tron-table">
							<thead><tr><th>Account</th><th>Cartridges</th><th></th></tr></thead>
							<tbody>
								{#each data.enrolled as e (e.accountId)}
									<tr>
										<td class="text-sm"><a href="/app-accounts/{encodeURIComponent(e.accountId)}" class="text-[var(--color-tron-cyan)] hover:underline">{e.label}</a></td>
										<td class="font-mono">{e.owned}</td>
										<td>
											{#if data.canWrite}
												<form method="POST" action="?/unenroll" use:enhance>
													<input type="hidden" name="enrolledAccountId" value={e.accountId} />
													<button type="submit" class="text-xs text-[var(--color-tron-red)] hover:underline">Remove from clinic</button>
												</form>
											{/if}
										</td>
									</tr>
								{/each}
							</tbody>
						</table>
					</div>
				{/if}
			</div>
		{/if}
	</TronCard>

	<!-- View as (temporary developer door) -->
	{#if data.canWrite}
		<TronCard>
			<h3 class="tron-text-primary mb-3 font-mono text-lg font-bold">Open the app as this account</h3>
			<div class="flex flex-wrap items-center gap-3">
				<!-- Plain form on purpose: the action answers with a redirect to the app, which the new tab follows. -->
				<form method="POST" action="?/viewAs" target="_blank">
					<TronButton type="submit" variant="primary" disabled={!data.viewAs}>Open the Bioscale app as {a.isDev ? 'this dev account' : 'this person'} &nearr;</TronButton>
				</form>
				<p class="tron-text-muted text-xs">
					{#if !data.viewAs}
						Needs CONSUMER_API_KEY and BIOSCALE_APP_URL on this BIMS deployment.
					{:else if a.isDev}
						Opens a normal 30-day session in a new tab: you can edit the profile, add patients, and see results exactly as a user would.
					{:else}
						Opens a read-only, 30-minute session in a new tab with a banner; nothing can be changed on the person's behalf. The sign-in is audit-logged.
					{/if}
				</p>
			</div>
		</TronCard>
	{/if}

	<!-- Block / remove -->
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
		{#if a.isDev}
			<form
				method="POST"
				action="?/deleteDev"
				class="mt-4 border-t border-[var(--color-tron-border)] pt-4"
				onsubmit={(e) => { if (!confirm('Remove this dev account? Its cartridges are released and its customer links revoked.')) e.preventDefault(); }}
			>
				<button type="submit" class="rounded border border-[var(--color-tron-red)] px-3 py-2 text-sm text-[var(--color-tron-red)] hover:bg-[var(--color-tron-red)]/10">Remove dev account</button>
				<span class="tron-text-muted ml-2 text-xs">Releases its cartridges, revokes its links and deletes the account. Real accounts can only be blocked.</span>
			</form>
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
			<p class="tron-text-muted py-2 text-center text-sm">Not linked to any customer. Shipments to a customer reach this account only once it is linked; cartridges can still be assigned below.</p>
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

	{#if data.clinicOwned.length > 0}
		<TronCard>
			<h3 class="tron-text-primary mb-3 font-mono text-lg font-bold">
				Visible through clinic roles
				<span class="ml-2 inline-block rounded-full bg-[var(--color-tron-cyan)] px-2 py-0.5 text-xs text-black">{data.clinicOwned.length}</span>
			</h3>
			{@render cartridgeTable(data.clinicOwned, true)}
		</TronCard>
	{/if}

	<!-- Invites -->
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
</div>
