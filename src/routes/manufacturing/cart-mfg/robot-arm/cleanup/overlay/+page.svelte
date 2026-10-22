<script lang="ts">
	/**
	 * Overlay: the pilot's positions on an animated recording. The server reads
	 * both recordings (load); the alignment and the settings are applied here
	 * from the same pure module the server saves with, so the chart and the
	 * table show exactly what Save will write.
	 */
	import { deserialize } from '$app/forms';
	import { goto } from '$app/navigation';
	import type { ActionResult } from '@sveltejs/kit';
	import OverlayChart from '$lib/components/robot-arm/OverlayChart.svelte';
	import {
		ALIGN_MODES,
		DEFAULT_OVERLAY_OPTIONS,
		MAX_MAX_OFFSET,
		MAX_WINDOW_S,
		POOR_FIT_STEPS,
		alignWith,
		applyOverlay,
		type AlignMode,
		type Alignment,
		type OverlayOptions
	} from '$lib/robot-arm/recording-overlay';
	import { SERVO_IDS, DEFAULT_JOINT_NAMES } from '$lib/robot-arm/recording-cleanup';

	let { data } = $props();

	const BASE = '/manufacturing/cart-mfg/robot-arm';

	// --- pickers ---------------------------------------------------------------
	let smoothName = $state('');
	let preciseName = $state('');
	$effect(() => {
		smoothName = data.picked.smooth;
		preciseName = data.picked.precise;
	});
	const KIND_LABEL: Record<string, string> = {
		animated: 'animated',
		teleop: 'teleop',
		cleaned: 'clean-up',
		overlay: 'overlay',
		other: ''
	};
	const rank = (kind: string, want: string) => (kind === want ? 0 : kind === 'other' ? 1 : 2);
	const forSmooth = $derived([...data.recordings].sort((a, b) => rank(a.kind, 'animated') - rank(b.kind, 'animated')));
	const forPrecise = $derived([...data.recordings].sort((a, b) => rank(a.kind, 'teleop') - rank(b.kind, 'teleop')));
	function label(r: (typeof data.recordings)[number]) {
		const kind = KIND_LABEL[r.kind];
		return `${r.name}${kind ? ` · ${kind}` : ''}${r.from ? ` (${r.from})` : ''} · ${new Date(r.modified).toLocaleString()}`;
	}
	let lining = $state(false);
	async function lineUp() {
		if (!smoothName || !preciseName) return;
		lining = true;
		await goto(`${BASE}/cleanup/overlay?smooth=${encodeURIComponent(smoothName)}&precise=${encodeURIComponent(preciseName)}`, { invalidateAll: true });
		lining = false;
	}

	// --- settings ------------------------------------------------------------------
	let alignMode = $state<AlignMode>(DEFAULT_OVERLAY_OPTIONS.align);
	let trimIdle = $state(DEFAULT_OVERLAY_OPTIONS.trimIdle);
	let strengthPct = $state(Math.round(DEFAULT_OVERLAY_OPTIONS.strength * 100));
	let windowS = $state(DEFAULT_OVERLAY_OPTIONS.windowS);
	let maxOffset = $state(DEFAULT_OVERLAY_OPTIONS.maxOffset);
	let servoOn = $state<boolean[]>(SERVO_IDS.map((sid) => DEFAULT_OVERLAY_OPTIONS.servos.includes(sid)));
	const options = $derived<OverlayOptions>({
		align: alignMode,
		trimIdle,
		strength: Math.max(0, Math.min(1, strengthPct / 100)),
		windowS: Math.max(0, Math.min(MAX_WINDOW_S, Number(windowS) || 0)),
		servos: SERVO_IDS.filter((_, i) => servoOn[i]),
		maxOffset: Math.max(1, Math.min(MAX_MAX_OFFSET, Math.round(Number(maxOffset) || 1)))
	});
	const optionsJson = $derived(JSON.stringify(options));

	const ov = $derived(data.overlay);
	const names = $derived(ov?.smooth.jointNames?.length ? ov.smooth.jointNames : DEFAULT_JOINT_NAMES);
	// Recomputed only when the pair or the line-up settings change, not on every slider move.
	const lined = $derived.by((): { a: Alignment | null; error: string | null } => {
		if (!ov) return { a: null, error: null };
		try {
			return { a: alignWith({ t: ov.t, goal: ov.goal }, { t: ov.pilotT, goal: ov.pilotGoal }, { align: alignMode, trimIdle }), error: null };
		} catch (e) {
			return { a: null, error: (e as Error).message };
		}
	});
	const al = $derived(lined.a);
	const preview = $derived.by(() => {
		if (!ov || !al) return null;
		if (!options.servos.length) return null;
		return applyOverlay({ t: ov.t, goal: ov.goal }, al, options);
	});
	const poorFit = $derived(!!al && al.fit > POOR_FIT_STEPS);
	const pilotS = (i: number) => (ov ? ov.pilotT[i] - ov.pilotT[0] : 0);
	const smoothS = (i: number) => (ov ? ov.t[i] - ov.t[0] : 0);
	const cappedTotal = $derived(preview ? preview.servos.reduce((n, s) => n + s.capped, 0) : 0);

	// --- actions --------------------------------------------------------------------
	let notice = $state<{ kind: 'ok' | 'error' | 'info'; text: string } | null>(null);
	let busy = $state<string | null>(null);
	async function callAction(name: string, fields: Record<string, string>): Promise<ActionResult> {
		const fd = new FormData();
		for (const [k, v] of Object.entries(fields)) fd.set(k, v);
		const res = await fetch(`?/${name}`, { method: 'POST', body: fd, headers: { 'x-sveltekit-action': 'true' } });
		return deserialize(await res.text());
	}
	function errorOf(r: ActionResult): string {
		if (r.type === 'failure') return String((r.data as { error?: string })?.error ?? 'Failed');
		if (r.type === 'error') return r.error?.message ?? 'Server error';
		return 'Unexpected response';
	}

	const stem = (n: string) => n.replace(/\.jsonl$/i, '');
	let piName = $state('');
	let saved = $state<{ name: string; frames: number; durationS: number }[]>([]);
	// A fresh pair gets a fresh name and an empty "saved" list.
	$effect(() => {
		const n = ov?.smooth.name;
		if (n) {
			piName = `${stem(n)}-pilot`;
			saved = [];
		}
	});
	async function saveToPi() {
		if (!ov || !preview) return;
		busy = 'pi';
		notice = null;
		try {
			const r = await callAction('saveToPi', { smooth: ov.smooth.name, precise: ov.precise.name, options: optionsJson, name: piName });
			if (r.type === 'success') {
				const s = (r.data as { saved: { name: string; frames: number; durationS: number } }).saved;
				saved = [s, ...saved];
				notice = { kind: 'ok', text: `Saved on the Pi as "${s.name}" (${s.frames} frames, ${s.durationS.toFixed(1)} s). Replay it from the Control tab.` };
				piName = `${stem(ov.smooth.name)}-pilot-${saved.length + 1}`;
			} else notice = { kind: 'error', text: errorOf(r) };
		} catch (err) {
			notice = { kind: 'error', text: (err as Error).message };
		} finally {
			busy = null;
		}
	}

	// Same defaults as the Clean-up list's (load.defaults); an animated recording has no tremor, so 2 keeps every move.
	let thresholdSteps = $state(2);
	let pauseS = $state(0.25);
	async function toCleanup() {
		if (!ov || !preview) return;
		busy = 'cleanup';
		notice = null;
		try {
			const r = await callAction('toCleanup', {
				smooth: ov.smooth.name,
				precise: ov.precise.name,
				options: optionsJson,
				thresholdSteps: String(thresholdSteps),
				pauseS: String(pauseS)
			});
			if (r.type === 'redirect') await goto(r.location);
			else notice = { kind: 'error', text: errorOf(r) };
		} catch (err) {
			notice = { kind: 'error', text: (err as Error).message };
		} finally {
			busy = null;
		}
	}

	function fmtS(s: number) {
		return s >= 60 ? `${Math.floor(s / 60)} min ${Math.round(s % 60)} s` : `${s.toFixed(1)} s`;
	}
	const signed = (n: number) => (n > 0 ? `+${n}` : String(n));
	const inputCls =
		'rounded border border-[var(--color-tron-border)] bg-black/40 px-1.5 py-0.5 font-mono text-xs focus:border-[var(--color-tron-cyan)] focus:outline-none';
	const selectCls =
		'mt-1 w-full rounded border border-[var(--color-tron-border)] bg-black/40 px-2 py-1.5 text-sm';
</script>

<div class="space-y-4">
	<section class="rounded-lg border border-[var(--color-tron-border)] bg-[var(--color-tron-surface)] p-4">
		<a href={`${BASE}/cleanup`} class="text-xs hover:underline" style="color: var(--color-tron-text-secondary)">← all clean-ups</a>
		<h2 class="mt-1 text-sm font-bold uppercase tracking-wider" style="color: var(--color-tron-text-secondary)">
			Overlay: the pilot's positions on an animated recording
		</h2>
		<p class="mb-3 mt-1 text-xs" style="color: var(--color-tron-text-secondary)">
			An animated recording is smooth and fast but its joints settle short of each pose under load, so the claw
			lands low. A pilot on the control arm pushes each joint until the claw is where it should be, so a teleop
			recording of the same motion has the right positions but a rough path. This lines the two up in time and
			adds, frame by frame, how far the pilot's command was from the animation's — the result keeps the
			animation's timing and curves with the pilot's positions. Neither recording is changed.
		</p>

		{#if data.recordingsError}
			<p class="mb-3 rounded border border-amber-500/40 bg-amber-900/10 p-2 text-xs text-amber-300">
				Cannot list the Pi's recordings: {data.recordingsError}
			</p>
		{/if}

		<div class="grid gap-3 sm:grid-cols-[1fr_1fr_auto] sm:items-end">
			<label class="block text-xs" style="color: var(--color-tron-text-secondary)">
				Animated recording (timing and smoothness)
				<select bind:value={smoothName} class={selectCls} style="color: var(--color-tron-text)">
					<option value="" disabled>Pick a recording…</option>
					{#each forSmooth as r (r.name)}
						<option value={r.name}>{label(r)}</option>
					{/each}
				</select>
			</label>
			<label class="block text-xs" style="color: var(--color-tron-text-secondary)">
				Pilot's recording (positions)
				<select bind:value={preciseName} class={selectCls} style="color: var(--color-tron-text)">
					<option value="" disabled>Pick a recording…</option>
					{#each forPrecise as r (r.name)}
						<option value={r.name}>{label(r)}</option>
					{/each}
				</select>
			</label>
			<button
				type="button"
				onclick={lineUp}
				disabled={lining || !smoothName || !preciseName || smoothName === preciseName}
				class="rounded border border-[var(--color-tron-cyan)]/50 bg-[var(--color-tron-cyan)]/10 px-4 py-2 text-sm font-medium transition-colors hover:bg-[var(--color-tron-cyan)]/20 disabled:cursor-not-allowed disabled:opacity-40"
				style="color: var(--color-tron-cyan)"
			>
				{lining ? 'Lining up…' : 'Line them up'}
			</button>
		</div>
		<p class="mt-2 text-[11px]" style="color: var(--color-tron-text-secondary)">
			Both recordings must be of the same motion in the same order. They can take different times: by default the
			shorter one is stretched evenly to the length of the longer one (Stretch to fit), from when each starts moving
			to when it stops. If the pilot paused or sped up in places, switch to Follow the motion below.
		</p>

		{#if data.overlayError}
			<div class="mt-3 rounded border border-red-500/40 bg-red-900/10 p-2 text-xs text-red-300">{data.overlayError}</div>
		{/if}
		{#if notice}
			<div
				class="mt-3 rounded border p-2 text-xs {notice.kind === 'error'
					? 'border-red-500/40 bg-red-900/10 text-red-300'
					: notice.kind === 'info'
						? 'border-amber-500/40 bg-amber-900/10 text-amber-200'
						: 'border-green-500/40 bg-green-900/10 text-green-300'}"
			>
				{notice.text}
				{#if notice.kind === 'ok' && notice.text.includes('Control tab')}
					<a href={`${BASE}/control`} class="ml-1 underline">Go to Control →</a>
				{/if}
			</div>
		{/if}
	</section>

	{#if lined.error}
		<p class="rounded border border-red-500/40 bg-red-900/10 p-3 text-xs text-red-300">Could not line the recordings up: {lined.error}</p>
	{/if}
	{#if ov && al && preview}
		<!-- What lined up -->
		<section class="rounded-lg border border-[var(--color-tron-border)] bg-[var(--color-tron-surface)] p-4">
			<div class="mb-3 flex flex-wrap items-center gap-x-4 gap-y-2 text-xs" style="color: var(--color-tron-text-secondary)">
				<span class="font-semibold uppercase tracking-wider">Line up by</span>
				{#each ALIGN_MODES as m (m.id)}
					<label class="flex items-center gap-1.5" title={m.hint}>
						<input type="radio" name="align" value={m.id} bind:group={alignMode} class="accent-cyan-400" />
						<span style="color: var(--color-tron-text)">{m.label}</span>
					</label>
				{/each}
				{#if alignMode === 'stretch'}
					<label class="flex items-center gap-1.5" title="Line up from when each recording starts moving to when it stops, so a pause before or after the motion does not shift the stretch">
						<input type="checkbox" bind:checked={trimIdle} class="accent-cyan-400" />
						<span style="color: var(--color-tron-text)">Ignore still time at the start and end</span>
					</label>
				{/if}
			</div>
			<p class="text-xs" style="color: var(--color-tron-text-secondary)">
				<span class="font-mono" style="color: var(--color-tron-text)">{ov.smooth.name}</span>
				({ov.smooth.frames} frames, {fmtS(ov.smooth.durationS)}{#if ov.smooth.animated}, from move set “{ov.smooth.animated}”{/if})
				lined up with
				<span class="font-mono" style="color: var(--color-tron-text)">{ov.precise.name}</span>
				({ov.precise.frames} frames, {fmtS(ov.precise.durationS)}).
				{#if al.mode === 'stretch'}
					The animation's {fmtS(smoothS(al.smoothSpan.from))}–{fmtS(smoothS(al.smoothSpan.to))} is laid evenly over the pilot's
					{fmtS(pilotS(al.span.from))}–{fmtS(pilotS(al.span.to))}{#if al.stretch}
						— the pilot took <strong style="color: var(--color-tron-text)">{al.stretch.toFixed(2)}×</strong> as long{/if}.
				{:else}
					The animation matched the pilot's {fmtS(pilotS(al.span.from))}–{fmtS(pilotS(al.span.to))}.
				{/if}
				After lining up the pilot's path sits
				<strong style="color: var(--color-tron-text)">{al.fit.toFixed(0)} steps</strong> from the animation on average
				(all six joints together; that distance includes the offset being corrected).
			</p>
			{#if al.mode === 'follow' && ov.pilotT.length > 1 && pilotS(al.span.to) - pilotS(al.span.from) < 0.5 * (ov.pilotT[ov.pilotT.length - 1] - ov.pilotT[0])}
				<p class="mt-2 rounded border border-amber-500/40 bg-amber-900/10 p-2 text-xs text-amber-300">
					Follow the motion used less than half of the pilot's recording, so the amber line may be squeezed flat. If
					the two recordings are the same moves at different speeds, use Stretch to fit.
				</p>
			{/if}
			{#if poorFit}
				<p class="mt-2 rounded border border-amber-500/40 bg-amber-900/10 p-2 text-xs text-amber-300">
					That is a long way apart (more than {POOR_FIT_STEPS} steps). These two recordings may not be the same
					motion, or not in the same order — check the amber line follows the grey one below before saving.
				</p>
			{/if}
			<div class="mt-3">
				<OverlayChart t={ov.t} smooth={ov.goal} pilot={al.aligned} result={preview.goal} jointNames={names} corrected={servoOn} />
			</div>
		</section>

		<!-- Settings + per-servo table -->
		<section class="grid gap-4 lg:grid-cols-[minmax(0,2fr)_minmax(0,3fr)]">
			<div class="rounded-lg border border-[var(--color-tron-border)] bg-[var(--color-tron-surface)] p-4">
				<h2 class="mb-2 text-sm font-bold uppercase tracking-wider" style="color: var(--color-tron-text-secondary)">Settings</h2>
				<label class="block text-xs" style="color: var(--color-tron-text-secondary)">
					<span class="flex justify-between"><span>Strength</span><span class="font-mono" style="color: var(--color-tron-text)">{strengthPct}%</span></span>
					<input type="range" min="0" max="100" step="5" bind:value={strengthPct} class="mt-1 w-full accent-cyan-400" />
					<span class="text-[11px]">How much of the pilot's offset to add. 100% = the pilot's positions; 0% = the animation as it is.</span>
				</label>
				<div class="mt-3 grid grid-cols-2 gap-3">
					<label class="block text-xs" style="color: var(--color-tron-text-secondary)">
						Smoothing window (s)
						<input type="number" min="0" max={MAX_WINDOW_S} step="0.1" bind:value={windowS} class="{inputCls} mt-1 block w-full py-1" style="color: var(--color-tron-text)" />
						<span class="text-[11px]">The offset is averaged over this long, so hand tremor and the pilot's detours do not get into the result. 0 = raw.</span>
					</label>
					<label class="block text-xs" style="color: var(--color-tron-text-secondary)">
						Largest offset (steps)
						<input type="number" min="1" max={MAX_MAX_OFFSET} step="1" bind:value={maxOffset} class="{inputCls} mt-1 block w-full py-1" style="color: var(--color-tron-text)" />
						<span class="text-[11px]">An offset bigger than this is capped — a sign the recordings drifted apart there, not of droop.</span>
					</label>
				</div>
				<div class="mt-3 text-xs" style="color: var(--color-tron-text-secondary)">
					Servos to correct
					<div class="mt-1 grid grid-cols-3 gap-1 sm:grid-cols-6">
						{#each SERVO_IDS as sid, i (sid)}
							<label class="flex items-center gap-1 rounded border border-[var(--color-tron-border)] px-1.5 py-1 text-[11px]" title={names[i]}>
								<input type="checkbox" bind:checked={servoOn[i]} class="accent-cyan-400" />
								<span class="font-mono text-cyan-400">{sid}</span>
								<span class="truncate">{names[i]}</span>
							</label>
						{/each}
					</div>
					<span class="text-[11px]">Untick a servo to keep the animation's goal for it (e.g. the gripper, if the pilot squeezed harder than you want).</span>
				</div>
			</div>

			<div class="rounded-lg border border-[var(--color-tron-border)] bg-[var(--color-tron-surface)] p-4">
				<h2 class="mb-2 text-sm font-bold uppercase tracking-wider" style="color: var(--color-tron-text-secondary)">Offset per servo (steps)</h2>
				<table class="w-full text-xs">
					<thead class="border-b border-[var(--color-tron-border)] text-left uppercase tracking-wider" style="color: var(--color-tron-text-secondary)">
						<tr>
							<th class="py-1 pr-2">Servo</th>
							<th class="py-1 pr-2" title="Pilot minus animation, before smoothing: the middle value over the recording">Pilot offset (median)</th>
							<th class="py-1 pr-2" title="Smallest and largest raw offset over the recording">Range</th>
							<th class="py-1 pr-2" title="What is added after smoothing, the cap and the strength">Applied (mean, min … max)</th>
							<th class="py-1" title="Frames whose smoothed offset was over the cap">Capped</th>
						</tr>
					</thead>
					<tbody class="font-mono" style="color: var(--color-tron-text)">
						{#each preview.servos as s, i (s.servoId)}
							<tr class="border-b border-[var(--color-tron-border)]/50 last:border-b-0 {s.corrected ? '' : 'opacity-50'}">
								<td class="py-1 pr-2 font-sans"><span class="font-mono text-cyan-400">{s.servoId}</span> {names[i]}</td>
								<td class="py-1 pr-2">{signed(s.median)}</td>
								<td class="py-1 pr-2">{signed(s.min)} … {signed(s.max)}</td>
								<td class="py-1 pr-2">{#if s.corrected}{signed(s.appliedMean)}, {signed(s.appliedMin)} … {signed(s.appliedMax)}{:else}<span class="font-sans">kept</span>{/if}</td>
								<td class="py-1 {s.capped ? 'text-amber-300' : ''}">{s.corrected ? s.capped : '—'}</td>
							</tr>
						{/each}
					</tbody>
				</table>
				<p class="mt-2 text-[11px]" style="color: var(--color-tron-text-secondary)">
					A steady positive or negative median on the loaded joints (shoulder lift, elbow, wrist) is the droop the
					pilot was compensating for. A range far wider than the median means the two paths differ between poses;
					a longer smoothing window evens that out.
					{#if cappedTotal}
						<span class="text-amber-300">{cappedTotal} frame-servo values hit the cap.</span>
					{/if}
				</p>
			</div>
		</section>

		<!-- Ways out -->
		<section class="grid gap-4 lg:grid-cols-2">
			<div class="rounded-lg border border-[var(--color-tron-border)] bg-[var(--color-tron-surface)] p-4">
				<h2 class="mb-1 text-sm font-bold uppercase tracking-wider" style="color: var(--color-tron-text-secondary)">Save to Pi</h2>
				<p class="mb-3 text-[11px]" style="color: var(--color-tron-text-secondary)">
					Writes the result as a new recording on the Pi: every frame of the animated recording, at its own time,
					with the offset above added. Replay it from the Control tab. Both source recordings stay as they are.
				</p>
				<div class="flex gap-2">
					<input bind:value={piName} class="{inputCls} min-w-0 flex-1 py-1 font-sans text-sm" style="color: var(--color-tron-text)" />
					<button
						type="button"
						onclick={saveToPi}
						disabled={busy !== null || !piName.trim() || !options.servos.length}
						class="rounded border border-emerald-500/50 bg-emerald-900/10 px-3 py-1 text-sm font-medium text-emerald-300 transition-colors hover:bg-emerald-900/25 disabled:cursor-not-allowed disabled:opacity-40"
					>
						{busy === 'pi' ? 'Saving…' : 'Save to Pi'}
					</button>
				</div>
				{#if saved.length}
					<ul class="mt-3 space-y-0.5 text-[11px]" style="color: var(--color-tron-text-secondary)">
						{#each saved as s (s.name)}
							<li><span class="font-mono" style="color: var(--color-tron-text)">{s.name}</span> · {s.frames} frames · {s.durationS.toFixed(1)} s</li>
						{/each}
					</ul>
				{/if}
			</div>

			<div class="rounded-lg border border-[var(--color-tron-border)] bg-[var(--color-tron-surface)] p-4">
				<h2 class="mb-1 text-sm font-bold uppercase tracking-wider" style="color: var(--color-tron-text-secondary)">Open as a clean-up</h2>
				<p class="mb-3 text-[11px]" style="color: var(--color-tron-text-secondary)">
					Splits the result into steps like any recording, so you can edit targets and timing, and send it to
					the Animate tab as poses + a move set with the pilot's positions. (A clean-up's own Save to Pi plays
					straight lines; use Save to Pi here to keep the animation's curves as they are.)
				</p>
				<div class="flex flex-wrap items-end gap-2">
					<label class="text-[11px]" style="color: var(--color-tron-text-secondary)">
						Threshold (steps)
						<input type="number" min="0" max="500" bind:value={thresholdSteps} class="{inputCls} mt-0.5 block w-24 py-1" style="color: var(--color-tron-text)" />
					</label>
					<label class="text-[11px]" style="color: var(--color-tron-text-secondary)">
						Pause ends a move (s)
						<input type="number" min="0.05" max="5" step="0.05" bind:value={pauseS} class="{inputCls} mt-0.5 block w-24 py-1" style="color: var(--color-tron-text)" />
					</label>
					<button
						type="button"
						onclick={toCleanup}
						disabled={busy !== null || !options.servos.length}
						class="rounded border border-[var(--color-tron-cyan)]/50 bg-cyan-900/10 px-3 py-1 text-sm font-medium text-[var(--color-tron-cyan)] transition-colors hover:bg-cyan-900/25 disabled:cursor-not-allowed disabled:opacity-40"
					>
						{busy === 'cleanup' ? 'Splitting…' : 'Split into steps'}
					</button>
				</div>
				<p class="mt-2 text-[11px]" style="color: var(--color-tron-text-secondary)">
					An animated recording has no hand tremor, so threshold 0–2 keeps every move; the holds between poses
					end the moves.
				</p>
			</div>
		</section>
	{:else if ov && al && !preview}
		<p class="rounded border border-amber-500/40 bg-amber-900/10 p-3 text-xs text-amber-300">Tick at least one servo to correct.</p>
	{/if}
</div>
