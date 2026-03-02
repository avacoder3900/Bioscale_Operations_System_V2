<script lang="ts">
	import type { HTMLInputAttributes } from 'svelte/elements';

	interface Props extends HTMLInputAttributes {
		label?: string;
		error?: string;
		class?: string;
	}

	let { label, error, class: className = '', id, type = 'text', ...restProps }: Props = $props();

	let inputId = $derived(id ?? `input-${Math.random().toString(36).slice(2, 9)}`);
	let inputClass = $derived(error ? 'tron-input tron-input-error' : 'tron-input');
</script>

<div class="w-full {className}">
	{#if label}
		<label for={inputId} class="tron-label">{label}</label>
	{/if}
	<input {type} id={inputId} class={inputClass} {...restProps} />
	{#if error}
		<p class="tron-text-error mt-1 text-sm">{error}</p>
	{/if}
</div>
