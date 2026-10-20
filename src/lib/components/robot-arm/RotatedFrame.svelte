<script lang="ts">
	/**
	 * A box with a camera frame's aspect ratio, turned by `rotation` degrees.
	 *
	 * Children are laid out in the frame's own orientation (fill the inner
	 * box with absolute/inset-0 content) and the whole thing is rotated with a
	 * CSS transform, so overlays drawn in frame coordinates stay registered to
	 * the image. At 90/270 the outer box takes the swapped aspect ratio, so a
	 * 16:9 frame on its side lays out as a real 9:16 block, not a 16:9 box with
	 * a sideways picture clipped inside it.
	 *
	 * Sizing is all percentages of the outer box: for a quarter turn the inner
	 * box's width must equal the outer height (w/h of the outer width) and its
	 * height the outer width (h/w of the outer height).
	 */
	import type { Snippet } from 'svelte';

	interface Props {
		width: number;
		height: number;
		rotation: number;
		class?: string;
		style?: string;
		children: Snippet;
	}

	let { width, height, rotation, class: klass = '', style = '', children }: Props = $props();

	const w = $derived(width > 0 ? width : 4);
	const h = $derived(height > 0 ? height : 3);
	const quarter = $derived(rotation === 90 || rotation === 270);
</script>

<div class="relative w-full overflow-hidden {klass}" style="aspect-ratio: {quarter ? `${h} / ${w}` : `${w} / ${h}`}; {style}">
	<div
		class="absolute left-1/2 top-1/2"
		style="width: {quarter ? (100 * w) / h : 100}%; height: {quarter ? (100 * h) / w : 100}%; transform: translate(-50%, -50%) rotate({rotation}deg);"
	>
		{@render children()}
	</div>
</div>
