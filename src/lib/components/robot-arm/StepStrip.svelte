<script lang="ts">
	/**
	 * A move set's steps on one time bar (2026-10-28): grey for a move into a
	 * pose, cyan for a hold on it, amber for a fire step (the arm holding while
	 * a trapdoor solenoid fires and the cartridge drops). Lengths are to scale,
	 * so where a fire lands in the animation reads at a glance. Click a block
	 * to select that step; the playhead follows a play.
	 */
	import type { RenderedPath } from '$lib/robot-arm/animation';

	interface Props {
		path: RenderedPath;
		selectedIndex?: number | null;
		playheadS?: number | null;
		onselect?: (index: number) => void;
	}
	let { path, selectedIndex = null, playheadS = null, onselect }: Props = $props();

	type Block = { kind: 'move' | 'hold' | 'fire' | 'lead'; from: number; to: number; index: number; label: string; title: string };

	const blocks = $derived.by((): Block[] => {
		const out: Block[] = [];
		const ms = path.markers;
		ms.forEach((m, i) => {
			const prevEnd = i > 0 ? ms[i - 1].t + ms[i - 1].holdS : 0;
			if (m.t > prevEnd + 1e-6) {
				out.push({ kind: ms[i - 1]?.kind === 'lead-in' ? 'lead' : 'move', from: prevEnd, to: m.t, index: m.index, label: '', title: `Move to ${m.label} · ${(m.t - prevEnd).toFixed(1)} s` });
			}
			if (m.holdS > 0) {
				out.push(
					m.fire
						? { kind: 'fire', from: m.t, to: m.t + m.holdS, index: m.index, label: `⚡${m.fire.solenoid}`, title: `Fire ${m.fire.solenoid} (GPIO ${m.fire.pin}) at ${m.t.toFixed(1)} s · ${m.fire.pulseMs} ms pulse, then wait ${(m.holdS - m.fire.pulseMs / 1000).toFixed(1)} s` }
						: { kind: 'hold', from: m.t, to: m.t + m.holdS, index: m.index, label: '', title: `Hold ${m.label} · ${m.holdS.toFixed(1)} s` }
				);
			}
		});
		return out;
	});
	const total = $derived(Math.max(path.durationS, 0.001));
	const pct = (t: number) => `${(Math.max(0, Math.min(total, t)) / total) * 100}%`;
	const fill: Record<Block['kind'], string> = {
		lead: 'rgba(148,163,184,0.18)',
		move: 'rgba(148,163,184,0.35)',
		hold: 'rgba(56,189,248,0.35)',
		fire: 'rgba(245,158,11,0.55)'
	};
</script>

<div class="space-y-1">
	<div class="relative h-7 w-full overflow-hidden rounded border" style="border-color: var(--color-tron-border); background: rgba(0,0,0,0.25)">
		{#each blocks as b, i (i)}
			<button
				type="button"
				class="absolute top-0 h-full truncate border-r text-[10px] font-semibold"
				style="left: {pct(b.from)}; width: {pct(b.to - b.from)}; background: {fill[b.kind]}; border-color: rgba(0,0,0,0.35); color: {b.kind === 'fire' ? '#111' : 'transparent'}; outline: {selectedIndex != null && b.index === selectedIndex && b.index >= 0 ? '2px solid var(--color-tron-cyan)' : 'none'}; outline-offset: -2px"
				title={b.title}
				disabled={b.index < 0 || !onselect}
				onclick={() => b.index >= 0 && onselect?.(b.index)}
			>
				{b.label}
			</button>
		{/each}
		{#if playheadS != null}
			<div class="pointer-events-none absolute top-0 h-full w-0.5" style="left: {pct(playheadS)}; background: #4ade80"></div>
		{/if}
	</div>
	<div class="flex flex-wrap items-center gap-x-3 gap-y-0.5 text-[10px]" style="color: var(--color-tron-text-secondary)">
		<span><span class="mr-1 inline-block h-2 w-3 align-middle" style="background: {fill.move}"></span>move</span>
		<span><span class="mr-1 inline-block h-2 w-3 align-middle" style="background: {fill.hold}"></span>hold</span>
		<span><span class="mr-1 inline-block h-2 w-3 align-middle" style="background: {fill.fire}"></span>fire (arm waits)</span>
		<span class="grow"></span>
		<span class="font-mono">0 – {path.durationS.toFixed(1)} s</span>
	</div>
</div>
