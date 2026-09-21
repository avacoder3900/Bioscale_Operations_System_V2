<script lang="ts">
	interface Props {
		name: string;
		/** A palette KEY from GROUP_COLOR_KEYS, never a hex. */
		color: string;
		count?: number | null;
		muted?: boolean;
		title?: string;
	}

	let { name, color, count = null, muted = false, title = undefined }: Props = $props();

	// colorKey -> a STATIC class string. Tailwind scans source text at build time and
	// cannot generate a class from a runtime value, so every variant has to appear
	// literally here. This is also why CartridgeGroup.color stores a key, not a hex:
	// an interpolated hex silently renders no colour at all.
	const CLASSES: Record<string, string> = {
		cyan: 'border-[var(--color-tron-cyan)]/50 bg-[var(--color-tron-cyan)]/15 text-[var(--color-tron-cyan)]',
		green:
			'border-[var(--color-tron-green)]/50 bg-[var(--color-tron-green)]/15 text-[var(--color-tron-green)]',
		purple:
			'border-[var(--color-tron-purple)]/50 bg-[var(--color-tron-purple)]/15 text-[var(--color-tron-purple)]',
		yellow:
			'border-[var(--color-tron-yellow)]/50 bg-[var(--color-tron-yellow)]/15 text-[var(--color-tron-yellow)]',
		orange:
			'border-[var(--color-tron-orange)]/50 bg-[var(--color-tron-orange)]/15 text-[var(--color-tron-orange)]',
		blue: 'border-[var(--color-tron-blue)]/50 bg-[var(--color-tron-blue)]/15 text-[var(--color-tron-blue)]'
	};

	const cls = $derived(CLASSES[color] ?? CLASSES.cyan);
</script>

<span
	class="inline-flex items-center gap-1 whitespace-nowrap rounded-full border px-2 py-0.5 text-[10px] font-semibold tracking-wide {cls} {muted
		? 'opacity-50'
		: ''}"
	{title}
>
	{name}{#if count != null}<span class="font-normal opacity-70">({count})</span>{/if}
</span>
