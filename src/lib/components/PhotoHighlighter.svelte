<script lang="ts">
	/**
	 * PhotoHighlighter — draw yellow outline boxes on a photo.
	 *
	 * Toggle the "Highlight" button, then click two opposite corners to drop a
	 * box. The box is a yellow border only — its interior stays transparent so
	 * the photo underneath is fully visible. Boxes are stored as normalized
	 * [0..1] coordinates so they track the image as it scales, and they reset
	 * automatically whenever `src` changes (e.g. navigating to another photo).
	 *
	 * Annotations are an on-screen overlay only; nothing is persisted.
	 */

	interface Box {
		x: number; // normalized left  (0..1)
		y: number; // normalized top   (0..1)
		w: number; // normalized width (0..1)
		h: number; // normalized height(0..1)
	}

	interface Props {
		src: string | null | undefined;
		alt?: string;
		/** Tailwind classes applied to the <img> — control the display size here. */
		imgClass?: string;
		/** Extra classes on the outer wrapper. */
		class?: string;
		/**
		 * CvImage id. When provided, a "Save to photo" button appears that burns
		 * the boxes into the stored image via /api/cv/images/[id]/highlight.
		 */
		imageId?: string | null;
		/** Called with the new image URL after a successful save. */
		onsaved?: (url: string) => void;
	}

	let {
		src,
		alt = 'photo',
		imgClass = 'block max-h-[70vh] w-auto rounded',
		class: className = '',
		imageId = null,
		onsaved
	}: Props = $props();

	const BOX_COLOR = 'var(--color-tron-yellow,#facc15)';
	// Ignore boxes smaller than this (fraction of the image) — usually a stray
	// double-click rather than a deliberate drag corner-to-corner.
	const MIN_SIZE = 0.005;

	let highlighting = $state(false);
	let boxes = $state<Box[]>([]);
	let wrapEl = $state<HTMLDivElement | null>(null);

	// Drawing state: `start` is the first committed corner; `cursor` follows the
	// pointer so we can rubber-band a live preview until the second click.
	let start = $state<{ x: number; y: number } | null>(null);
	let cursor = $state<{ x: number; y: number } | null>(null);

	// Fresh photo → clear any annotations from the previous one.
	$effect(() => {
		src; // track
		boxes = [];
		start = null;
		cursor = null;
	});

	function toNorm(e: MouseEvent): { x: number; y: number } | null {
		if (!wrapEl) return null;
		const rect = wrapEl.getBoundingClientRect();
		if (rect.width === 0 || rect.height === 0) return null;
		const x = (e.clientX - rect.left) / rect.width;
		const y = (e.clientY - rect.top) / rect.height;
		return { x: Math.min(1, Math.max(0, x)), y: Math.min(1, Math.max(0, y)) };
	}

	function boxFrom(a: { x: number; y: number }, b: { x: number; y: number }): Box {
		return {
			x: Math.min(a.x, b.x),
			y: Math.min(a.y, b.y),
			w: Math.abs(a.x - b.x),
			h: Math.abs(a.y - b.y)
		};
	}

	function onOverlayClick(e: MouseEvent) {
		if (!highlighting) return;
		const p = toNorm(e);
		if (!p) return;
		if (!start) {
			// First corner.
			start = p;
			cursor = p;
		} else {
			// Second corner — commit the box unless it's a stray tiny one.
			const box = boxFrom(start, p);
			if (box.w >= MIN_SIZE && box.h >= MIN_SIZE) boxes = [...boxes, box];
			start = null;
			cursor = null;
		}
	}

	function onOverlayMove(e: MouseEvent) {
		if (!highlighting || !start) return;
		cursor = toNorm(e);
	}

	// Right-click cancels an in-progress box without dropping it.
	function onOverlayContext(e: MouseEvent) {
		if (!highlighting || !start) return;
		e.preventDefault();
		start = null;
		cursor = null;
	}

	function toggleHighlight() {
		highlighting = !highlighting;
		start = null;
		cursor = null;
	}

	function clearBoxes() {
		boxes = [];
		start = null;
		cursor = null;
	}

	function removeBox(i: number) {
		boxes = boxes.filter((_, idx) => idx !== i);
	}

	// ── Save (burn boxes into the stored photo) ─────────────────────────────
	let saving = $state(false);
	let saveError = $state<string | null>(null);

	async function save() {
		if (!imageId || boxes.length === 0 || saving) return;
		saving = true;
		saveError = null;
		try {
			const res = await fetch(`/api/cv/images/${encodeURIComponent(imageId)}/highlight`, {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ boxes })
			});
			const data = await res.json().catch(() => ({}));
			if (!res.ok || !data.imageUrl) {
				throw new Error(data.error || `HTTP ${res.status}`);
			}
			// The boxes are now baked into the pixels — hand the new URL up so the
			// parent swaps src (which resets our overlay via the src $effect).
			highlighting = false;
			onsaved?.(data.imageUrl as string);
		} catch (e) {
			saveError = e instanceof Error ? e.message : 'Save failed';
		} finally {
			saving = false;
		}
	}

	const preview = $derived(start && cursor ? boxFrom(start, cursor) : null);

	function boxStyle(b: Box): string {
		return `left:${b.x * 100}%;top:${b.y * 100}%;width:${b.w * 100}%;height:${b.h * 100}%;border-color:${BOX_COLOR};`;
	}
</script>

<div class="space-y-2 {className}">
	<!-- Toolbar -->
	<div class="flex flex-wrap items-center gap-2">
		<button
			type="button"
			onclick={toggleHighlight}
			class="rounded border px-3 py-1.5 text-sm font-medium transition-colors
				{highlighting
					? 'border-[var(--color-tron-yellow,#facc15)] bg-[rgba(250,204,21,0.15)] text-[var(--color-tron-yellow,#facc15)]'
					: 'border-[var(--color-tron-border)] text-[var(--color-tron-text-secondary)] hover:border-[var(--color-tron-yellow,#facc15)] hover:text-[var(--color-tron-yellow,#facc15)]'}"
		>
			{highlighting ? '▣ Highlighting' : '▢ Highlight'}
		</button>

		{#if boxes.length > 0}
			<button
				type="button"
				onclick={clearBoxes}
				class="rounded border border-[var(--color-tron-border)] px-3 py-1.5 text-sm text-[var(--color-tron-text-secondary)] transition-colors hover:border-[var(--color-tron-red,#ff3366)] hover:text-[var(--color-tron-red,#ff3366)]"
			>
				Clear {boxes.length} box{boxes.length === 1 ? '' : 'es'}
			</button>
		{/if}

		{#if imageId && boxes.length > 0}
			<button
				type="button"
				onclick={save}
				disabled={saving}
				class="rounded border border-[var(--color-tron-green,#39ff14)] bg-[rgba(57,255,20,0.12)] px-3 py-1.5 text-sm font-semibold text-[var(--color-tron-green,#39ff14)] transition-colors hover:bg-[rgba(57,255,20,0.2)] disabled:opacity-40"
			>
				{saving ? 'Saving…' : '💾 Save to photo'}
			</button>
		{/if}

		{#if highlighting}
			<span class="text-xs text-[var(--color-tron-text-secondary)]">
				{start
					? 'Click the opposite corner (right-click cancels)'
					: 'Click the first corner of the area to highlight'}
			</span>
		{/if}
	</div>

	{#if saveError}
		<div class="rounded border border-[var(--color-tron-red,#ff3366)] bg-[rgba(255,51,102,0.08)] px-3 py-1.5 text-xs text-[var(--color-tron-red,#ff3366)]">
			{saveError}
		</div>
	{/if}

	<!-- Image + overlay. The wrapper hugs the image so % coords map to the photo. -->
	<div bind:this={wrapEl} class="relative inline-block select-none leading-none">
		{#if src}
			<img {src} {alt} class={imgClass} draggable="false" />
		{/if}

		<!-- svelte-ignore a11y_click_events_have_key_events -->
		<!-- svelte-ignore a11y_no_static_element_interactions -->
		<div
			class="absolute inset-0 {highlighting ? 'cursor-crosshair' : 'pointer-events-none'}"
			onclick={onOverlayClick}
			onmousemove={onOverlayMove}
			oncontextmenu={onOverlayContext}
			role="presentation"
		>
			{#each boxes as b, i (i)}
				<div class="group absolute border-2" style={boxStyle(b)}>
					{#if highlighting}
						<button
							type="button"
							onclick={(e) => {
								e.stopPropagation();
								removeBox(i);
							}}
							title="Remove this box"
							class="pointer-events-auto absolute -right-2.5 -top-2.5 flex h-5 w-5 items-center justify-center rounded-full border border-[var(--color-tron-yellow,#facc15)] bg-[var(--color-tron-bg-primary)] text-xs leading-none text-[var(--color-tron-yellow,#facc15)] opacity-0 transition-opacity group-hover:opacity-100"
						>
							✕
						</button>
					{/if}
				</div>
			{/each}

			{#if preview}
				<div class="absolute border-2 border-dashed" style={boxStyle(preview)}></div>
			{/if}
		</div>
	</div>
</div>
