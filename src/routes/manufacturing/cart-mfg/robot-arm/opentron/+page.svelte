<!--
  Robot Arm — Opentron: the arm line's OT-2 page. Two sections stacked, Wax
  Fill above Stage Calibration, each with its own Show / Hide button because
  the operator usually works on one or the other.

  Hiding is CSS-only (the section stays mounted): Wax Fill drives a running
  loop from the browser and Stage Calibration holds an open maintenance run,
  and neither may be torn down by folding it away. The choice is a per-browser
  convenience remembered across reloads. A link to #wax-fill / #stage-calibration
  (from the other section, or an old bookmark) unfolds its target.
-->
<script lang="ts">
	import { onMount } from 'svelte';
	import WaxFill from './WaxFill.svelte';
	import StageCalibration from './StageCalibration.svelte';

	let { data, form } = $props();

	const HIDDEN_KEY = 'robot-arm:opentron-hidden';
	type SectionId = 'wax-fill' | 'stage-calibration';
	let hidden = $state<Record<SectionId, boolean>>({ 'wax-fill': false, 'stage-calibration': false });

	function setHidden(id: SectionId, value: boolean) {
		hidden = { ...hidden, [id]: value };
		try {
			localStorage.setItem(HIDDEN_KEY, JSON.stringify(hidden));
		} catch {
			/* storage unavailable — the choice lasts for this page only */
		}
	}

	// A same-page link to a section shows it and scrolls there.
	function revealFromHash() {
		const id = location.hash.replace(/^#/, '');
		if (id !== 'wax-fill' && id !== 'stage-calibration') return;
		if (hidden[id]) setHidden(id, false);
		requestAnimationFrame(() => document.getElementById(id)?.scrollIntoView({ behavior: 'smooth', block: 'start' }));
	}

	onMount(() => {
		try {
			const saved = JSON.parse(localStorage.getItem(HIDDEN_KEY) ?? '{}');
			hidden = {
				'wax-fill': saved['wax-fill'] === true,
				'stage-calibration': saved['stage-calibration'] === true
			};
		} catch {
			/* storage unavailable — default to shown */
		}
		revealFromHash();
		window.addEventListener('hashchange', revealFromHash);
		return () => window.removeEventListener('hashchange', revealFromHash);
	});

	const sections: { id: SectionId; title: string; blurb: string }[] = [
		{ id: 'wax-fill', title: 'Wax Fill', blurb: 'The arm feeds one cart at a time to this OT-2, N runs in a loop.' },
		{ id: 'stage-calibration', title: 'Stage Calibration', blurb: 'The Stage Calibration Studio: what the stage protocol reads instead of a deck.' }
	];
</script>

<div class="space-y-6">
	{#each sections as s (s.id)}
		<section id={s.id} class="scroll-mt-4 space-y-4">
			<div class="flex flex-wrap items-center justify-between gap-3 border-b pb-2" style="border-color: var(--color-tron-border)">
				<div class="min-w-0">
					<h2 class="text-lg font-bold" style="color: var(--color-tron-cyan)">{s.title}</h2>
					{#if hidden[s.id]}<p class="text-xs" style="color: var(--color-tron-text-secondary)">{s.blurb}</p>{/if}
				</div>
				<button
					type="button"
					onclick={() => setHidden(s.id, !hidden[s.id])}
					aria-expanded={!hidden[s.id]}
					aria-controls={`${s.id}-body`}
					class="shrink-0 rounded border border-[var(--color-tron-cyan)]/60 bg-[var(--color-tron-cyan)]/10 px-3 py-1 text-xs font-semibold text-[var(--color-tron-cyan)] hover:bg-[var(--color-tron-cyan)]/20"
				>
					{hidden[s.id] ? 'Show' : 'Hide'}
				</button>
			</div>
			<div id={`${s.id}-body`} class:hidden={hidden[s.id]}>
				{#if s.id === 'wax-fill'}
					<WaxFill data={data.wax} {form} />
				{:else}
					<StageCalibration data={data.stage} />
				{/if}
			</div>
		</section>
	{/each}
</div>
