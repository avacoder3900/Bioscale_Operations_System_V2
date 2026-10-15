<!--
	"Same moment on other SPUs": the moment picked in this recording is expressed as
	a step and how far through it (e.g. step 23, 40 %), then mapped onto each other
	verified SONIC recording through its own placed steps. Pick which recordings to
	hear, adjust where each clip starts (step placement is an estimate, so a clip
	may need a nudge), and play them one at a time or in turn after this one.
-->
<script lang="ts" module>
	export interface CompareRecording {
		id: string;
		udi: string;
		at: string | null;
		audioSrc: string;
		reference: boolean;
		confirmed: boolean;
		startS: number | null;
		endS: number | null;
		steps: { index: number; t0: number; t1: number }[];
	}
</script>

<script lang="ts">
	import { onDestroy } from 'svelte';

	interface Props {
		/** The moment picked in this recording (recording seconds). */
		moment: number;
		/** This recording's placed steps. */
		steps: { index: number; t0: number; t1: number; label?: string; short?: string }[];
		audioSrc: string;
		udi: string;
		others: CompareRecording[];
		pre: number;
		post: number;
		/** Called before a clip plays, so the page's own player can pause. */
		onBeforePlay?: () => void;
	}
	let { moment, steps, audioSrc, udi, others, pre, post, onBeforePlay }: Props = $props();

	type Loc = { index: number; frac: number; extra: number };
	/** Where `t` falls in the steps: step index, fraction through it, and seconds past its end (gaps / outside the run). */
	function locate(st: { index: number; t0: number; t1: number }[], t: number): Loc | null {
		if (!st.length) return null;
		if (t < st[0].t0) return { index: st[0].index, frac: 0, extra: t - st[0].t0 };
		for (let i = 0; i < st.length; i++) {
			const x = st[i];
			if (t >= x.t0 && t < x.t1) return { index: x.index, frac: x.t1 > x.t0 ? (t - x.t0) / (x.t1 - x.t0) : 0, extra: 0 };
			const next = st[i + 1];
			if (!next || t < next.t0) return { index: x.index, frac: 1, extra: t - x.t1 };
		}
		return null;
	}
	function mapTo(st: { index: number; t0: number; t1: number }[], loc: Loc): number | null {
		const x = st.find((s) => s.index === loc.index);
		if (!x) return null;
		return Math.max(0, x.t0 + loc.frac * (x.t1 - x.t0) + loc.extra);
	}

	const loc = $derived(locate(steps, moment));
	const locStep = $derived(loc ? steps.find((s) => s.index === loc.index) ?? null : null);
	const locText = $derived(
		!loc
			? 'no step placement for this recording'
			: loc.extra < 0
				? `${(-loc.extra).toFixed(1)} s before step ${loc.index}`
				: loc.extra > 0
					? `${loc.extra.toFixed(1)} s after step ${loc.index} ends`
					: `step ${loc.index}${locStep?.short ? ` (${locStep.short})` : ''}, ${Math.round(loc.frac * 100)} % through`
	);

	// ---- which recordings
	const defaultPick = () => {
		const refs = others.filter((o) => o.reference).map((o) => o.id);
		return new Set(refs.length ? refs : others.slice(0, 6).map((o) => o.id));
	};
	let chosen = $state<Set<string>>(defaultPick());
	let showPicker = $state(false);
	function toggle(id: string) {
		const n = new Set(chosen);
		if (n.has(id)) n.delete(id);
		else n.add(id);
		chosen = n;
	}
	const setChosen = (ids: string[]) => (chosen = new Set(ids));

	// ---- per-clip start adjustment (seconds added to the mapped start); cleared when the moment changes
	let shift = $state<Record<string, number>>({});
	$effect(() => {
		void moment;
		shift = {};
	});
	const HERE = '__here__';

	type Row = { id: string; udi: string; src: string; mapped: number | null; outside: boolean; rec?: CompareRecording };
	const rows = $derived.by((): Row[] => {
		const here: Row = { id: HERE, udi, src: audioSrc, mapped: moment, outside: false };
		const rest = others
			.filter((o) => chosen.has(o.id))
			.map((o) => {
				const m = loc ? mapTo(o.steps, loc) : null;
				const outside = m != null && o.startS != null && o.endS != null && (m < o.startS || m > o.endS);
				return { id: o.id, udi: o.udi, src: o.audioSrc, mapped: m, outside, rec: o };
			});
		return [here, ...rest];
	});
	const P = $derived(Math.max(0, Number(pre) || 0));
	const Q = $derived(Math.max(0, Number(post) || 0));
	const startOf = (r: Row) => (r.mapped == null ? null : Math.max(0, r.mapped - P + (shift[r.id] ?? 0)));
	function setStart(r: Row, v: number) {
		if (r.mapped == null || !Number.isFinite(v)) return;
		shift = { ...shift, [r.id]: Math.round((v - (r.mapped - P)) * 100) / 100 };
	}
	function nudge(r: Row, d: number) {
		shift = { ...shift, [r.id]: Math.round(((shift[r.id] ?? 0) + d) * 100) / 100 };
	}
	function resetShift(r: Row) {
		const { [r.id]: _, ...rest } = shift;
		shift = rest;
	}

	// ---- playback: one player, switched between recordings
	let player = $state<HTMLAudioElement | null>(null);
	let loadedSrc = '';
	let token = 0;
	let nowId = $state<string | null>(null);
	const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
	function loaded(el: HTMLAudioElement) {
		return new Promise<boolean>((res) => {
			const ok = () => (cleanup(), res(true));
			const bad = () => (cleanup(), res(false));
			const cleanup = () => {
				el.removeEventListener('loadedmetadata', ok);
				el.removeEventListener('error', bad);
			};
			el.addEventListener('loadedmetadata', ok);
			el.addEventListener('error', bad);
		});
	}
	let loadError = $state<string | null>(null);
	/** Plays [a, b] of `src`; resolves true when the clip finished, false if stopped or replaced. */
	async function clip(id: string, src: string, a: number, b: number, my: number): Promise<boolean> {
		const el = player;
		if (!el) return false;
		onBeforePlay?.();
		nowId = id;
		loadError = null;
		if (loadedSrc !== src) {
			el.pause();
			const ready = loaded(el);
			el.src = src;
			loadedSrc = src;
			if (!(await ready)) {
				loadedSrc = '';
				loadError = 'Could not load that recording.';
				return false;
			}
		}
		if (my !== token) return false;
		el.currentTime = Math.max(0, a);
		try {
			await el.play();
		} catch {
			return false;
		}
		return new Promise<boolean>((res) => {
			const step = () => {
				if (my !== token) return res(false);
				if (el.ended) return res(true);
				if (el.paused) return res(false);
				if (el.currentTime >= b) {
					el.pause();
					return res(true);
				}
				requestAnimationFrame(step);
			};
			requestAnimationFrame(step);
		});
	}
	async function playOne(r: Row) {
		const a = startOf(r);
		if (a == null) return;
		const my = ++token;
		await clip(r.id, r.src, a, a + P + Q, my);
		if (my === token) nowId = null;
	}
	async function playAll() {
		const my = ++token;
		for (const r of rows) {
			const a = startOf(r);
			if (a == null) continue;
			if (!(await clip(r.id, r.src, a, a + P + Q, my))) break;
			if (my !== token) break;
			await wait(400);
		}
		if (my === token) nowId = null;
	}
	function stop() {
		token++;
		player?.pause();
		nowId = null;
	}
	onDestroy(() => {
		token++;
		player?.pause();
	});

	const fmt = (t: number) => {
		const m = Math.floor(t / 60);
		const s = t - m * 60;
		return `${m}:${s.toFixed(2).padStart(5, '0')}`;
	};
	const day = (iso: string | null) => (iso ? new Date(iso).toLocaleDateString() : '');
</script>

<div class="space-y-2 rounded border border-[var(--color-tron-border)] p-3">
	<div class="flex flex-wrap items-center gap-3">
		<h4 class="font-semibold">Same moment on other SPUs</h4>
		<span class="tron-text-muted text-xs">{locText}</span>
	</div>

	{#if !others.length}
		<p class="tron-text-muted text-sm">No other verified SONIC recordings with step placement yet.</p>
	{:else}
		<div class="flex flex-wrap items-center gap-2 text-sm">
			<button type="button" class="rounded border border-[var(--color-tron-border)] px-3" style="min-height: 40px;" onclick={() => (showPicker = !showPicker)}>
				Recordings: {chosen.size} of {others.length} {showPicker ? '▲' : '▼'}
			</button>
			<button type="button" disabled={!loc} class="rounded bg-[var(--color-tron-orange)] px-4 font-semibold text-[var(--color-tron-bg-primary)] disabled:opacity-40" style="min-height: 40px;" onclick={playAll}>
				▶ Play this one, then each in turn
			</button>
			{#if nowId}
				<button type="button" class="rounded border border-[var(--color-tron-border)] px-3" style="min-height: 40px;" onclick={stop}>■ Stop</button>
			{/if}
			<span class="tron-text-muted text-xs">clip = start → start + {(P + Q).toFixed(1)} s (Pre + Post)</span>
		</div>

		{#if showPicker}
			<div class="space-y-2 rounded bg-[var(--color-tron-bg-secondary)] p-2">
				<div class="flex flex-wrap gap-3 text-xs">
					<button type="button" class="underline" style="min-height: 32px;" onclick={() => setChosen(others.map((o) => o.id))}>all</button>
					<button type="button" class="underline" style="min-height: 32px;" onclick={() => setChosen([])}>none</button>
					<button type="button" class="underline" style="min-height: 32px;" onclick={() => setChosen(others.filter((o) => o.reference).map((o) => o.id))}>★ references only</button>
				</div>
				<div class="grid max-h-56 grid-cols-1 gap-x-4 overflow-y-auto text-sm sm:grid-cols-2 lg:grid-cols-3">
					{#each others as o (o.id)}
						<label class="flex items-center gap-2" style="min-height: 32px;">
							<input type="checkbox" checked={chosen.has(o.id)} onchange={() => toggle(o.id)} />
							<span class="font-mono">{o.udi}</span>
							{#if o.reference}<span title="reference recording" class="text-[var(--color-tron-yellow,#facc15)]">★</span>{/if}
							<span class="tron-text-muted text-xs">{day(o.at)}{o.confirmed ? ' · timing confirmed' : ''}</span>
						</label>
					{/each}
				</div>
			</div>
		{/if}
	{/if}

	<table class="w-full text-left text-xs">
		<thead class="text-[var(--color-tron-text-secondary)]">
			<tr><th class="py-1">SPU</th><th>same moment</th><th>clip start (s)</th><th>adjust</th><th></th></tr>
		</thead>
		<tbody>
			{#each rows as r (r.id)}
				{@const st = startOf(r)}
				<tr class="border-t border-[var(--color-tron-border)]/40 {nowId === r.id ? 'bg-[var(--color-tron-orange)]/10' : ''}">
					<td class="py-1">
						<span class="font-mono">{r.udi}</span>
						{#if r.id === HERE}<span class="tron-text-muted"> (this one)</span>{/if}
						{#if r.rec?.reference}<span class="text-[var(--color-tron-yellow,#facc15)]"> ★</span>{/if}
					</td>
					<td class="font-mono">
						{#if r.mapped == null}<span class="tron-text-muted">—</span>{:else}{fmt(r.mapped)}{/if}
						{#if r.outside}<span class="text-[var(--color-tron-orange)]" title="Outside that recording's verified window"> ⚠</span>{/if}
					</td>
					<td>
						{#if st != null}
							<input type="number" step="0.05" min="0" value={Math.round(st * 100) / 100} class="tron-input w-24" style="min-height: 36px;" onchange={(e) => setStart(r, Number((e.currentTarget as HTMLInputElement).value))} />
						{/if}
					</td>
					<td class="whitespace-nowrap">
						{#if st != null}
							{#each [-0.5, -0.1, 0.1, 0.5] as d (d)}
								<button type="button" class="mr-1 rounded border border-[var(--color-tron-border)] px-2" style="min-height: 32px;" onclick={() => nudge(r, d)}>{d > 0 ? '+' : '−'}{Math.abs(d)}</button>
							{/each}
							{#if shift[r.id]}
								<button type="button" class="underline" style="min-height: 32px;" title="Back to the mapped start" onclick={() => resetShift(r)}>↺ {shift[r.id] > 0 ? '+' : ''}{shift[r.id]} s</button>
							{/if}
						{/if}
					</td>
					<td>
						{#if st != null}
							<button type="button" class="text-[var(--color-tron-orange)] underline" style="min-height: 32px;" onclick={() => (nowId === r.id ? stop() : playOne(r))}>{nowId === r.id ? '■' : '▶'}</button>
						{/if}
					</td>
				</tr>
			{/each}
		</tbody>
	</table>
	{#if loadError}<p class="text-xs text-[var(--color-tron-red,#f87171)]">{loadError}</p>{/if}
	<audio bind:this={player} preload="none" class="hidden"></audio>
</div>
