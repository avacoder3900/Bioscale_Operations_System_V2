<script lang="ts">
	/**
	 * ARM-04 — calibrate: drag a virtual marker onto every sticker.
	 *
	 * 1. Park the arm at home. Freeze a frame (a still is far easier to place
	 *    on precisely than a moving feed).
	 * 2. Pick a registered marker and click its sticker, or drag a marker that
	 *    is already on the frame. With "snap" on, a drop lands on the centre
	 *    of the nearest blob of the sticker's colour.
	 * 3. Save. The frame, the placements, the colour sampled under each one,
	 *    the depth there and the arm's encoders become the reference.
	 *
	 * Recalibrating has the same structure: the current calibration's markers
	 * start where they were and are re-found on the new frame, so a small
	 * camera move only needs a check and a nudge, not a full re-placement.
	 */
	import { untrack } from 'svelte';
	import { enhance } from '$app/forms';
	import VisionStage, { type StageMarker } from './VisionStage.svelte';
	import {
		isLowSaturation,
		rgbToHex,
		samplePatch,
		trackMarker,
		DEFAULT_DEPTH_TOLERANCE_MM,
		DEFAULT_POSITION_TOLERANCE,
		DEFAULT_SEARCH_RADIUS,
		type Rgb
	} from '$lib/robot-arm/markers';
	import { fetchDepth, grabFrame, type GrabbedFrame } from '$lib/robot-arm/frame-grab';
	import type { CalibrationSummary, MarkerSummary } from '$lib/server/robot-arm-vision';

	interface Props {
		camera: string;
		markers: MarkerSummary[];
		calibration: CalibrationSummary | null;
		blocked: boolean;
		blockReason: string;
	}

	let { camera, markers, calibration, blocked, blockReason }: Props = $props();

	interface Draft {
		markerId: string;
		x: number;
		y: number;
	}

	let frame = $state<GrabbedFrame | null>(null);
	let drafts = $state<Draft[]>([]);
	let selectedId = $state<string | null>(null);
	let placingId = $state<string | null>(null);
	let snap = $state(true);
	let busy = $state(false);
	let saving = $state(false);
	let error = $state<string | null>(null);
	let info = $state<string | null>(null);
	let depthPreview = $state<Record<string, number | null> | null>(null);
	let depthNote = $state<string | null>(null);
	let positionPx = $state<number | null>(null);
	let depthMm = $state<number>(DEFAULT_DEPTH_TOLERANCE_MM);
	let note = $state('');

	const activeMarkers = $derived(markers.filter((m) => !m.archived));
	const markerById = $derived(new Map(markers.map((m) => [m._id, m])));
	const calibratedColor = $derived(new Map((calibration?.placements ?? []).map((p) => [p.markerId, p.color])));
	const unplaced = $derived(activeMarkers.filter((m) => !drafts.some((d) => d.markerId === m._id)));

	/** Colour the camera sees under each draft — what will be stored. */
	const sampled = $derived.by(() => {
		const out = new Map<string, Rgb | null>();
		if (!frame) return out;
		const r = Math.max(2, Math.round(frame.width * 0.005));
		for (const d of drafts) out.set(d.markerId, samplePatch(frame.image, d.x * frame.width, d.y * frame.height, r));
		return out;
	});

	const stageMarkers = $derived<StageMarker[]>(
		drafts.map((d) => {
			const m = markerById.get(d.markerId);
			return {
				id: d.markerId,
				label: m?.name ?? '?',
				color: m ? rgbToHex(m.color) : '#888',
				x: d.x,
				y: d.y,
				status: d.markerId === selectedId ? 'selected' : 'placed'
			};
		})
	);

	// Calibration is per camera: switching camera drops the frozen frame.
	$effect(() => {
		void camera;
		// untrack: clearFrame reads `frame`, which must not re-run this on every freeze.
		untrack(clearFrame);
	});

	$effect(() => () => {
		if (frame) URL.revokeObjectURL(frame.url);
	});

	function clearFrame() {
		if (frame) URL.revokeObjectURL(frame.url);
		frame = null;
		drafts = [];
		selectedId = null;
		placingId = null;
		depthPreview = null;
		depthNote = null;
	}

	/** Find the sticker near (x, y): the calibrated colour first, then the registry swatch, then whatever is under the drop. */
	function snapAt(markerId: string, x: number, y: number, radius = 0.03): { x: number; y: number; found: boolean } {
		if (!frame) return { x, y, found: false };
		const W = frame.width;
		const H = frame.height;
		const candidates: Rgb[] = [];
		const cal = calibratedColor.get(markerId);
		if (cal) candidates.push(cal);
		const reg = markerById.get(markerId)?.color;
		if (reg) candidates.push(reg);
		const under = samplePatch(frame.image, x * W, y * H, Math.max(2, Math.round(W * 0.005)));
		if (under && !isLowSaturation(under)) candidates.push(under);
		for (const c of candidates) {
			const hit = trackMarker(frame.image, c, { x: x * W, y: y * H }, { searchRadiusPx: radius * W });
			if (hit) return { x: hit.x / W, y: hit.y / H, found: true };
		}
		return { x, y, found: false };
	}

	async function freeze() {
		if (!camera) return;
		busy = true;
		error = null;
		info = null;
		try {
			const f = await grabFrame(camera);
			const hadFrame = !!frame;
			const keep = drafts;
			if (frame) URL.revokeObjectURL(frame.url);
			frame = f;
			positionPx ??= Math.max(3, Math.round((calibration?.tolerances.position ?? DEFAULT_POSITION_TOLERANCE) * f.width));
			if (calibration && !hadFrame) depthMm = calibration.tolerances.depthMm;
			depthPreview = null;
			// Recalibration starts from the current calibration's spots (or the
			// drafts already on screen, on a re-freeze) and re-finds each one.
			const seed: Draft[] = hadFrame
				? keep
				: (calibration?.placements ?? []).filter((p) => markerById.get(p.markerId) && !markerById.get(p.markerId)!.archived).map((p) => ({ markerId: p.markerId, x: p.x, y: p.y }));
			drafts = seed;
			if (seed.length) refindAll();
		} catch (e) {
			error = e instanceof Error ? e.message : 'Could not grab a frame';
		} finally {
			busy = false;
		}
	}

	function refindAll() {
		if (!frame) return;
		let found = 0;
		drafts = drafts.map((d) => {
			const s = snapAt(d.markerId, d.x, d.y, DEFAULT_SEARCH_RADIUS * 1.5);
			if (s.found) found++;
			return { ...d, x: s.x, y: s.y };
		});
		info = `Re-found ${found} of ${drafts.length} marker(s) on this frame.${found < drafts.length ? ' Drag the rest onto their stickers.' : ''}`;
	}

	function place(x: number, y: number) {
		if (!placingId) {
			selectedId = null;
			return;
		}
		const id = placingId;
		const s = snap ? snapAt(id, x, y) : { x, y, found: false };
		drafts = [...drafts.filter((d) => d.markerId !== id), { markerId: id, x: s.x, y: s.y }];
		selectedId = id;
		// Move straight on to the next unplaced marker: placing a dozen stickers is click, click, click.
		const next = unplaced.find((m) => m._id !== id);
		placingId = next?._id ?? null;
		if (snap && !s.found) info = `${markerById.get(id)?.name}: no sticker of that colour right there — placed where you clicked. Drag to adjust.`;
	}

	function moveDraft(id: string, x: number, y: number) {
		drafts = drafts.map((d) => (d.markerId === id ? { ...d, x, y } : d));
	}

	function dropDraft(id: string, x: number, y: number) {
		if (!snap) return moveDraft(id, x, y);
		const s = snapAt(id, x, y);
		moveDraft(id, s.x, s.y);
	}

	function nudge(id: string, dx: number, dy: number) {
		if (!frame) return;
		drafts = drafts.map((d) =>
			d.markerId === id ? { ...d, x: Math.min(1, Math.max(0, d.x + dx / frame!.width)), y: Math.min(1, Math.max(0, d.y + dy / frame!.height)) } : d
		);
	}

	function remove(id: string) {
		drafts = drafts.filter((d) => d.markerId !== id);
		if (selectedId === id) selectedId = null;
	}

	async function readDepth() {
		if (!frame || !drafts.length) return;
		const d = await fetchDepth(camera, drafts.map((p) => [p.x, p.y]));
		const next: Record<string, number | null> = {};
		drafts.forEach((p, i) => (next[p.markerId] = d.depth[i]));
		depthPreview = next;
		depthNote = d.available ? null : (d.reason ?? 'The camera reports no depth.');
	}

	function onKey(e: KeyboardEvent) {
		if (!selectedId || !frame) return;
		const step = e.shiftKey ? 5 : 1;
		const map: Record<string, [number, number]> = { ArrowLeft: [-step, 0], ArrowRight: [step, 0], ArrowUp: [0, -step], ArrowDown: [0, step] };
		const m = map[e.key];
		if (!m) return;
		const t = e.target as HTMLElement | null;
		if (t && ['INPUT', 'TEXTAREA', 'SELECT'].includes(t.tagName)) return;
		e.preventDefault();
		nudge(selectedId, m[0], m[1]);
	}

	const submitSave = (({ formData, cancel }: { formData: FormData; cancel: () => void }) => {
		if (!frame) return cancel();
		formData.set('frame', frame.blob, 'calibration.jpg');
		saving = true;
		return async ({ result, update }: { result: { type: string }; update: (o?: { reset?: boolean }) => Promise<void> }) => {
			await update({ reset: false });
			saving = false;
			if (result.type === 'success') {
				clearFrame();
				note = '';
			}
		};
	}) as any;
</script>

<svelte:window onkeydown={onKey} />

<section class="rounded border p-3 sm:p-4" style="border-color: var(--color-tron-border); background: var(--color-tron-surface);">
	<div class="flex flex-wrap items-start justify-between gap-3">
		<div>
			<h2 class="text-sm font-semibold tracking-wide" style="color: var(--color-tron-text)">CALIBRATE MARKERS</h2>
			<p class="max-w-2xl text-xs" style="color: var(--color-tron-text-secondary)">
				Park the arm at home, freeze a frame, and put each marker on its sticker. Recalibrate whenever the camera
				moves or anything about the arm or its surroundings changes.
			</p>
		</div>
		<div class="flex flex-wrap items-center gap-2">
			<button
				type="button"
				onclick={freeze}
				disabled={busy || !camera}
				class="min-h-[40px] rounded px-4 text-sm font-semibold disabled:cursor-not-allowed disabled:opacity-40"
				style="background: rgba(56,189,248,0.15); color: var(--color-tron-cyan); border: 1px solid var(--color-tron-cyan);"
			>
				{busy ? 'Grabbing…' : frame ? 'Freeze a new frame' : calibration ? 'Freeze frame to recalibrate' : 'Freeze frame'}
			</button>
			{#if frame}
				<button type="button" onclick={clearFrame} class="min-h-[40px] px-2 text-xs" style="color: var(--color-tron-text-secondary)">discard</button>
			{/if}
		</div>
	</div>

	{#if error}<p class="mt-2 text-xs text-red-300">{error}</p>{/if}
	{#if info}<p class="mt-2 text-xs" style="color: var(--color-tron-text-secondary)">{info}</p>{/if}

	{#if !activeMarkers.length}
		<p class="mt-3 text-xs" style="color: #f59e0b">Register your markers first (Marker registry, below) — one per sticker.</p>
	{/if}

	{#if frame}
		<div class="mt-3 grid gap-4 lg:grid-cols-[minmax(0,3fr)_minmax(0,2fr)]">
			<div class="space-y-2">
				<VisionStage
					src={frame.url}
					width={frame.width}
					height={frame.height}
					markers={stageMarkers}
					editable
					placing={!!placingId}
					alt="Frozen calibration frame"
					onframeclick={place}
					onmove={moveDraft}
					ondrop={dropDraft}
					onselect={(id) => (selectedId = id)}
				/>
				<div class="flex flex-wrap items-center gap-3 text-xs" style="color: var(--color-tron-text-secondary)">
					<label class="flex items-center gap-1"><input type="checkbox" bind:checked={snap} /> snap to sticker</label>
					{#if drafts.length}
						<button type="button" onclick={refindAll} class="underline" style="color: var(--color-tron-cyan)">re-find all</button>
						<button type="button" onclick={readDepth} class="underline" style="color: var(--color-tron-cyan)">read depth</button>
					{/if}
					<span>{frame.width}×{frame.height} · selected marker: arrow keys nudge 1 px (shift 5)</span>
				</div>
				{#if depthNote}<p class="text-xs" style="color: #f59e0b">Depth: {depthNote}</p>{/if}
			</div>

			<div class="space-y-3">
				{#if unplaced.length}
					<div>
						<p class="mb-1 text-xs font-semibold" style="color: var(--color-tron-text)">To place — pick one, then click its sticker</p>
						<div class="flex flex-wrap gap-1.5">
							{#each unplaced as m (m._id)}
								<button
									type="button"
									onclick={() => (placingId = placingId === m._id ? null : m._id)}
									class="flex min-h-[32px] items-center gap-1.5 rounded border px-2 text-xs"
									style="border-color: {placingId === m._id ? 'var(--color-tron-cyan)' : 'var(--color-tron-border)'}; color: var(--color-tron-text); background: {placingId === m._id ? 'rgba(56,189,248,0.15)' : 'transparent'};"
								>
									<span class="inline-block h-3 w-3 rounded-full" style="background: {rgbToHex(m.color)}"></span>
									{m.name}
									{#if m.group}<span style="color: var(--color-tron-text-secondary)">· {m.group}</span>{/if}
								</button>
							{/each}
						</div>
						{#if placingId}
							<p class="mt-1 text-xs" style="color: var(--color-tron-cyan)">Click the {markerById.get(placingId)?.name} sticker on the frame.</p>
						{/if}
					</div>
				{/if}

				{#if drafts.length}
					<table class="w-full text-xs">
						<thead>
							<tr class="text-left" style="color: var(--color-tron-text-secondary)">
								<th class="py-1 pr-2 font-medium">Placed</th>
								<th class="py-1 pr-2 font-medium">Seen as</th>
								<th class="py-1 pr-2 text-right font-medium">x, y</th>
								<th class="py-1 pr-2 text-right font-medium">depth</th>
								<th></th>
							</tr>
						</thead>
						<tbody>
							{#each drafts as d (d.markerId)}
								{@const m = markerById.get(d.markerId)}
								{@const s = sampled.get(d.markerId)}
								<tr
									class="cursor-pointer border-t"
									style="border-color: var(--color-tron-border); background: {selectedId === d.markerId ? 'rgba(56,189,248,0.08)' : 'transparent'}"
									onclick={() => (selectedId = d.markerId)}
								>
									<td class="py-1 pr-2" style="color: var(--color-tron-text)">{m?.name}</td>
									<td class="py-1 pr-2">
										{#if s}
											<span class="inline-block h-3 w-5 rounded-sm align-middle" style="background: {rgbToHex(s)}" title={rgbToHex(s)}></span>
											{#if isLowSaturation(s)}<span class="ml-1" style="color: #f59e0b" title="Reads as grey on camera — not on a coloured sticker?">grey?</span>{/if}
										{/if}
									</td>
									<td class="py-1 pr-2 text-right font-mono" style="color: var(--color-tron-text)">{Math.round(d.x * frame.width)}, {Math.round(d.y * frame.height)}</td>
									<td class="py-1 pr-2 text-right font-mono" style="color: var(--color-tron-text)">
										{depthPreview ? (depthPreview[d.markerId] != null ? `${Math.round(depthPreview[d.markerId]!)} mm` : '—') : ''}
									</td>
									<td class="py-1 text-right">
										<button type="button" onclick={(e) => { e.stopPropagation(); remove(d.markerId); }} class="px-1" style="color: var(--color-tron-text-secondary)" title="Remove from this calibration">✕</button>
									</td>
								</tr>
							{/each}
						</tbody>
					</table>
				{/if}

				<form method="POST" action="?/saveCalibration" enctype="multipart/form-data" use:enhance={submitSave} class="space-y-2 rounded border p-3" style="border-color: var(--color-tron-border); background: rgba(0,0,0,0.25)">
					<input type="hidden" name="camera" value={camera} />
					<input type="hidden" name="frameWidth" value={frame.width} />
					<input type="hidden" name="placements" value={JSON.stringify(drafts)} />
					<div class="grid grid-cols-2 gap-2">
						<label class="block text-xs" style="color: var(--color-tron-text-secondary)">
							Position tolerance (px)
							<input name="positionPx" type="number" min="1" max="200" bind:value={positionPx} class="mt-1 w-full rounded border bg-black/40 px-2 py-1 text-sm" style="border-color: var(--color-tron-border); color: var(--color-tron-text)" />
						</label>
						<label class="block text-xs" style="color: var(--color-tron-text-secondary)">
							Depth tolerance (mm)
							<input name="depthMm" type="number" min="1" max="999" bind:value={depthMm} class="mt-1 w-full rounded border bg-black/40 px-2 py-1 text-sm" style="border-color: var(--color-tron-border); color: var(--color-tron-text)" />
						</label>
					</div>
					<label class="block text-xs" style="color: var(--color-tron-text-secondary)">
						Note (optional)
						<input name="note" bind:value={note} placeholder="e.g. camera moved to the new bracket" class="mt-1 w-full rounded border bg-black/40 px-2 py-1 text-sm" style="border-color: var(--color-tron-border); color: var(--color-tron-text)" />
					</label>
					<button
						type="submit"
						disabled={saving || blocked || !drafts.length}
						class="min-h-[44px] w-full rounded px-4 text-sm font-semibold disabled:cursor-not-allowed disabled:opacity-40"
						style="background: rgba(74,222,128,0.12); color: #4ade80; border: 1px solid #4ade80;"
					>
						{saving ? 'Saving…' : `Save calibration (${drafts.length} marker${drafts.length === 1 ? '' : 's'})`}
					</button>
					{#if blocked}<p class="text-xs" style="color: #f59e0b">{blockReason}</p>{/if}
					<p class="text-[11px]" style="color: var(--color-tron-text-secondary)">
						Keep the arm parked at home until this finishes: the arm's encoders and the depth at each marker are read
						when you save.{calibration ? ' This replaces the current calibration for this camera (the old one is kept in history).' : ''}
					</p>
				</form>
			</div>
		</div>
	{/if}
</section>
