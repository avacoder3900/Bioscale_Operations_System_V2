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
	 * What the operator has dragged each slider to, kept separate from what the
	 * camera reports. The slider used to be driven straight from `params`, so
	 * when the camera refused a change its reply overwrote the drag and the thumb
	 * snapped back — indistinguishable from a dead control. Now the thumb always
	 * moves, and a refusal is visible as the camera's value differing from the
	 * request instead of silently winning.
	 */
	let requested = $state<Record<string, number>>({});

	function positionOf(prop: string, fallback: number): number {
		return requested[prop] ?? params[prop] ?? fallback;
	}

	/** The camera settled somewhere other than what was asked for. */
	function refused(prop: string): boolean {
		const want = requested[prop];
		const got = params[prop];
		return typeof want === 'number' && typeof got === 'number' && want !== got;
	}

	function drag(prop: string, value: number) {
		requested = { ...requested, [prop]: value };

		/**
		 * UVC drivers reject a write to exposure while auto-exposure is driving,
		 * and several re-assert auto on their own between writes. Each slider
		 * previously fired an independent set_camera_param with no ordering, so an
		 * exposure write could land while the camera was still in auto and be
		 * discarded — the camera keeps its own value and the request vanishes.
		 *
		 * Re-assert manual immediately before the value, then send the value once
		 * the camera has had a moment to switch. Harmless when it is already
		 * manual; the write it enables is the point.
		 */
		if (prop === 'exposure' && known.includes('auto_exposure')) {
			onSet('auto_exposure', 1);
			requested = { ...requested, auto_exposure: 1 };
			setTimeout(() => onSet(prop, value), 150);
			return;
		}

		onSet(prop, value);
	}

	/**
	 * The original wide bounds, restored at the operator's request.
	 *
	 * These were briefly narrowed to bench-measured limits (brightness and
	 * contrast 0..64, gain 0..100, sharpness 0..6, gamma 72..500, hue -40..40)
	 * because the sliders travelled past where the camera stopped responding.
	 * That turned out to cost more than it gave: capping brightness at 64 removed
	 * the higher values that were the reliable way back to a visible feed, and
	 * gamma is the control actually used to rescue a blown-out image.
	 *
	 * The measured limits are still true — a slider past them does nothing — but
	 * they are not enforced, and the number box beside each slider accepts values
	 * outside them regardless. Wherever the agent reports a real range, that
	 * still wins over anything here.
	 *
	 * exposure stays on the -13..0 log2 scale deliberately: on this camera a
	 * negative value is what produces the long 5000 exposure, and positive values
	 * are refused. It is the only way to reach a bright feed by dragging.
	 */
	const FALLBACK_RANGES: Record<string, CamRange> = {
		brightness: { min: 0, max: 255 },
		contrast: { min: 0, max: 255 },
		saturation: { min: 0, max: 255 },
		hue: { min: -180, max: 180 },
		gain: { min: 0, max: 255 },
		gamma: { min: 1, max: 500 },
		sharpness: { min: 0, max: 255 },
		exposure: { min: -13, max: 0 },
		auto_exposure: { min: 1, max: 3, step: 1 },
		auto_wb: { min: 0, max: 1, step: 1 },
		wb_temperature: { min: 2800, max: 6500 },
		focus: { min: 0, max: 255 },
		autofocus: { min: 0, max: 1, step: 1 },
		power_line_frequency: { min: 0, max: 2, step: 1 }
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
		autofocus: 'Autofocus',
		power_line_frequency: 'Anti-flicker (0=off, 1=50Hz, 2=60Hz)'
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

	/**
	 * Mains-powered lamps pulse at twice the supply frequency — 120 Hz on 60 Hz
	 * mains, one cycle every 8.333 ms. An exposure covering a whole number of
	 * those cycles collects the same light in every row, so the banding cancels;
	 * a fractional one does not. A battery torch is DC and has no ripple at all,
	 * which is why the Glossday shows no strobing.
	 *
	 * Only meaningful for EXPOSURE_ABSOLUTE, where the unit is 100 microseconds.
	 */
	const MAINS_HZ = 60;
	const FLICKER_CYCLE_MS = 1000 / (MAINS_HZ * 2);

	function flickerNote(exposureValue: number | undefined): string | null {
		if (typeof exposureValue !== 'number' || !Number.isFinite(exposureValue) || exposureValue <= 0) return null;
		const ms = exposureValue / 10; // 100 us units -> ms
		const cycles = ms / FLICKER_CYCLE_MS;
		const nearest = Math.max(1, Math.round(cycles));
		const safe = Math.round(nearest * FLICKER_CYCLE_MS * 10);
		if (Math.abs(cycles - nearest) < 0.02) {
			return `${ms.toFixed(1)} ms = ${nearest} flicker cycle(s) at ${MAINS_HZ} Hz — banding cancels.`;
		}
		return `${ms.toFixed(1)} ms = ${cycles.toFixed(2)} flicker cycles at ${MAINS_HZ} Hz — try ${safe} for a whole number.`;
	}

	/**
	 * Exactly what the station reported, per control. When a slider will not
	 * move, this is what distinguishes "the agent has no writable range for it"
	 * from "the camera is refusing the write" — and it is what whoever maintains
	 * agent.py will need.
	 */
	const rawReport = $derived(
		known.map((prop) => ({
			prop,
			value: params[prop],
			range: ranges[prop] ? JSON.stringify(ranges[prop]) : '(none reported)'
		}))
	);

	const shown = $derived(known.filter((p) => !isUnavailable(p)));
	const unavailable = $derived(known.filter((p) => isUnavailable(p)));

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
								<span class="font-mono text-xs">
									{#if refused(prop)}
										<span class="text-[var(--color-tron-red,#ff3366)]">{requested[prop]} &rarr; camera {params[prop]}</span>
									{:else}
										<span class="text-[var(--color-tron-cyan)]">{params[prop] ?? '?'}</span>
									{/if}
								</span>
								<!-- Typed entry beside every slider. The values that matter are often
								     specific — a gamma that balances a blown-out feed, or an exposure on
								     a whole flicker cycle — and awkward to hit by dragging. The box
								     accepts values outside the slider bounds and lets the camera decide,
								     since those bounds are a guess wherever the agent reports no range. -->
								<input
									type="number"
									aria-label={`${LABELS[prop] ?? prop} value`}
									class="tron-input ml-2 w-24 px-1 py-0.5 text-right font-mono text-xs"
									value={positionOf(prop, b.lo)}
									step={b.step}
									onchange={(e) => {
										const v = Number(e.currentTarget.value);
										if (Number.isFinite(v)) drag(prop, v);
									}}
								/>
							</div>
							<input
								id={`cam-${prop}`}
								type="range"
								min={b.lo}
								max={b.hi}
								step={b.step}
								value={positionOf(prop, b.lo)}
								oninput={(e) => drag(prop, Number(e.currentTarget.value))}
								class="w-full"
							/>
							<div class="flex justify-between text-[10px] text-[var(--color-tron-text-secondary)]">
								<span class="font-mono">{b.lo}</span>
								<span>{b.source}</span>
								<span class="font-mono">{b.hi}</span>
							</div>
							{#if prop === 'exposure'}
								{@const fn = flickerNote(params[prop])}
								{#if fn}
									<div class="mt-0.5 text-[10px] text-[var(--color-tron-yellow,#facc15)]">{fn}</div>
								{/if}
							{/if}
						</div>
					{/each}
				</div>

				<details class="mt-4">
					<summary class="cursor-pointer text-xs text-[var(--color-tron-text-secondary)] hover:text-[var(--color-tron-cyan)]">
						What the station reported ({rawReport.length} controls)
					</summary>
					<ul class="mt-2 space-y-0.5 font-mono text-[10px] text-[var(--color-tron-text-secondary)]">
						{#each rawReport as r (r.prop)}
							<li>{r.prop} = {r.value} &middot; range {r.range}</li>
						{/each}
					</ul>
					<p class="mt-1 text-[10px] text-[var(--color-tron-text-secondary)]">
						A control with no reported range is one the agent never queried a range
						for. If a slider will not move, compare the value here against what was
						requested — the camera keeping its own value means the write was refused
						on the station, which is an agent or driver matter rather than this page.
					</p>
				</details>

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
