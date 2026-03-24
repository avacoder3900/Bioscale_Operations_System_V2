<script lang="ts">
	interface Props {
		type: 'deck' | 'tray';
		destination: 'oven' | 'fridge';
		deckId?: string;
		trayId?: string;
		temperatureC?: number | null;
	}

	let { type, destination, deckId, trayId, temperatureC = null }: Props = $props();

	const label = $derived(type === 'deck' ? `Deck ${deckId ?? ''}` : `Tray ${trayId ?? ''}`);
	const isHot = $derived(destination === 'oven');
</script>

<div class="rounded-lg border p-4 {isHot ? 'border-orange-500/40 bg-orange-950/20' : 'border-blue-500/40 bg-blue-950/20'}">
	<div class="flex items-center gap-4">
		<!-- Equipment SVG -->
		<div class="shrink-0">
			{#if type === 'deck'}
				<!-- Deck: burger/sandwich shape (two plates with screws) -->
				<svg width="80" height="60" viewBox="0 0 80 60" class="{isHot ? 'text-orange-400' : 'text-blue-400'}">
					<!-- Top plate -->
					<rect x="10" y="8" width="60" height="8" rx="2" fill="currentColor" opacity="0.7" />
					<!-- Screws -->
					<circle cx="16" cy="12" r="2.5" fill="currentColor" />
					<circle cx="64" cy="12" r="2.5" fill="currentColor" />
					<!-- Gap / cartridge area -->
					<rect x="14" y="16" width="52" height="20" rx="1" fill="currentColor" opacity="0.15" stroke="currentColor" stroke-width="0.5" stroke-dasharray="3,2" />
					<text x="40" y="29" text-anchor="middle" fill="currentColor" font-size="7" opacity="0.6">cartridges</text>
					<!-- Bottom plate -->
					<rect x="10" y="36" width="60" height="8" rx="2" fill="currentColor" opacity="0.7" />
					<!-- Bottom screws -->
					<circle cx="16" cy="40" r="2.5" fill="currentColor" />
					<circle cx="64" cy="40" r="2.5" fill="currentColor" />
					<!-- Label -->
					<text x="40" y="55" text-anchor="middle" fill="currentColor" font-size="8" font-weight="bold">{label.trim()}</text>
				</svg>
			{:else}
				<!-- Tray: flat open container -->
				<svg width="80" height="60" viewBox="0 0 80 60" class="{isHot ? 'text-orange-400' : 'text-blue-400'}">
					<!-- Tray body -->
					<path d="M8 20 L14 40 L66 40 L72 20 Z" fill="currentColor" opacity="0.15" stroke="currentColor" stroke-width="1.5" />
					<!-- Tray rim -->
					<line x1="8" y1="20" x2="72" y2="20" stroke="currentColor" stroke-width="2" />
					<!-- Cartridges inside -->
					{#each Array(6) as _, i}
						<rect x={18 + i * 8} y="25" width="5" height="12" rx="1" fill="currentColor" opacity="0.4" />
					{/each}
					<!-- Label -->
					<text x="40" y="55" text-anchor="middle" fill="currentColor" font-size="8" font-weight="bold">{label.trim()}</text>
				</svg>
			{/if}
		</div>

		<!-- Arrow -->
		<div class="flex flex-col items-center">
			<svg width="40" height="24" viewBox="0 0 40 24" class="{isHot ? 'text-orange-400' : 'text-blue-400'}">
				<line x1="0" y1="12" x2="30" y2="12" stroke="currentColor" stroke-width="2" />
				<polygon points="28,6 40,12 28,18" fill="currentColor" />
			</svg>
			<span class="text-[10px] font-medium {isHot ? 'text-orange-400' : 'text-blue-400'}">Place here</span>
		</div>

		<!-- Destination SVG -->
		<div class="shrink-0">
			{#if destination === 'oven'}
				<!-- Oven with heat waves -->
				<svg width="80" height="60" viewBox="0 0 80 60" class="text-orange-400">
					<!-- Oven body -->
					<rect x="10" y="10" width="60" height="40" rx="4" fill="currentColor" opacity="0.15" stroke="currentColor" stroke-width="1.5" />
					<!-- Door handle -->
					<line x1="60" y1="22" x2="60" y2="38" stroke="currentColor" stroke-width="2" stroke-linecap="round" />
					<!-- Heat waves -->
					<path d="M22 44 Q24 40 22 36 Q20 32 22 28" fill="none" stroke="currentColor" stroke-width="1.5" opacity="0.8" />
					<path d="M32 44 Q34 40 32 36 Q30 32 32 28" fill="none" stroke="currentColor" stroke-width="1.5" opacity="0.6" />
					<path d="M42 44 Q44 40 42 36 Q40 32 42 28" fill="none" stroke="currentColor" stroke-width="1.5" opacity="0.8" />
					<!-- Label -->
					<text x="36" y="22" text-anchor="middle" fill="currentColor" font-size="9" font-weight="bold">OVEN</text>
				</svg>
			{:else}
				<!-- Fridge with snowflake -->
				<svg width="80" height="60" viewBox="0 0 80 60" class="text-blue-400">
					<!-- Fridge body -->
					<rect x="10" y="5" width="60" height="50" rx="4" fill="currentColor" opacity="0.15" stroke="currentColor" stroke-width="1.5" />
					<!-- Door line -->
					<line x1="10" y1="30" x2="70" y2="30" stroke="currentColor" stroke-width="1" opacity="0.5" />
					<!-- Handle -->
					<line x1="60" y1="15" x2="60" y2="25" stroke="currentColor" stroke-width="2" stroke-linecap="round" />
					<!-- Snowflake -->
					<g transform="translate(35, 42)" fill="none" stroke="currentColor" stroke-width="1.5">
						<line x1="0" y1="-7" x2="0" y2="7" />
						<line x1="-6" y1="-3.5" x2="6" y2="3.5" />
						<line x1="-6" y1="3.5" x2="6" y2="-3.5" />
					</g>
					<!-- Label -->
					<text x="35" y="20" text-anchor="middle" fill="currentColor" font-size="9" font-weight="bold">FRIDGE</text>
				</svg>
			{/if}
		</div>
	</div>

	<!-- Temperature display -->
	{#if temperatureC != null}
		<div class="mt-2 text-center text-sm font-mono {isHot ? 'text-orange-300' : 'text-blue-300'}">
			{temperatureC.toFixed(1)}°C
		</div>
	{/if}
</div>
