<script lang="ts">
	import { enhance } from '$app/forms';
	import { invalidateAll } from '$app/navigation';

	type BenchType = 'laser' | 'dark' | 'laser_scan';
	interface Chan { c: 'A' | 'B' | 'C'; pd?: number; pd0?: number; f?: number[]; pts?: number[][] }
	interface Result { seq?: number; kind?: string; pos?: number; gain?: number; astep?: number; atime?: number; ms?: number; temp?: number; start?: number; end?: number; step?: number; ch?: Chan[]; error?: string }
	interface Props {
		data: {
			bench: { posUm: number; gain: number; astep: number; atime: number; positionLimitUm: number; maxScanPoints: number };
			spus: Array<{ id: string; udi: string; status: string; deviceId: string | null }>;
			history: Array<{ id: string; type: BenchType; spuId: string | null; spuUdi: string | null; by: string | null; at: string | null; result: Result | null }>;
			batches: Batch[];
		};
		form: { error?: string; ran?: boolean; type?: BenchType; spuUdi?: string; result?: Result } | null;
	}
	type RowState = 'queued' | 'running' | 'done' | 'failed' | 'skipped';
	interface BatchRow { id?: string; spuId: string | null; spuUdi: string | null; ok: boolean; error: string | null; at: string | null; result: Result | null }
	interface Batch { id: string; type: BenchType; by: string | null; startedAt: string | null; finishedAt: string | null; rows: BatchRow[] }
	let { data, form }: Props = $props();

	const BANDS = ['F1 405–425', 'F2 435–455', 'F3 470–490', 'F4 505–525', 'F5 545–565', 'F6 580–600', 'F7 620–640', 'F8 670–690', 'Clear', 'NIR'];
	const TYPE_LABEL: Record<BenchType, string> = { laser: 'Laser into sensor', dark: 'Dark read', laser_scan: 'Find laser position (scan)' };
	const CH_COLOR: Record<string, string> = { A: 'var(--color-tron-cyan)', B: 'var(--color-tron-orange)', C: 'var(--color-tron-purple)' };

	const fw = $derived(data.bench);
	let spuId = $state('');
	let type = $state<BenchType>('laser');
	// Scan defaults: the last 4.4 mm up to the firmware's ceiling, 12 points.
	let start = $state(fw.positionLimitUm - 4400);
	let end = $state(fw.positionLimitUm);
	let stepUm = $state(400);
	let running = $state(false);
	let filterUdi = $state('');

	const scanPoints = $derived(stepUm > 0 ? Math.floor((end - start) / stepUm) + 1 : 0);
	const scanTooHigh = $derived(end > fw.positionLimitUm);
	const scanBad = $derived(type === 'laser_scan' && (scanPoints > fw.maxScanPoints || scanTooHigh || scanPoints < 1));

	const when = (iso: string | null) => (iso ? new Date(iso).toLocaleString() : '—');
	const shown = $derived(filterUdi ? data.history.filter((h) => h.spuUdi === filterUdi) : data.history);

	// Scan chart: photodiode vs position per channel (inline SVG).
	const W = 640, H = 200, P = { l: 44, r: 12, t: 12, b: 28 };
	function scanChart(r: Result | null | undefined) {
		if (!r?.ch?.length) return null;
		const pts = r.ch.flatMap((c) => (c.pts ?? []).map((p) => ({ c: c.c, x: p[0], y: p[1] })));
		if (pts.length < 2) return null;
		const xs = pts.map((p) => p.x), ys = pts.map((p) => p.y);
		const x0 = Math.min(...xs), x1 = Math.max(...xs), y1 = Math.max(...ys, 1);
		const X = (x: number) => P.l + ((x - x0) / (x1 - x0 || 1)) * (W - P.l - P.r);
		const Y = (y: number) => P.t + (1 - y / y1) * (H - P.t - P.b);
		return {
			x0, x1, y1,
			lines: r.ch.map((c) => ({ c: c.c, d: (c.pts ?? []).map((p, i) => `${i ? 'L' : 'M'}${X(p[0]).toFixed(1)},${Y(p[1]).toFixed(1)}`).join(' '), dots: (c.pts ?? []).map((p) => ({ cx: X(p[0]), cy: Y(p[1]), pos: p[0], pd: p[1], clear: p[2] })), peak: (c.pts ?? []).reduce((b, p) => (p[1] > (b?.[1] ?? -1) ? p : b), null as number[] | null) }))
		};
	}

	// ── Fleet run: the same read on every unit, one request per unit ──────────
	// A read blocks up to ~36 s server-side, so the page fans out (CONCURRENCY at
	// a time) instead of one long request. Each session is tagged with batchId.
	const CONCURRENCY = 4;
	let fleetConfirm = $state(false);
	let fleetRunning = $state(false);
	let fleetStop = $state(false);
	let skipOffline = $state(true);
	let fleetId = $state<string | null>(null);
	let fleetType = $state<BenchType>('laser');
	let fleetNote = $state<string | null>(null);
	let fleet = $state<Array<{ spuId: string; udi: string; state: RowState; error: string | null; result: Result | null }>>([]);
	const fleetCounts = $derived({
		done: fleet.filter((r) => r.state === 'done').length,
		failed: fleet.filter((r) => r.state === 'failed').length,
		skipped: fleet.filter((r) => r.state === 'skipped').length,
		pending: fleet.filter((r) => r.state === 'queued' || r.state === 'running').length
	});

	function newBatchId() {
		const d = new Date();
		const p = (n: number) => String(n).padStart(2, '0');
		const rnd = Math.random().toString(36).slice(2, 6).toUpperCase();
		return `BENCH-${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}-${rnd}`;
	}

	async function runFleet() {
		fleetConfirm = false;
		fleetRunning = true;
		fleetStop = false;
		fleetNote = null;
		fleetType = type;
		const batchId = newBatchId();
		fleetId = batchId;
		fleet = data.spus.map((s) => ({ spuId: s.id, udi: s.udi, state: 'queued' as RowState, error: null, result: null }));

		// One Particle call for the whole fleet's connectivity. If it fails, try every unit.
		let online: Record<string, boolean> | null = null;
		if (skipOffline) {
			try {
				const res = await fetch('/api/particle/status');
				if (!res.ok) throw new Error();
				const body = await res.json();
				online = Object.fromEntries(Object.entries(body.devices ?? {}).map(([id, d]) => [id, !!(d as { online?: boolean }).online]));
			} catch {
				fleetNote = 'Could not read fleet connectivity — trying every unit.';
			}
		}

		const params = { batchId, type: fleetType, start, end, stepUm };
		let next = 0;
		const worker = async () => {
			while (!fleetStop) {
				const i = next++;
				if (i >= fleet.length) return;
				const row = fleet[i];
				const unit = data.spus.find((s) => s.id === row.spuId);
				const offline = online !== null && !(unit?.deviceId && online[unit.deviceId]);
				row.state = 'running';
				try {
					const res = await fetch('/api/validation/bench/run', {
						method: 'POST',
						headers: { 'content-type': 'application/json' },
						body: JSON.stringify({ ...params, spuId: row.spuId, ...(offline ? { skipReason: 'Particle reports the device offline' } : {}) })
					});
					const body = await res.json().catch(() => ({ ok: false, error: `HTTP ${res.status}` }));
					if (body.ok) {
						row.state = 'done';
						row.result = body.result ?? null;
					} else {
						row.state = body.skipped ? 'skipped' : 'failed';
						row.error = body.error ?? `HTTP ${res.status}`;
					}
				} catch (err) {
					row.state = 'failed';
					row.error = err instanceof Error ? err.message : String(err);
				}
			}
		};
		await Promise.all(Array.from({ length: Math.min(CONCURRENCY, fleet.length) }, worker));
		for (const r of fleet) {
			if (r.state === 'queued') {
				r.state = 'skipped';
				r.error = 'Stopped before it ran';
			}
		}
		fleetRunning = false;
		await invalidateAll();
	}

	// Long-format CSV: one row per unit × channel (× scan point for scans).
	function batchCsv(b: { id: string; type: BenchType; rows: BatchRow[] }) {
		const head = ['batch', 'unit', 'status', 'error', 'read', 'at', 'seq', 'pos_um', 'gain', 'astep', 'atime', 'temp_c', 'channel', 'pd', 'pd_dark', 'f1', 'f2', 'f3', 'f4', 'f5', 'f6', 'f7', 'f8', 'clear', 'nir', 'scan_pos_um', 'scan_pd', 'scan_clear'];
		const esc = (v: unknown) => {
			const t = v === null || v === undefined ? '' : String(v);
			return /[",\n]/.test(t) ? `"${t.replace(/"/g, '""')}"` : t;
		};
		const lines = [head.join(',')];
		for (const row of b.rows) {
			const r = row.result;
			const base = [b.id, row.spuUdi, row.ok ? 'ok' : 'failed', row.error, b.type, row.at, r?.seq, r?.pos, r?.gain, r?.astep, r?.atime, r?.temp != null ? (r.temp / 10).toFixed(1) : ''];
			if (!row.ok || !r?.ch?.length) {
				lines.push([...base, ...Array(head.length - base.length).fill('')].map(esc).join(','));
				continue;
			}
			for (const c of r.ch) {
				const chCols = [c.c, c.pd, c.pd0, ...Array.from({ length: 10 }, (_, k) => c.f?.[k])];
				if (r.kind === 'scan' && c.pts?.length) {
					for (const pt of c.pts) lines.push([...base, ...chCols, pt[0], pt[1], pt[2]].map(esc).join(','));
				} else lines.push([...base, ...chCols, '', '', ''].map(esc).join(','));
			}
		}
		return lines.join('\n');
	}
	function downloadCsv(b: { id: string; type: BenchType; rows: BatchRow[] }) {
		const url = URL.createObjectURL(new Blob([batchCsv(b)], { type: 'text/csv' }));
		const a = document.createElement('a');
		a.href = url;
		a.download = `${b.id}.csv`;
		a.click();
		URL.revokeObjectURL(url);
	}
	const liveAsBatch = $derived(
		fleetId
			? { id: fleetId, type: fleetType, rows: fleet.map((r): BatchRow => ({ spuId: r.spuId, spuUdi: r.udi, ok: r.state === 'done', error: r.error, at: null, result: r.result })) }
			: null
	);
	let openBatch = $state<string | null>(null);
	const pdList = (r: Result | null) => (r?.kind === 'scan' ? 'scan' : (r?.ch ?? []).map((c) => c.pd ?? '—').join(' / ') || '—');
	const f7List = (r: Result | null) => (r?.kind === 'scan' ? '—' : (r?.ch ?? []).map((c) => c.f?.[6] ?? '—').join(' / ') || '—');
	const STATE_CLASS: Record<RowState, string> = {
		queued: 'tron-text-muted',
		running: 'text-[var(--color-tron-cyan)]',
		done: 'text-emerald-400',
		failed: 'text-[var(--color-tron-red)]',
		skipped: 'text-amber-400'
	};
</script>

<div class="space-y-6">
	<div>
		<h1 class="tron-heading text-2xl font-bold">Optical Bench</h1>
		<p class="tron-text-muted mt-1 text-sm">
			Cartridge-free reads. The stage carries the sensors and the lasers are fixed: at {fw.posUm} µm
			each sensor sits directly in its laser. Position, gain, astep and atime are fixed — pick a unit,
			press Go, and the unit re-homes, moves there, reads, and the result is stored against it as
			validation data. Needs firmware v96 and an empty cartridge slot. The scan sweeps photodiode vs.
			position up to the same ceiling if you want to confirm the alignment on a unit.
		</p>
	</div>

	{#if form?.error}
		<div class="rounded-lg bg-[var(--color-tron-red)]/10 p-4 text-sm text-[var(--color-tron-red)]">{form.error}</div>
	{/if}

	<form
		method="POST"
		action="?/run"
		use:enhance={() => {
			running = true;
			return async ({ update }) => {
				try { await update({ reset: false }); } finally { running = false; }
			};
		}}
		class="tron-card space-y-4 p-6"
	>
		<div class="grid gap-4 md:grid-cols-2">
			<div>
				<label for="bench-spu" class="tron-label">Unit</label>
				<select id="bench-spu" name="spuId" bind:value={spuId} class="tron-select w-full" style="min-height: 44px;" required>
					<option value="" disabled>Choose a unit…</option>
					{#each data.spus as s (s.id)}
						<option value={s.id}>{s.udi} — {s.status}</option>
					{/each}
				</select>
			</div>
			<div>
				<span class="tron-label">Read</span>
				<div class="flex flex-wrap gap-2">
					{#each ['laser', 'dark', 'laser_scan'] as t (t)}
						<label class="flex cursor-pointer items-center gap-2 rounded border px-3 py-2 text-sm {type === t ? 'border-[var(--color-tron-cyan)] text-[var(--color-tron-cyan)]' : 'border-[var(--color-tron-border)] tron-text-muted'}">
							<input type="radio" name="type" value={t} bind:group={type} class="hidden" />
							{TYPE_LABEL[t as BenchType]}
						</label>
					{/each}
				</div>
			</div>
		</div>

		{#if type === 'laser_scan'}
			<div class="grid gap-4 sm:grid-cols-3">
				<div><label for="b-start" class="tron-label">Start µm</label><input id="b-start" name="start" type="number" bind:value={start} class="tron-input w-full" /></div>
				<div><label for="b-end" class="tron-label">End µm</label><input id="b-end" name="end" type="number" bind:value={end} class="tron-input w-full" /></div>
				<div><label for="b-step" class="tron-label">Step µm</label><input id="b-step" name="stepUm" type="number" bind:value={stepUm} class="tron-input w-full" /></div>
			</div>
		{/if}
		<div class="flex flex-wrap items-center gap-x-6 gap-y-1 rounded border border-[var(--color-tron-border)] px-4 py-3 text-sm" title="Fixed for every bench read — OPTICAL_BENCH_LASER_POSITION in firmware v96; gain / astep / atime set by BIMS">
			<span class="tron-text-muted text-[10px] uppercase tracking-wide">Fixed settings</span>
			{#if type !== 'laser_scan'}<span class="font-mono">{fw.posUm} µm</span>{/if}
			<span class="font-mono">gain {fw.gain}</span>
			<span class="font-mono">astep {fw.astep}</span>
			<span class="font-mono">atime {fw.atime}</span>
		</div>
		{#if type === 'laser_scan'}
			<p class="tron-text-muted text-xs {scanBad ? 'text-amber-400' : ''}">
				{scanPoints} points per channel{scanPoints > fw.maxScanPoints ? ` — the unit returns at most ${fw.maxScanPoints}; widen the step` : ''}{scanTooHigh ? ` — end cannot exceed ${fw.positionLimitUm} µm (the physical stop is just past it)` : ''}.
			</p>
		{/if}

		<button type="submit" disabled={!spuId || running || scanBad} class="w-full rounded-lg bg-[var(--color-tron-orange)] px-6 py-4 text-lg font-semibold text-[var(--color-tron-bg-primary)] hover:bg-[var(--color-tron-orange)]/90 disabled:cursor-not-allowed disabled:opacity-50" style="min-height: 44px">
			{running ? 'Running on the unit… (re-home, move, read)' : 'Go'}
		</button>
	</form>

	<div class="tron-card space-y-3 p-6">
		<div class="flex flex-wrap items-center justify-between gap-3">
			<div>
				<h2 class="tron-heading text-sm font-semibold uppercase tracking-wide">Run on all units</h2>
				<p class="tron-text-muted mt-1 text-xs">
					Runs the read selected above ({TYPE_LABEL[type]}) on every unit with a linked device ({data.spus.length}),
					{CONCURRENCY} at a time, and saves the whole run as a fleet batch you can download as CSV. Keep this
					tab open until it finishes.
				</p>
			</div>
			<div class="flex flex-wrap items-center gap-3">
				<label class="tron-text-muted flex items-center gap-2 text-xs">
					<input type="checkbox" bind:checked={skipOffline} disabled={fleetRunning} /> Skip units Particle reports offline
				</label>
				{#if fleetRunning}
					<button type="button" onclick={() => (fleetStop = true)} disabled={fleetStop} class="rounded-lg border border-[var(--color-tron-red)] px-4 py-2 text-sm font-semibold text-[var(--color-tron-red)] disabled:opacity-50" style="min-height: 44px">
						{fleetStop ? 'Stopping after current reads…' : 'Stop'}
					</button>
				{:else if fleetConfirm}
					<span class="text-sm">{TYPE_LABEL[type]} on {data.spus.length} units?</span>
					<button type="button" onclick={runFleet} class="rounded-lg bg-[var(--color-tron-orange)] px-4 py-2 text-sm font-semibold text-[var(--color-tron-bg-primary)]" style="min-height: 44px">Start</button>
					<button type="button" onclick={() => (fleetConfirm = false)} class="tron-text-muted rounded-lg border border-[var(--color-tron-border)] px-4 py-2 text-sm" style="min-height: 44px">Cancel</button>
				{:else}
					<button type="button" onclick={() => (fleetConfirm = true)} disabled={running || scanBad || data.spus.length === 0} class="rounded-lg bg-[var(--color-tron-orange)] px-4 py-2 text-sm font-semibold text-[var(--color-tron-bg-primary)] hover:bg-[var(--color-tron-orange)]/90 disabled:cursor-not-allowed disabled:opacity-50" style="min-height: 44px">
						Run on all units ({data.spus.length})
					</button>
				{/if}
			</div>
		</div>

		{#if fleet.length}
			<div class="flex flex-wrap items-center justify-between gap-2 text-xs">
				<span class="font-mono">
					{fleetId} · {TYPE_LABEL[fleetType]} ·
					<span class="text-emerald-400">{fleetCounts.done} ok</span> ·
					<span class="text-[var(--color-tron-red)]">{fleetCounts.failed} failed</span> ·
					<span class="text-amber-400">{fleetCounts.skipped} skipped</span>
					{#if fleetCounts.pending}· {fleetCounts.pending} to go{/if}
				</span>
				{#if !fleetRunning && liveAsBatch}
					{@const b = liveAsBatch}
					<button type="button" onclick={() => downloadCsv(b)} class="text-[var(--color-tron-cyan)] hover:underline">Download CSV</button>
				{/if}
			</div>
			{#if fleetNote}<p class="text-xs text-amber-400">{fleetNote}</p>{/if}
			<div class="max-h-96 overflow-auto">
				<table class="w-full text-xs">
					<thead class="text-[10px] uppercase text-[var(--color-tron-text-secondary)]">
						<tr class="border-b border-[var(--color-tron-border)]"><th class="py-1 pr-4 text-left font-medium">Unit</th><th class="py-1 pr-4 text-left font-medium">Status</th><th class="py-1 pr-4 text-left font-medium">PD A / B / C</th><th class="py-1 pr-4 text-left font-medium">F7 A / B / C</th><th class="py-1 text-left font-medium">Detail</th></tr>
					</thead>
					<tbody class="font-mono tron-text-primary">
						{#each fleet as r (r.spuId)}
							<tr class="border-b border-[var(--color-tron-border)]/50">
								<td class="py-1 pr-4">{r.udi}</td>
								<td class="py-1 pr-4 font-sans {STATE_CLASS[r.state]}">{r.state === 'running' ? 'running…' : r.state}</td>
								<td class="py-1 pr-4">{r.result ? pdList(r.result) : '—'}</td>
								<td class="py-1 pr-4">{r.result ? f7List(r.result) : '—'}</td>
								<td class="py-1 font-sans tron-text-muted">{r.error ?? ''}</td>
							</tr>
						{/each}
					</tbody>
				</table>
			</div>
		{/if}
	</div>

	{#if form?.ran && form.result}
		{@const r = form.result}
		<div class="tron-card p-4">
			<h2 class="tron-heading mb-2 text-sm font-semibold uppercase tracking-wide">{TYPE_LABEL[form.type ?? 'laser']} — {form.spuUdi}</h2>
			<p class="tron-text-muted mb-3 text-xs">seq {r.seq} · {r.kind} · {r.kind === 'scan' ? `${r.start}–${r.end} µm step ${r.step}` : `${r.pos} µm`} · gain {r.gain} · astep {r.astep} · atime {r.atime}{r.temp != null ? ` · ${(r.temp / 10).toFixed(1)} °C` : ''}</p>
			{#if r.kind === 'scan'}
				{@const ch = scanChart(r)}
				{#if ch}
					<svg viewBox="0 0 {W} {H}" class="w-full max-w-3xl" role="img" aria-label="Photodiode versus stage position per channel">
						<line x1={P.l} x2={W - P.r} y1={H - P.b} y2={H - P.b} stroke="var(--color-tron-border)" />
						<text x={P.l} y={H - 8} font-size="10" fill="var(--color-tron-text-secondary)" font-family="monospace">{ch.x0} µm</text>
						<text x={W - P.r} y={H - 8} font-size="10" text-anchor="end" fill="var(--color-tron-text-secondary)" font-family="monospace">{ch.x1} µm</text>
						<text x={P.l - 4} y={P.t + 8} font-size="10" text-anchor="end" fill="var(--color-tron-text-secondary)" font-family="monospace">{ch.y1}</text>
						{#each ch.lines as l (l.c)}
							<path d={l.d} fill="none" stroke={CH_COLOR[l.c]} stroke-width="2" />
							{#each l.dots as d (d.pos)}
								<circle cx={d.cx} cy={d.cy} r="3.5" fill={CH_COLOR[l.c]}><title>{l.c} · {d.pos} µm · pd {d.pd} · clear {d.clear}</title></circle>
							{/each}
						{/each}
					</svg>
					<div class="mt-2 flex flex-wrap gap-4 text-xs">
						{#each ch.lines as l (l.c)}
							<span><span class="mr-1 inline-block h-2.5 w-2.5 rounded-full align-middle" style="background: {CH_COLOR[l.c]}"></span>{l.c} peak {l.peak ? `${l.peak[0]} µm (pd ${l.peak[1]})` : '—'}</span>
						{/each}
					</div>
				{/if}
			{:else if r.ch}
				<div class="overflow-x-auto">
					<table class="text-xs">
						<thead class="text-[10px] uppercase text-[var(--color-tron-text-secondary)]">
							<tr><th class="pr-3 text-left font-medium">Ch</th><th class="pr-3 text-left font-medium" title="Photodiode, laser on">PD</th><th class="pr-3 text-left font-medium" title="Photodiode, laser off">PD dark</th>{#each BANDS as b}<th class="pr-3 text-left font-medium">{b}</th>{/each}</tr>
						</thead>
						<tbody class="font-mono tron-text-primary">
							{#each r.ch as c (c.c)}
								<tr><td class="pr-3"><span class="mr-1 inline-block h-2 w-2 rounded-full" style="background: {CH_COLOR[c.c]}"></span>{c.c}</td><td class="pr-3">{c.pd ?? '—'}</td><td class="pr-3">{c.pd0 ?? '—'}</td>{#each c.f ?? [] as v}<td class="pr-3 {v >= 65535 ? 'text-[var(--color-tron-red)]' : ''}" title={v >= 65535 ? 'Clipped — lower the gain' : ''}>{v}</td>{/each}</tr>
							{/each}
						</tbody>
					</table>
				</div>
			{/if}
		</div>
	{/if}

	{#if data.batches.length}
		<div class="tron-card p-4">
			<h2 class="tron-heading mb-3 text-sm font-semibold uppercase tracking-wide">Fleet runs ({data.batches.length})</h2>
			<div class="space-y-2">
				{#each data.batches as b (b.id)}
					{@const ok = b.rows.filter((r) => r.ok).length}
					<div class="rounded border border-[var(--color-tron-border)]">
						<div class="flex flex-wrap items-center justify-between gap-2 px-3 py-2 text-xs">
							<button type="button" class="flex flex-wrap items-center gap-3 text-left" onclick={() => (openBatch = openBatch === b.id ? null : b.id)}>
								<span class="font-mono text-[var(--color-tron-cyan)]">{openBatch === b.id ? '▾' : '▸'} {b.id}</span>
								<span>{TYPE_LABEL[b.type]}</span>
								<span class="tron-text-muted">{when(b.startedAt)}</span>
								<span><span class="text-emerald-400">{ok} ok</span> / {b.rows.length} units</span>
								<span class="tron-text-muted">{b.by ?? ''}</span>
							</button>
							<button type="button" onclick={() => downloadCsv(b)} class="text-[var(--color-tron-cyan)] hover:underline">Download CSV</button>
						</div>
						{#if openBatch === b.id}
							<div class="overflow-x-auto border-t border-[var(--color-tron-border)] px-3 py-2">
								<table class="w-full text-xs">
									<thead class="text-[10px] uppercase text-[var(--color-tron-text-secondary)]">
										<tr><th class="py-1 pr-4 text-left font-medium">Unit</th><th class="py-1 pr-4 text-left font-medium">Status</th><th class="py-1 pr-4 text-left font-medium">PD A / B / C</th><th class="py-1 pr-4 text-left font-medium">F7 A / B / C</th><th class="py-1 text-left font-medium">Detail</th></tr>
									</thead>
									<tbody class="font-mono tron-text-primary">
										{#each b.rows as r (r.id)}
											<tr class="border-t border-[var(--color-tron-border)]/50">
												<td class="py-1 pr-4"><a href={r.spuId ? `/spu/${r.spuId}` : '#'} class="text-[var(--color-tron-cyan)] hover:underline">{r.spuUdi ?? '—'}</a></td>
												<td class="py-1 pr-4 font-sans {r.ok ? 'text-emerald-400' : 'text-[var(--color-tron-red)]'}">{r.ok ? 'ok' : 'failed'}</td>
												<td class="py-1 pr-4">{pdList(r.result)}</td>
												<td class="py-1 pr-4">{f7List(r.result)}</td>
												<td class="py-1 font-sans tron-text-muted">{r.error ?? ''}</td>
											</tr>
										{/each}
									</tbody>
								</table>
							</div>
						{/if}
					</div>
				{/each}
			</div>
		</div>
	{/if}

	<div class="tron-card p-4">
		<div class="mb-3 flex flex-wrap items-center justify-between gap-2">
			<h2 class="tron-heading text-sm font-semibold uppercase tracking-wide">History ({shown.length})</h2>
			<select bind:value={filterUdi} class="tron-select" style="min-height: 36px;">
				<option value="">All units</option>
				{#each data.spus as s (s.id)}<option value={s.udi}>{s.udi}</option>{/each}
			</select>
		</div>
		{#if shown.length === 0}
			<p class="text-sm text-[var(--color-tron-text-secondary)]">No bench reads yet.</p>
		{:else}
			<div class="overflow-x-auto">
				<table class="w-full text-xs">
					<thead class="text-[10px] uppercase text-[var(--color-tron-text-secondary)]">
						<tr class="border-b border-[var(--color-tron-border)]"><th class="py-1 pr-4 text-left font-medium">When</th><th class="py-1 pr-4 text-left font-medium">Unit</th><th class="py-1 pr-4 text-left font-medium">Read</th><th class="py-1 pr-4 text-left font-medium">Position</th><th class="py-1 pr-4 text-left font-medium">Gain</th><th class="py-1 pr-4 text-left font-medium">PD A / B / C</th><th class="py-1 pr-4 text-left font-medium">F7 A / B / C</th><th class="py-1 text-left font-medium">By</th></tr>
					</thead>
					<tbody class="font-mono tron-text-primary">
						{#each shown as h (h.id)}
							{@const r = h.result}
							<tr class="border-b border-[var(--color-tron-border)]/50">
								<td class="py-1 pr-4">{when(h.at)}</td>
								<td class="py-1 pr-4"><a href={h.spuId ? `/spu/${h.spuId}` : '#'} class="text-[var(--color-tron-cyan)] hover:underline">{h.spuUdi ?? '—'}</a></td>
								<td class="py-1 pr-4 font-sans">{TYPE_LABEL[h.type]}</td>
								<td class="py-1 pr-4">{r?.kind === 'scan' ? `${r.start}–${r.end}` : (r?.pos ?? '—')}</td>
								<td class="py-1 pr-4">{r?.gain ?? '—'}</td>
								<td class="py-1 pr-4">{r?.kind === 'scan' ? '—' : (r?.ch ?? []).map((c) => c.pd ?? '—').join(' / ')}</td>
								<td class="py-1 pr-4">{r?.kind === 'scan' ? '—' : (r?.ch ?? []).map((c) => c.f?.[6] ?? '—').join(' / ')}</td>
								<td class="py-1 font-sans">{h.by ?? '—'}</td>
							</tr>
						{/each}
					</tbody>
				</table>
			</div>
		{/if}
	</div>
</div>
