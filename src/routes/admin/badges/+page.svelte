<script lang="ts">
	import { enhance } from '$app/forms';

	type Badge = {
		badgeId: string; code: string; userId: string; username: string | null; displayName: string;
		status: 'active' | 'revoked'; issuedAt: string | null; issuedBy: string | null;
		revokedAt: string | null; revokedBy: string | null; revokeReason: string | null;
		lastUsedAt: string | null; printCount: number;
	};
	type Result = { success?: boolean; error?: string; code?: string | null; badge?: Badge; settings?: { mode: 'off' | 'required'; changedAt: string | null; changedBy: string | null } };
	interface Props {
		data: {
			badges: Badge[];
			settings: { mode: 'off' | 'required'; changedAt: string | null; changedBy: string | null };
			candidates: { id: string; username: string; defaultName: string }[];
		};
		form: { issue?: Result; revoke?: Result; reissue?: Result; setBadgeMode?: Result } | null;
	}
	let { data, form }: Props = $props();

	let busy = $state(false);
	let userId = $state('');
	let displayName = $state('');
	let revoking = $state<string | null>(null);
	let revokeReason = $state('');
	let modeReason = $state('');

	const required = $derived(data.settings.mode === 'required');
	const active = $derived(data.badges.filter(b => b.status === 'active'));
	const revoked = $derived(data.badges.filter(b => b.status === 'revoked'));
	// The row just issued / reissued, so the admin can go straight to Print.
	const justIssued = $derived(form?.issue?.badge ?? form?.reissue?.badge ?? null);

	function onUserChange() {
		const c = data.candidates.find(x => x.id === userId);
		if (c) displayName = c.defaultName;
	}
	function fmt(iso: string | null): string {
		return iso ? new Date(iso).toLocaleString() : '—';
	}
	const enhanceBusy = () => {
		busy = true;
		return async ({ update }: { update: (o?: { reset?: boolean }) => Promise<void> }) => {
			await update({ reset: false });
			busy = false;
		};
	};

	const inputCls = 'mt-1 w-full rounded border border-[var(--color-tron-border)] bg-[var(--color-tron-bg-primary)] px-3 py-2 text-sm text-[var(--color-tron-text)] focus:border-[var(--color-tron-cyan)] focus:outline-none';
	const btnGhost = 'rounded border border-[var(--color-tron-border)] px-3 py-1.5 text-xs text-[var(--color-tron-text-secondary)] hover:border-[var(--color-tron-cyan)]/60 disabled:opacity-40';
</script>

<div class="space-y-5">
	<div>
		<h3 class="text-base font-semibold text-[var(--color-tron-text)]">Badge Portal</h3>
		<p class="text-xs text-[var(--color-tron-text-secondary)]">Printed QR badges that identify who is at the scan box. Bucket mint and start-pass ask for one; later steps do not.</p>
	</div>

	<!-- Require badge switch (§17.5) — admin only; the whole page is admin only. -->
	<form method="POST" action="?/setBadgeMode" use:enhance={enhanceBusy}
		class="rounded-lg border p-4 {required ? 'border-[var(--color-tron-cyan)]/50 bg-[var(--color-tron-cyan)]/5' : 'border-[var(--color-tron-yellow)]/50 bg-[var(--color-tron-yellow)]/5'}">
		<input type="hidden" name="mode" value={required ? 'off' : 'required'} />
		<div class="flex flex-wrap items-center justify-between gap-3">
			<div>
				<p class="text-sm font-semibold text-[var(--color-tron-text)]">
					Require badge at mint and start-pass:
					<span class={required ? 'text-[var(--color-tron-cyan)]' : 'text-[var(--color-tron-yellow)]'}>{required ? 'ON' : 'OFF'}</span>
				</p>
				<p class="text-[11px] text-[var(--color-tron-text-secondary)]">
					{#if required}Operators must scan a badge to mint a bucket or start a pass. Turning this off makes the login session the operator, as before.
					{:else}Badge scans are optional; the login session is recorded as the operator. Turn this on to require a badge again.{/if}
					{#if data.settings.changedAt}<span class="ml-1">Last changed {fmt(data.settings.changedAt)}{data.settings.changedBy ? ` by ${data.settings.changedBy}` : ''}.</span>{/if}
				</p>
			</div>
			<div class="flex items-center gap-2">
				<input type="text" name="reason" bind:value={modeReason} placeholder="reason (optional)" autocomplete="off" class="w-44 rounded border border-[var(--color-tron-border)] bg-[var(--color-tron-bg-primary)] px-2 py-1.5 text-xs text-[var(--color-tron-text)]" />
				<button type="submit" disabled={busy}
					role="switch" aria-checked={required}
					class="relative inline-flex h-7 w-14 items-center rounded-full border transition-colors {required ? 'border-[var(--color-tron-cyan)] bg-[var(--color-tron-cyan)]/60' : 'border-[var(--color-tron-border)] bg-[var(--color-tron-bg-primary)]'} disabled:opacity-40"
					title={required ? 'Turn badge requirement off' : 'Turn badge requirement on'}>
					<span class="inline-block h-5 w-5 rounded-full bg-[var(--color-tron-text)] transition-transform {required ? 'translate-x-8' : 'translate-x-1'}"></span>
				</button>
			</div>
		</div>
		{#if form?.setBadgeMode?.error}<p class="mt-2 text-xs text-[var(--color-tron-error)]">{form.setBadgeMode.error}</p>{/if}
	</form>

	<!-- Issue -->
	<form method="POST" action="?/issue" use:enhance={() => { busy = true; return async ({ update }) => { await update({ reset: false }); busy = false; userId = ''; displayName = ''; }; }}
		class="rounded-lg border border-[var(--color-tron-border)] bg-[var(--color-tron-surface)] p-4">
		<p class="text-sm font-medium text-[var(--color-tron-text)]">Issue a badge</p>
		<p class="text-[11px] text-[var(--color-tron-text-secondary)]">One active badge per person. The name below is what gets printed.</p>
		<div class="mt-3 grid gap-3 md:grid-cols-[1fr_1fr_auto] md:items-end">
			<label class="block">
				<span class="text-[10px] uppercase tracking-wider text-[var(--color-tron-text-secondary)]">User</span>
				<select name="userId" bind:value={userId} onchange={onUserChange} required class={inputCls}>
					<option value="">{data.candidates.length ? '— Select user —' : 'Every active user already has a badge'}</option>
					{#each data.candidates as c (c.id)}<option value={c.id}>{c.username}{c.defaultName !== c.username ? ` — ${c.defaultName}` : ''}</option>{/each}
				</select>
			</label>
			<label class="block">
				<span class="text-[10px] uppercase tracking-wider text-[var(--color-tron-text-secondary)]">Name on badge</span>
				<input type="text" name="displayName" bind:value={displayName} autocomplete="off" placeholder="First Last" class={inputCls} />
			</label>
			<button type="submit" disabled={busy || !userId} class="min-h-[38px] rounded border border-[var(--color-tron-cyan)]/50 bg-[var(--color-tron-cyan)]/20 px-4 py-2 text-sm font-medium text-[var(--color-tron-cyan)] disabled:opacity-40">
				{busy ? 'Issuing…' : 'Issue badge'}
			</button>
		</div>
		{#if form?.issue?.error}<p class="mt-2 text-xs text-[var(--color-tron-error)]">{form.issue.error}</p>{/if}
		{#if form?.reissue?.error}<p class="mt-2 text-xs text-[var(--color-tron-error)]">{form.reissue.error}</p>{/if}
		{#if form?.revoke?.error}<p class="mt-2 text-xs text-[var(--color-tron-error)]">{form.revoke.error}</p>{/if}
		{#if justIssued}
			<p class="mt-3 rounded border border-green-500/40 bg-green-900/15 p-2 text-xs text-green-300">
				Badge <span class="font-mono">{justIssued.code}</span> issued to <strong>{justIssued.displayName}</strong>.
				<a href="/admin/badges/{justIssued.badgeId}/print" class="ml-2 underline">Print it →</a>
			</p>
		{/if}
	</form>

	<!-- Active badges -->
	<div class="overflow-x-auto rounded border border-[var(--color-tron-border)]">
		<table class="w-full text-sm">
			<thead>
				<tr class="border-b border-[var(--color-tron-border)] bg-[var(--color-tron-surface)] text-left text-[10px] uppercase tracking-wider text-[var(--color-tron-text-secondary)]">
					<th class="px-3 py-2">Name</th><th class="px-3 py-2">User</th><th class="px-3 py-2">Code</th><th class="px-3 py-2">Issued</th><th class="px-3 py-2">Last used</th><th class="px-3 py-2">Prints</th><th class="px-3 py-2 text-right">Actions</th>
				</tr>
			</thead>
			<tbody>
				{#if active.length === 0}
					<tr><td colspan="7" class="px-3 py-4 text-center text-xs text-[var(--color-tron-text-secondary)]">No active badges yet.</td></tr>
				{/if}
				{#each active as b (b.badgeId)}
					<tr class="border-b border-[var(--color-tron-border)]/40 {justIssued?.badgeId === b.badgeId ? 'bg-green-900/10' : ''}">
						<td class="px-3 py-2 font-medium text-[var(--color-tron-text)]">{b.displayName}</td>
						<td class="px-3 py-2 text-[var(--color-tron-text-secondary)]">{b.username ?? b.userId}</td>
						<td class="px-3 py-2 font-mono text-[var(--color-tron-text)]">{b.code}</td>
						<td class="px-3 py-2 text-xs text-[var(--color-tron-text-secondary)]">{fmt(b.issuedAt)}{b.issuedBy ? ` · ${b.issuedBy}` : ''}</td>
						<td class="px-3 py-2 text-xs text-[var(--color-tron-text-secondary)]">{fmt(b.lastUsedAt)}</td>
						<td class="px-3 py-2 text-xs text-[var(--color-tron-text-secondary)]">{b.printCount}</td>
						<td class="px-3 py-2">
							<div class="flex justify-end gap-2">
								<a href="/admin/badges/{b.badgeId}/print" class="rounded border border-[var(--color-tron-cyan)]/50 px-3 py-1.5 text-xs text-[var(--color-tron-cyan)] hover:bg-[var(--color-tron-cyan)]/10">Print</a>
								<form method="POST" action="?/reissue" use:enhance={enhanceBusy}>
									<input type="hidden" name="badgeId" value={b.badgeId} />
									<button type="submit" disabled={busy} class={btnGhost} title="Revoke this code and print a new one for the same person">Reissue</button>
								</form>
								<button type="button" class="{btnGhost} text-red-300" onclick={() => { revoking = revoking === b.badgeId ? null : b.badgeId; revokeReason = ''; }}>Revoke…</button>
							</div>
							{#if revoking === b.badgeId}
								<form method="POST" action="?/revoke" use:enhance={() => { busy = true; return async ({ update }) => { await update({ reset: false }); busy = false; revoking = null; }; }} class="mt-2 flex justify-end gap-2">
									<input type="hidden" name="badgeId" value={b.badgeId} />
									<input type="text" name="reason" bind:value={revokeReason} placeholder="why?" required autocomplete="off" class="w-48 rounded border border-[var(--color-tron-border)] bg-[var(--color-tron-bg-primary)] px-2 py-1 text-xs text-[var(--color-tron-text)]" />
									<button type="submit" disabled={busy || !revokeReason.trim()} class="rounded border border-red-500/50 px-3 py-1 text-xs text-red-300 hover:bg-red-900/20 disabled:opacity-40">Confirm revoke</button>
								</form>
							{/if}
						</td>
					</tr>
				{/each}
			</tbody>
		</table>
	</div>

	{#if revoked.length > 0}
		<details class="rounded-lg border border-[var(--color-tron-border)] bg-[var(--color-tron-surface)] p-3">
			<summary class="cursor-pointer text-sm font-medium text-[var(--color-tron-text)]">Revoked ({revoked.length})</summary>
			<table class="mt-3 w-full text-xs">
				<thead>
					<tr class="border-b border-[var(--color-tron-border)] text-left text-[10px] uppercase tracking-wider text-[var(--color-tron-text-secondary)]">
						<th class="px-2 py-1">Name</th><th class="px-2 py-1">User</th><th class="px-2 py-1">Code</th><th class="px-2 py-1">Revoked</th><th class="px-2 py-1">Reason</th>
					</tr>
				</thead>
				<tbody>
					{#each revoked as b (b.badgeId)}
						<tr class="border-b border-[var(--color-tron-border)]/40 text-[var(--color-tron-text-secondary)]">
							<td class="px-2 py-1">{b.displayName}</td>
							<td class="px-2 py-1">{b.username ?? b.userId}</td>
							<td class="px-2 py-1 font-mono line-through">{b.code}</td>
							<td class="px-2 py-1">{fmt(b.revokedAt)}{b.revokedBy ? ` · ${b.revokedBy}` : ''}</td>
							<td class="px-2 py-1">{b.revokeReason ?? '—'}</td>
						</tr>
					{/each}
				</tbody>
			</table>
		</details>
	{/if}
</div>
