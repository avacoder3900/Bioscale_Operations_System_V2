<script lang="ts">
	import { enhance } from '$app/forms';

	let { data, form } = $props();

	let confirmingDelete = $state(false);

	function statusColor(status: string): string {
		if (status === 'online') return 'var(--color-tron-green,#39ff14)';
		if (status === 'degraded') return 'var(--color-tron-yellow,#facc15)';
		return 'var(--color-tron-red,#ff3366)';
	}

	function relativeTime(iso: string | null): string {
		if (!iso) return '—';
		const then = new Date(iso).getTime();
		const ms = Date.now() - then;
		if (ms < 0) return 'in the future';
		if (ms < 5_000) return 'just now';
		if (ms < 60_000) return `${Math.floor(ms / 1000)} s ago`;
		if (ms < 3_600_000) return `${Math.floor(ms / 60_000)} min ago`;
		if (ms < 86_400_000) return `${Math.floor(ms / 3_600_000)} h ago`;
		return `${Math.floor(ms / 86_400_000)} d ago`;
	}

	function summarizeAudit(a: any): string {
		const parts: string[] = [];
		if (a.reason) parts.push(a.reason);
		if (Array.isArray(a.changedFields) && a.changedFields.length > 0) {
			parts.push(`(${a.changedFields.join(', ')})`);
		}
		return parts.join(' ') || a.action || '—';
	}
</script>

<div class="space-y-6">
	<div class="flex items-start justify-between gap-4">
		<div>
			<div class="text-xs text-[var(--color-tron-text-secondary)]">
				<a href="/cv/stations" class="hover:underline">← back to stations</a>
			</div>
			<h1 class="mt-1 text-2xl font-bold text-[var(--color-tron-cyan)]">
				{data.station.name}
			</h1>
			<p class="font-mono text-xs text-[var(--color-tron-text-secondary)]">
				{data.station.hostname}
			</p>
		</div>
		<div class="text-right">
			<div class="flex items-center justify-end gap-2">
				<span
					class="inline-block h-2 w-2 rounded-full"
					style="background:{statusColor(data.station.status)}"
				></span>
				<span style="color:{statusColor(data.station.status)}">{data.station.status}</span>
			</div>
			<div class="mt-1 text-xs text-[var(--color-tron-text-secondary)]">
				last seen {relativeTime(data.station.lastSeenAt)}
			</div>
		</div>
	</div>

	{#if form?.error}
		<div class="rounded border border-[var(--color-tron-red,#ff3366)] bg-[rgba(255,51,102,0.08)] p-3 text-sm text-[var(--color-tron-red,#ff3366)]">
			{form.error}
		</div>
	{/if}

	{#if form?.action === 'rotateSecret' && form?.jwtSecret}
		<div class="rounded border border-[var(--color-tron-yellow,#facc15)] bg-[rgba(250,204,21,0.08)] p-4 text-sm">
			<div class="font-semibold text-[var(--color-tron-yellow,#facc15)]">
				⚠ New JWT secret minted — copy it now.
			</div>
			<p class="mt-1 text-xs text-[var(--color-tron-text-secondary)]">
				You won't see this again. Paste it into the Pi's <code>/etc/bims/station.env</code> as
				<code>STATION_JWT_SECRET</code> and restart the agent (
				<code>sudo systemctl restart bims-capture-agent</code>).
			</p>
			<pre class="mt-2 overflow-x-auto rounded bg-[var(--color-tron-bg-tertiary)] p-2 font-mono text-xs">{form.jwtSecret}</pre>
		</div>
	{/if}

	<!-- Identity + heartbeat snapshot -->
	<div class="grid gap-4 md:grid-cols-2">
		<div class="rounded-lg border border-[var(--color-tron-border)] bg-[var(--color-tron-bg-secondary)] p-4">
			<h2 class="text-sm font-semibold uppercase text-[var(--color-tron-text-secondary)]">
				Identity
			</h2>
			<dl class="mt-3 grid grid-cols-[max-content_1fr] gap-x-4 gap-y-1 text-xs">
				<dt class="text-[var(--color-tron-text-secondary)]">Station ID</dt>
				<dd class="font-mono">{data.station.id}</dd>
				<dt class="text-[var(--color-tron-text-secondary)]">Location</dt>
				<dd>{data.station.location ?? '—'}</dd>
				<dt class="text-[var(--color-tron-text-secondary)]">IP address</dt>
				<dd class="font-mono">{data.station.ipAddress ?? '—'}</dd>
				<dt class="text-[var(--color-tron-text-secondary)]">Mode</dt>
				<dd>{data.station.mode}{data.station.assignedPhase ? ` → ${data.station.assignedPhase}` : ''}</dd>
				<dt class="text-[var(--color-tron-text-secondary)]">Created</dt>
				<dd>{relativeTime(data.station.createdAt)}</dd>
			</dl>
		</div>

		<div class="rounded-lg border border-[var(--color-tron-border)] bg-[var(--color-tron-bg-secondary)] p-4">
			<h2 class="text-sm font-semibold uppercase text-[var(--color-tron-text-secondary)]">
				Last heartbeat
			</h2>
			<dl class="mt-3 grid grid-cols-[max-content_1fr] gap-x-4 gap-y-1 text-xs">
				<dt class="text-[var(--color-tron-text-secondary)]">Agent version</dt>
				<dd class="font-mono">{data.station.agentVersion ?? '—'}</dd>
				<dt class="text-[var(--color-tron-text-secondary)]">Camera</dt>
				<dd style="color:{data.station.health?.cameraOk ? statusColor('online') : statusColor('offline')}">
					{data.station.health?.cameraOk ? '✓ ok' : '✗ unavailable'}
				</dd>
				<dt class="text-[var(--color-tron-text-secondary)]">Scanner</dt>
				<dd style="color:{data.station.health?.scannerOk ? statusColor('online') : statusColor('offline')}">
					{data.station.health?.scannerOk ? '✓ ok' : '✗ unavailable'}
				</dd>
				<dt class="text-[var(--color-tron-text-secondary)]">Uptime</dt>
				<dd>{data.station.health?.uptimeS ?? 0} s</dd>
				<dt class="text-[var(--color-tron-text-secondary)]">agentReportedAt</dt>
				<dd>{relativeTime(data.station.agentReportedAt)}</dd>
				<dt class="text-[var(--color-tron-text-secondary)]">Stored status</dt>
				<dd>{data.station.storedStatus ?? '—'}</dd>
			</dl>
		</div>
	</div>

	<!-- Operator lock -->
	<div class="rounded-lg border border-[var(--color-tron-border)] bg-[var(--color-tron-bg-secondary)] p-4">
		<h2 class="text-sm font-semibold uppercase text-[var(--color-tron-text-secondary)]">
			Operator lock
		</h2>
		{#if data.station.currentOperator}
			<div class="mt-3 flex items-center justify-between gap-4">
				<div class="text-sm">
					<span class="text-[var(--color-tron-cyan)]">{data.station.currentOperator.username}</span>
					<span class="text-[var(--color-tron-text-secondary)]">
						holds since {relativeTime(data.station.currentOperator.since)}
					</span>
				</div>
				<form method="POST" action="?/forceRelease" use:enhance>
					<button
						type="submit"
						class="rounded border border-[var(--color-tron-red,#ff3366)] px-3 py-1 text-xs text-[var(--color-tron-red,#ff3366)] hover:bg-[rgba(255,51,102,0.08)]"
					>
						Force release
					</button>
				</form>
			</div>
		{:else}
			<p class="mt-3 text-xs text-[var(--color-tron-text-secondary)]">Free — no operator currently holds this station.</p>
		{/if}
	</div>

	<!-- Rename -->
	<div class="rounded-lg border border-[var(--color-tron-border)] bg-[var(--color-tron-bg-secondary)] p-4">
		<h2 class="text-sm font-semibold uppercase text-[var(--color-tron-text-secondary)]">Rename / move</h2>
		<form method="POST" action="?/rename" use:enhance class="mt-3 grid gap-3 md:grid-cols-3">
			<div>
				<label for="r-name" class="mb-1 block text-xs uppercase text-[var(--color-tron-text-secondary)]">Name</label>
				<input id="r-name" name="name" type="text" required value={data.station.name} class="tron-input w-full" />
			</div>
			<div>
				<label for="r-loc" class="mb-1 block text-xs uppercase text-[var(--color-tron-text-secondary)]">Location</label>
				<input id="r-loc" name="location" type="text" value={data.station.location ?? ''} placeholder="e.g. Wax bench 1" class="tron-input w-full" />
			</div>
			<div class="flex items-end">
				<button type="submit" class="rounded bg-[var(--color-tron-cyan)] px-4 py-2 text-sm font-medium text-[var(--color-tron-bg-primary)]">
					Save
				</button>
			</div>
		</form>
	</div>

	<!-- Rotate secret -->
	<div class="rounded-lg border border-[var(--color-tron-border)] bg-[var(--color-tron-bg-secondary)] p-4">
		<h2 class="text-sm font-semibold uppercase text-[var(--color-tron-text-secondary)]">JWT secret</h2>
		<p class="mt-2 text-xs text-[var(--color-tron-text-secondary)]">
			The HS256 secret BIMS signs browser→Pi auth tokens with. Rotating returns a new secret once; you'll
			need to paste it into <code>/etc/bims/station.env</code> on the Pi and restart the agent or
			browser-issued tokens will start failing within ~5 min.
		</p>
		<form method="POST" action="?/rotateSecret" use:enhance class="mt-3">
			<button type="submit" class="rounded border border-[var(--color-tron-yellow,#facc15)] px-3 py-1 text-xs text-[var(--color-tron-yellow,#facc15)] hover:bg-[rgba(250,204,21,0.08)]">
				Rotate JWT secret
			</button>
		</form>
	</div>

	<!-- Audit log (story D4) -->
	<div class="rounded-lg border border-[var(--color-tron-border)] bg-[var(--color-tron-bg-secondary)] p-4">
		<h2 class="text-sm font-semibold uppercase text-[var(--color-tron-text-secondary)]">
			Audit log (last 50)
		</h2>
		{#if data.audit.length === 0}
			<p class="mt-2 text-xs text-[var(--color-tron-text-secondary)]">No audit entries yet.</p>
		{:else}
			<table class="mt-3 w-full text-left text-xs">
				<thead class="text-[var(--color-tron-text-secondary)]">
					<tr class="border-b border-[var(--color-tron-border)]">
						<th class="py-2 pr-3">When</th>
						<th class="py-2 pr-3">Action</th>
						<th class="py-2 pr-3">Who</th>
						<th class="py-2 pr-3">Reason / fields</th>
					</tr>
				</thead>
				<tbody>
					{#each data.audit as a (a.id)}
						<tr class="border-b border-[var(--color-tron-border)]">
							<td class="py-1 pr-3" title={a.changedAt ?? ''}>{relativeTime(a.changedAt)}</td>
							<td class="py-1 pr-3 font-mono">{a.action}</td>
							<td class="py-1 pr-3">{a.changedBy}</td>
							<td class="py-1 pr-3">{summarizeAudit(a)}</td>
						</tr>
					{/each}
				</tbody>
			</table>
		{/if}
	</div>

	<!-- Danger zone -->
	<div class="rounded-lg border border-[var(--color-tron-red,#ff3366)] bg-[rgba(255,51,102,0.04)] p-4">
		<h2 class="text-sm font-semibold uppercase text-[var(--color-tron-red,#ff3366)]">Danger zone</h2>
		<p class="mt-2 text-xs text-[var(--color-tron-text-secondary)]">
			Deregistering removes the station from BIMS. The Pi will keep running its agent but stop appearing
			in the <code>/capture</code> dropdown. Re-register by running <code>setup-station.sh</code> on the Pi.
		</p>
		{#if confirmingDelete}
			<form method="POST" action="?/deregister" use:enhance class="mt-3 flex items-center gap-3">
				<span class="text-xs text-[var(--color-tron-red,#ff3366)]">Are you sure?</span>
				<button type="submit" class="rounded bg-[var(--color-tron-red,#ff3366)] px-3 py-1 text-xs font-medium text-white">
					Yes, deregister
				</button>
				<button type="button" onclick={() => (confirmingDelete = false)} class="text-xs text-[var(--color-tron-text-secondary)] underline">
					cancel
				</button>
			</form>
		{:else}
			<button
				type="button"
				onclick={() => (confirmingDelete = true)}
				class="mt-3 rounded border border-[var(--color-tron-red,#ff3366)] px-3 py-1 text-xs text-[var(--color-tron-red,#ff3366)] hover:bg-[rgba(255,51,102,0.08)]"
			>
				Deregister station
			</button>
		{/if}
	</div>
</div>
