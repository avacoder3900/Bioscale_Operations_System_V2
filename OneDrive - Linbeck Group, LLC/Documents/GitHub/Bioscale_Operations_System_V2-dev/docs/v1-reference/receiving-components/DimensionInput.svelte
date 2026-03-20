<script lang="ts">
	interface Props {
		value: string | null;
		nominal: number | null;
		tolerance: number | null;
		unit: string | null;
		toolId: string | null;
		photoUrl: string | null;
		onchange: (value: string, result: 'pass' | 'fail' | 'manual_review') => void;
	}

	let { value, nominal, tolerance, unit, toolId, photoUrl, onchange }: Props = $props();

	let photoExpanded = $state(false);

	const isManualReview = $derived(nominal == null || tolerance == null);

	const validation = $derived.by(() => {
		if (value == null || value === '') return null;
		if (isManualReview) return 'manual_review' as const;
		const num = parseFloat(value);
		if (isNaN(num)) return null;
		return Math.abs(num - nominal!) <= tolerance! ? ('pass' as const) : ('fail' as const);
	});

	function handleInput(e: Event) {
		const input = e.target as HTMLInputElement;
		const v = input.value;
		if (v === '') return;
		const result = isManualReview
			? 'manual_review'
			: (() => {
					const num = parseFloat(v);
					if (isNaN(num)) return 'fail' as const;
					return Math.abs(num - nominal!) <= tolerance! ? ('pass' as const) : ('fail' as const);
				})();
		onchange(v, result);
	}
</script>

<div class="space-y-2">
	<!-- Spec display -->
	{#if isManualReview}
		<div class="rounded bg-yellow-500/10 px-3 py-2 text-xs text-yellow-400">
			Manual review required — no nominal/tolerance defined
		</div>
	{:else}
		<div class="tron-text-muted text-xs">
			Nominal: <span class="tron-text font-medium">{nominal}</span>
			±<span class="tron-text font-medium">{tolerance}</span>
			{#if unit}<span class="ml-1">{unit}</span>{/if}
		</div>
	{/if}

	<!-- Tool reference -->
	{#if toolId}
		<div class="tron-text-muted text-xs">
			Tool: <span class="font-mono text-[var(--color-tron-cyan)]">{toolId}</span>
		</div>
	{/if}

	<!-- Numeric input -->
	<div class="relative">
		<input
			type="number"
			step="any"
			{value}
			oninput={handleInput}
			placeholder={isManualReview ? 'Enter measurement...' : `Expected: ${nominal}`}
			class="tron-input w-full px-3 py-3 text-sm {validation === 'pass'
				? 'ring-1 ring-green-500/50'
				: validation === 'fail'
					? 'ring-1 ring-red-500/50'
					: validation === 'manual_review'
						? 'ring-1 ring-yellow-500/50'
						: ''}"
		/>
		{#if unit && value}
			<span
				class="tron-text-muted pointer-events-none absolute top-1/2 right-3 -translate-y-1/2 text-xs"
			>
				{unit}
			</span>
		{/if}
	</div>

	<!-- Validation feedback -->
	{#if validation === 'pass'}
		<div class="text-xs text-green-400">Within tolerance</div>
	{:else if validation === 'fail'}
		<div class="text-xs text-red-400">Outside tolerance</div>
	{:else if validation === 'manual_review'}
		<div class="text-xs text-yellow-400">Recorded — requires manual review</div>
	{/if}

	<!-- Reference photo -->
	{#if photoUrl}
		<button
			type="button"
			onclick={() => (photoExpanded = !photoExpanded)}
			class="tron-text-muted text-xs hover:underline"
		>
			{photoExpanded ? 'Hide' : 'Show'} reference photo
		</button>
		{#if photoExpanded}
			<img
				src={photoUrl}
				alt="Reference"
				class="max-h-64 rounded border border-[var(--color-tron-border)]"
			/>
		{/if}
	{/if}
</div>
