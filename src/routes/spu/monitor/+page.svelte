<script lang="ts">
	import { enhance } from '$app/forms';
	import { TronCard, TronBadge, TronButton } from '$lib/components/ui';

	let { data, form } = $props();
	let reviewing = $state(false);

	function statusVariant(s: string | null): 'info' | 'success' | 'warning' | 'error' | 'neutral' {
		switch (s) {
			case 'healthy': return 'success';
			case 'watch': return 'warning';
			case 'suspect': return 'error';
			case 'error': return 'error';
			default: return 'neutral';
		}
	}
	function flagText(u: { flagState: string | null; flag: number | null }): string {
		switch (u.flagState) {
			case 'synced': return u.flag === 1 ? 'Device: monitoring' : 'Device: flag clear';
			case 'offline': return 'Device offline — pending';
			case 'unsupported': return 'Firmware < 103';
			case 'unlinked': return 'No device';
			case 'error': return 'Sync error';
			default: return 'Not synced yet';
		}
	}
	function fmt(d: string | null): string {
		return d ? new Date(d).toLocaleString() : '—';
	}
</script>

<svelte:head>
	<title>Device Monitor</title>
</svelte:head>

<div class="space-y-6">
	<div class="flex items-center justify-between">
		<div>
			<h2 class="tron-text-primary font-mono text-2xl font-bold">Device Monitor</h2>
			<p class="tron-text-muted text-sm">Units in monitor mode upload their firmware log after every test, screen, error and boot. Claude reviews each suspect daily (07:30 UTC) against the control units and files findings that never expire.</p>
		</div>
		<form method="POST" action="?/reviewAll" use:enhance={() => { reviewing = true; return async ({ update }) => { reviewing = false; await update(); }; }}>
			<TronButton type="submit" variant="primary" disabled={reviewing || data.units.length === 0} style="min-height: 44px;">{reviewing ? 'Reviewing… (can take a few minutes)' : 'Review all now'}</TronButton>
		</form>
	</div>

	{#if form?.message}
		<div class="rounded border p-3 text-sm" style="border-color: {form.failed ? 'var(--color-tron-yellow, #fbbf24)' : 'var(--color-tron-green)'};">
			{form.message}{form.totalCostUsd != null ? ` — $${form.totalCostUsd}` : ''}
		</div>
	{/if}
	{#if form?.error}
		<div class="rounded border p-3 text-sm" style="border-color: var(--color-tron-red, #ef4444); color: var(--color-tron-red, #ef4444);">{form.error}</div>
	{/if}

	<TronCard>
		{#if data.units.length === 0}
			<p class="tron-text-muted py-6 text-center text-sm">No units in monitor mode. Turn it on from an SPU's Diagnostics page.</p>
		{:else}
			<div class="overflow-x-auto">
				<table class="tron-table">
					<thead>
						<tr>
							<th>Unit</th>
							<th>Role</th>
							<th>Why</th>
							<th>Device flag</th>
							<th>Last review</th>
							<th>Verdict</th>
							<th>Open findings</th>
						</tr>
					</thead>
					<tbody>
						{#each data.units as u}
							<tr>
								<td class="font-mono"><a href="/spu/{u.id}/diagnostics" style="color: var(--color-tron-cyan);">{u.udi}</a><div class="tron-text-muted text-xs">{u.status}</div></td>
								<td><TronBadge variant={u.role === 'control' ? 'info' : 'warning'}>{u.role}</TronBadge></td>
								<td class="text-xs">{u.reason || '—'}<div class="tron-text-muted">since {fmt(u.enabledAt)}{u.enabledBy ? ` by ${u.enabledBy}` : ''}</div></td>
								<td class="text-xs">{flagText(u)}</td>
								<td class="text-xs font-mono">{u.lastReview?.dayKey ?? '—'}</td>
								<td>
									{#if u.lastReview}
										<TronBadge variant={statusVariant(u.lastReview.status)}>{u.lastReview.status}</TronBadge>
										<div class="tron-text-muted text-xs mt-1 max-w-md">{u.lastReview.summary}</div>
									{:else}
										<span class="tron-text-muted text-xs">not reviewed yet</span>
									{/if}
								</td>
								<td class="font-mono">{u.openFindings}{u.openErrors ? ` (${u.openErrors} error)` : ''}</td>
							</tr>
						{/each}
					</tbody>
				</table>
			</div>
		{/if}
	</TronCard>

	{#if data.recentFindings.length > 0}
		<TronCard>
			<h3 class="tron-text-primary font-mono text-lg font-bold mb-3">Open findings</h3>
			<div class="space-y-3">
				{#each data.recentFindings as f}
					<div class="rounded border p-3" style="border-color: var(--color-tron-border);">
						<div class="flex items-center gap-2 flex-wrap">
							<TronBadge variant={f.severity === 'error' ? 'error' : f.severity === 'warning' ? 'warning' : 'info'}>{f.severity}</TronBadge>
							<span class="font-mono text-xs">{f.category}</span>
							<a href="/spu/{f.spuId}/diagnostics" class="font-mono text-xs" style="color: var(--color-tron-cyan);">{f.udi}</a>
							<span class="tron-text-muted text-xs">{f.dayKey}</span>
							<span class="font-medium">{f.title}</span>
						</div>
						<p class="text-sm mt-1">{f.detail}</p>
						<p class="text-xs mt-1" style="color: var(--color-tron-green);">→ {f.recommendation}</p>
					</div>
				{/each}
			</div>
		</TronCard>
	{/if}
</div>
