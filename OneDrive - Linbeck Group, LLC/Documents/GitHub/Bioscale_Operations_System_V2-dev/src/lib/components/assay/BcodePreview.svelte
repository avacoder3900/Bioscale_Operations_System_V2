<script lang="ts">
	interface Props {
		bcodeString: string;
		bcodeLength: number;
		estimatedDuration: number;
	}

	let { bcodeString, bcodeLength, estimatedDuration }: Props = $props();

	function formatDuration(ms: number): string {
		if (ms < 1000) return `${ms}ms`;
		const seconds = ms / 1000;
		if (seconds < 60) return `${seconds.toFixed(1)}s`;
		const minutes = Math.floor(seconds / 60);
		const remainingSeconds = Math.round(seconds % 60);
		return `${minutes}m ${remainingSeconds}s`;
	}

	let formattedBcode = $derived(
		bcodeString
			.split('|')
			.map((instr, i) => `${String(i).padStart(3, ' ')}: ${instr}`)
			.join('\n')
	);
</script>

<div class="tron-card space-y-3 p-4">
	<h3 class="text-sm font-bold" style="color: var(--color-tron-cyan, #00ffff)">
		BCODE Preview
	</h3>

	<div class="flex gap-4 text-xs">
		<div>
			<span style="color: var(--color-tron-text-secondary)">Length:</span>
			<span class="font-mono font-bold" style="color: var(--color-tron-cyan, #00ffff)">{bcodeLength} bytes</span>
		</div>
		<div>
			<span style="color: var(--color-tron-text-secondary)">Est. Duration:</span>
			<span class="font-mono font-bold" style="color: var(--color-tron-orange, #f97316)">{formatDuration(estimatedDuration)}</span>
		</div>
		<div>
			<span style="color: var(--color-tron-text-secondary)">Instructions:</span>
			<span class="font-mono font-bold">{bcodeString.split('|').length}</span>
		</div>
	</div>

	<!-- Raw BCODE string -->
	<div class="rounded p-3" style="background: rgba(0,0,0,0.4); border: 1px solid var(--color-tron-border, #333)">
		<p class="mb-1 text-xs font-bold" style="color: var(--color-tron-text-secondary)">Raw BCODE</p>
		<code class="block break-all text-xs" style="color: var(--color-tron-green, #39ff14)">
			{bcodeString}
		</code>
	</div>

	<!-- Formatted instruction list -->
	<div class="rounded p-3" style="background: rgba(0,0,0,0.4); border: 1px solid var(--color-tron-border, #333)">
		<p class="mb-1 text-xs font-bold" style="color: var(--color-tron-text-secondary)">Instructions</p>
		<pre class="whitespace-pre text-xs" style="color: var(--color-tron-text-primary, #e5e7eb)">{formattedBcode}</pre>
	</div>
</div>
