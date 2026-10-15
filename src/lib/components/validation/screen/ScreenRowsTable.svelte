<script lang="ts">
	import { enhance } from '$app/forms';
	import { TronBadge } from '$lib/components/ui';

	interface Row {
		id: string;
		label: string;
		level: number;
		status: string;
		deviceStatus: string;
		value: number | string | null;
		limit: number | null;
		ms: number;
		note: string | null;
	}
	interface Props {
		rows: Row[];
		levels: Record<string, { name: string; complete: boolean; counts: { pass: number; fail: number; warn: number; skip: number; info: number } }>;
		sessionId: string;
		confirms?: Array<{ id: string; passed: boolean; by: string; at: string }>;
		compact?: boolean;
	}
	let { rows, levels, sessionId, confirms = [], compact = false }: Props = $props();

	const STATUS: Record<string, { label: string; v: 'success' | 'error' | 'warning' | 'neutral' }> = {
		P: { label: 'pass', v: 'success' },
		F: { label: 'FAIL', v: 'error' },
		W: { label: 'warn', v: 'warning' },
		S: { label: 'skip', v: 'neutral' },
		I: { label: 'info', v: 'neutral' }
	};
	const levelKeys = $derived([...new Set([...Object.keys(levels), ...rows.map((r) => String(r.level))])].sort());
	const byLevel = (k: string) => rows.filter((r) => String(r.level) === k);
	const confirmFor = (id: string) => confirms.find((c) => c.id === id) ?? null;
	const fmtMs = (ms: number) => (ms >= 60000 ? `${(ms / 60000).toFixed(1)} min` : ms >= 1000 ? `${(ms / 1000).toFixed(1)} s` : `${ms} ms`);
</script>

<div class="space-y-4">
	{#each levelKeys as k (k)}
		{@const lv = levels[k]}
		{@const lrows = byLevel(k)}
		<div>
			<div class="mb-1 flex flex-wrap items-center gap-2 text-xs">
				<span class="tron-text-primary font-semibold">Level {k} · {lv?.name ?? ''}</span>
				{#if lv}
					<span class="tron-text-muted">{lv.counts.pass} pass · {lv.counts.fail} fail · {lv.counts.warn} warn · {lv.counts.skip} skip{lv.complete ? '' : ' · still running'}</span>
				{/if}
			</div>
			{#if lrows.length === 0}
				<p class="tron-text-muted text-xs">Waiting for the device…</p>
			{:else}
				<table class="w-full text-xs">
					<thead class="text-[10px] uppercase text-[var(--color-tron-text-secondary)]">
						<tr class="border-b border-[var(--color-tron-border)]">
							<th class="py-1 pr-3 text-left font-medium">Test</th>
							<th class="py-1 pr-3 text-left font-medium">Status</th>
							<th class="py-1 pr-3 text-left font-medium">Value</th>
							<th class="py-1 pr-3 text-left font-medium">Limit</th>
							<th class="py-1 pr-3 text-left font-medium">Time</th>
							{#if !compact}<th class="py-1 text-left font-medium">Note</th>{/if}
						</tr>
					</thead>
					<tbody>
						{#each lrows as r (r.id + r.level)}
							{@const st = STATUS[r.status] ?? STATUS.I}
							{@const c = r.id === 'buzz' || r.id === 'led' ? confirmFor(r.id) : null}
							<tr class="border-b border-[var(--color-tron-border)]/40">
								<td class="py-1 pr-3"><span class="tron-text-primary">{r.label}</span> <span class="tron-text-muted font-mono">{r.id}</span></td>
								<td class="py-1 pr-3">
									<TronBadge variant={st.v}>{st.label}</TronBadge>
									{#if r.deviceStatus !== r.status}<span class="tron-text-muted ml-1 text-[10px]" title="The device reported this status; BIMS criteria changed it">dev {STATUS[r.deviceStatus]?.label ?? r.deviceStatus}</span>{/if}
									{#if r.id === 'buzz' || r.id === 'led'}
										{#if c}
											<span class="ml-2 text-[10px] {c.passed ? 'text-[var(--color-tron-green)]' : 'text-[var(--color-tron-red)]'}">operator: {c.passed ? 'confirmed' : 'NOT seen/heard'} ({c.by})</span>
										{:else}
											<form method="POST" action="/validation/screen?/confirm" use:enhance class="ml-2 inline-flex gap-1">
												<input type="hidden" name="sessionId" value={sessionId} />
												<input type="hidden" name="id" value={r.id} />
												<button type="submit" name="passed" value="1" class="rounded border border-[var(--color-tron-green)] px-1.5 text-[10px] text-[var(--color-tron-green)]">{r.id === 'buzz' ? 'heard it' : 'saw it'}</button>
												<button type="submit" name="passed" value="0" class="rounded border border-[var(--color-tron-red)] px-1.5 text-[10px] text-[var(--color-tron-red)]">no</button>
											</form>
										{/if}
									{/if}
								</td>
								<td class="py-1 pr-3 font-mono">{r.value ?? '—'}</td>
								<td class="py-1 pr-3 font-mono tron-text-muted">{r.limit ?? '—'}</td>
								<td class="py-1 pr-3 font-mono tron-text-muted">{fmtMs(r.ms)}</td>
								{#if !compact}<td class="py-1 tron-text-muted">{r.note ?? ''}</td>{/if}
							</tr>
						{/each}
					</tbody>
				</table>
			{/if}
		</div>
	{/each}
</div>
