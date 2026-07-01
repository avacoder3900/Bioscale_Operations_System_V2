<script lang="ts">
	/**
	 * PhotoAnnotatorModal — full-screen overlay that opens a captured photo in the
	 * PhotoHighlighter so an operator can draw yellow highlight boxes on it.
	 *
	 * Render once per page and drive it with a nullable `url`: set it to open,
	 * call `onclose` (which should null it out) to dismiss. Escape / backdrop
	 * click / the ✕ button all close.
	 */
	import PhotoHighlighter from './PhotoHighlighter.svelte';

	interface Props {
		url: string | null;
		alt?: string;
		onclose: () => void;
	}

	let { url, alt = 'photo', onclose }: Props = $props();

	function onKey(e: KeyboardEvent) {
		if (url && e.key === 'Escape') onclose();
	}
</script>

<svelte:window onkeydown={onKey} />

{#if url}
	<!-- svelte-ignore a11y_click_events_have_key_events -->
	<!-- svelte-ignore a11y_no_static_element_interactions -->
	<div
		class="fixed inset-0 z-50 flex items-center justify-center bg-black/90 p-4"
		onclick={onclose}
		role="presentation"
	>
		<!-- svelte-ignore a11y_click_events_have_key_events -->
		<!-- svelte-ignore a11y_no_static_element_interactions -->
		<div
			class="max-h-full max-w-5xl overflow-auto rounded-lg border border-[var(--color-tron-border)] bg-[var(--color-tron-bg-secondary)] p-4"
			onclick={(e) => e.stopPropagation()}
			role="presentation"
		>
			<div class="mb-3 flex items-center justify-between gap-4">
				<h3 class="text-sm font-semibold uppercase tracking-wider text-[var(--color-tron-cyan)]">
					Highlight photo
				</h3>
				<button
					type="button"
					onclick={onclose}
					class="rounded px-2 py-1 text-[var(--color-tron-text-secondary)] hover:bg-[var(--color-tron-bg-tertiary)]"
				>
					✕
				</button>
			</div>
			<PhotoHighlighter src={url} {alt} imgClass="block max-h-[75vh] w-auto rounded" />
		</div>
	</div>
{/if}
