<script lang="ts">
	/**
	 * Pi station camera tuning.
	 *
	 * The station owns the camera: values go over the station WebSocket as
	 * {cmd: 'set_camera_param', prop, value} and the agent applies them with
	 * v4l2. This component only renders the controls — the socket belongs to the
	 * page, which passes params in and a setter down.
	 *
	 * Range handling, in priority order:
	 *   1. the range the agent reports for that control — trusted, it comes from
	 *      the driver itself
	 *   2. FALLBACK_RANGES below, measured on the bench, where the agent reports
	 *      nothing
	 *   3. widened to contain the current value if it falls outside, because a
	 *      value the bounds cannot represent proves the bounds are wrong
	 *
	 * Step 3 matters: V4L2 reports exposure either on a log2 scale (-13..0) or as
	 * EXPOSURE_ABSOLUTE in 100 microsecond units (1..10000). Assuming the wrong
	 * one gives a slider that can neither show the real value nor send an
	 * in-range one, which reads as "the slider does nothing".
	 */

	type CamRange = { min: number; max: number; step?: number; default?: number; source?: string };

	interface Props {
		params: Record<string, number>;
		ranges: Record<string, CamRange>;
		known: string[];
		onSet: (prop: string, value: number) => void;
		onRefresh?: () => void;
	}

	let { params, ranges, known, onSet, onRefresh }: Props = $props();

	let expanded = $state(false);
	let note = $state<string | null>(null);

	/**
	 * Bench-measured bounds, used only where the agent reports no range. These
	 * replace earlier guesses (0..255 for most controls) that let sliders travel
	 * far past the point where the camera stopped responding — brightness and
	 * contrast silently ignored anything over 64, for instance.
	 */
	const FALLBACK_RANGES: Record<string, CamRange> = {
		brightness: { min: 0, max: 64 },
		contrast: { min: 0, max: 64 },
		saturation: { min: 0, max: 128 },
		hue: { min: -40, max: 40 },
		gain: { min: 0, max: 100 },
		gamma: { min: 72, max: 500 },
		sharpness: { min: 0, max: 6 },
		exposure: { min: 1, max: 10000 },
		auto_exposure: { min: 1, max: 3, step: 1 },
		auto_wb: { min: 0, max: 1, step: 1 },
		wb_temperature: { min: 2800, max: 6500 },
		focus: { min: 0, max: 255 },
		autofocus: { min: 0, max: 1, step: 1 }
	};

	const LABELS: Record<string, string> = {
		brightness: 'Brightness',
		contrast: 'Contrast',
		saturation: 'Saturation',
		hue: 'Hue',
		gain: 'Gain',
		gamma: 'Gamma',
		sharpness: 'Sharpness',
		exposure: 'Exposure',
		auto_exposure: 'Auto Exposure (1=manual, 3=auto)',
		auto_wb: 'Auto White Balance (0=manual, 1=auto)',
		wb_temperature: 'White Balance (K)',
		focus: 'Focus',
		autofocus: 'Autofocus'
	};

	/**
	 * Controls the camera reports but cannot drive. -1 is V4L2's "unsupported"
	 * answer; a slider for it invites chasing a control that will never move.
	 */
	function isUnavailable(prop: string): boolean {
		return params[prop] === -1;
	}

	function bounds(prop: string) {
		const reported = ranges[prop];
		const fb = FALLBACK_RANGES[prop];
		let lo = reported?.min ?? fb?.min ?? 0;
		let hi = reported?.max ?? fb?.max ?? 255;
		let source = reported ? 'camera range' : fb ? 'measured range' : 'assumed range';

		const v = params[prop];
		if (typeof v === 'number' && Number.isFinite(v) && (v < lo || v > hi)) {
			lo = Math.min(lo, v);
			hi = Math.max(hi, v);
			source = 'widened to fit the reported value';
		}

		return { lo, hi, step: reported?.step ?? fb?.step ?? 1, source };
	}

	const shown = $derived(known.filter((p) => !isUnavailable(p)));
	const unavailable = $derived(known.filter((p) => isUnavailable(p)));

	/** Auto-exposure back on — the one control that reliably rescues a dark feed. */
	function autoExposureOn() {
		if (!known.includes('auto_exposure')) return;
		onSet('auto_exposure', 3);
		note = 'Auto Exposure set to 3 (auto). The feed should recover within a second or two.';
	}

	function autoWhiteBalanceOn() {
		if (!known.includes('auto_wb')) return;
		onSet('auto_wb', 1);
		note = 'Auto White Balance set to 1 (auto).';
	}
</script>

<div class="rounded-lg border border-[var(--color-tron-border)] bg-[var(--color-tron-bg-secondary)]">
	<button
		type="button"
		onclick={() => (expanded = !expanded)}
		class="flex w-full items-center justify-between px-4 py-2 text-sm text-[var(--color-tron-text-secondary)] hover:text-[var(--color-tron-cyan)]"
	>
		<span>🎛 Camera settings (Pi station){shown.length ? ` — ${shown.length} controls` : ''}</span>
		<span aria-hidden="true">{expanded ? '▴' : '▾'}</span>
	</button>

	{#if expanded}
		<div class="border-t border-[var(--color-tron-border)] p-4">
			{#if known.length === 0}
				<p class="text-xs text-[var(--color-tron-yellow,#facc15)]">
					The station has not reported its camera parameters yet. The agent answers
					<span class="font-mono">get_camera_params</span> over the station socket; until it
					does there is nothing to adjust.
				</p>
			{:else}
				<!-- Rescue buttons first: a dark or colour-cast feed is the state an
				     operator most needs to get out of quickly. -->
				<div class="mb-4 flex flex-wrap items-center gap-2">
					{#if known.includes('auto_exposure')}
						<button
							type="button"
							onclick={autoExposureOn}
							class="rounded border border-[var(--color-tron-cyan)] px-3 py-1.5 text-xs font-bold text-[var(--color-tron-cyan)] hover:bg-[rgba(0,255,255,0.1)]"
						>
							Auto Exposure on
						</button>
					{/if}
					{#if known.includes('auto_wb')}
						<button
							type="button"
							onclick={autoWhiteBalanceOn}
							class="rounded border border-[var(--color-tron-border)] px-3 py-1.5 text-xs text-[var(--color-tron-text-secondary)] hover:text-[var(--color-tron-cyan)]"
						>
							Auto White Balance on
						</button>
					{/if}
					{#if onRefresh}
						<button
							type="button"
							onclick={onRefresh}
							class="rounded border border-[var(--color-tron-border)] px-3 py-1.5 text-xs text-[var(--color-tron-text-secondary)] hover:text-[var(--color-tron-cyan)]"
						>
							Re-read from station
						</button>
					{/if}
				</div>

				{#if note}
					<p class="mb-3 text-xs text-[var(--color-tron-green,#39ff14)]">{note}</p>
				{/if}

				<div class="grid gap-3 sm:grid-cols-2">
					{#each shown as prop (prop)}
						{@const b = bounds(prop)}
						<div>
							<div class="flex items-baseline justify-between gap-2">
								<label for={`cam-${prop}`} class="text-xs text-[var(--color-tron-text-secondary)]">
									{LABELS[prop] ?? prop}
								</label>
								<span class="font-mono text-xs text-[var(--color-tron-cyan)]">
									{params[prop] ?? '?'}
								</span>
							</div>
							<input
								id={`cam-${prop}`}
								type="range"
								min={b.lo}
								max={b.hi}
								step={b.step}
								value={params[prop] ?? b.lo}
								oninput={(e) => onSet(prop, Number(e.currentTarget.value))}
								class="w-full"
							/>
							<div class="flex justify-between text-[10px] text-[var(--color-tron-text-secondary)]">
								<span class="font-mono">{b.lo}</span>
								<span>{b.source}</span>
								<span class="font-mono">{b.hi}</span>
							</div>
						</div>
					{/each}
				</div>

				{#if unavailable.length > 0}
					<p class="mt-3 text-[10px] text-[var(--color-tron-text-secondary)]">
						Reported but not adjustable on this camera (value -1, V4L2's "unsupported"):
						<span class="font-mono">{unavailable.join(', ')}</span>. Focus and aperture are
						set manually on the lens.
					</p>
				{/if}
			{/if}
		</div>
	{/if}
</div>
