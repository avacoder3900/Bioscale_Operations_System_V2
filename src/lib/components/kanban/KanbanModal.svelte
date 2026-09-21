<script lang="ts">
	import type { Snippet } from 'svelte';

	interface Props {
		title: string;
		onclose: () => void;
		children: Snippet;
		maxWidth?: string;
	}

	let { title, onclose, children, maxWidth = 'max-w-lg' }: Props = $props();
</script>

<div
	class="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4"
	role="dialog"
	aria-modal="true"
>
	<div class="tron-card w-full {maxWidth}" style="max-height: 90vh; overflow-y: auto;">
		<div class="mb-4 flex items-center justify-between gap-3">
			<h2 class="tron-text-primary text-lg font-bold">{title}</h2>
			<button
				type="button"
				onclick={onclose}
				class="flex h-8 w-8 shrink-0 items-center justify-center rounded text-[var(--color-tron-text-secondary)] hover:text-[var(--color-tron-red)]"
				title="Close"
				aria-label="Close"
			>
				<svg class="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
					<path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M6 18L18 6M6 6l12 12" />
				</svg>
			</button>
		</div>
		{@render children()}
	</div>
</div>
