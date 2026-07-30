<script lang="ts">
	// Three states, never two. Collapsing "no SPU record matched this device" into
	// "uncalibrated" would be a lie, and this column exists precisely so that an
	// uncalibrated SPU is visibly explained rather than silently flagged as an outlier.
	interface Props {
		status: 'calibrated' | 'uncalibrated' | 'unknown';
		reason: string;
	}
	let { status, reason }: Props = $props();

	const LABEL = { calibrated: 'CAL', uncalibrated: 'NO CAL', unknown: '?' } as const;

	const CLASSES = {
		calibrated:
			'border-[var(--color-tron-green)]/50 bg-[var(--color-tron-green)]/10 text-[var(--color-tron-green)]',
		uncalibrated:
			'border-[var(--color-tron-text-secondary)]/40 text-[var(--color-tron-text-secondary)]',
		// Neutral grey — never a red X. "Unknown" is not a failure.
		unknown: 'border-[var(--color-tron-border)] text-[var(--color-tron-text-secondary)]'
	} as const;
</script>

<span
	class="cursor-help whitespace-nowrap rounded border px-1.5 py-0.5 text-[10px] font-semibold tracking-wide {CLASSES[
		status
	]}"
	title={reason}
>
	{LABEL[status]}
</span>
