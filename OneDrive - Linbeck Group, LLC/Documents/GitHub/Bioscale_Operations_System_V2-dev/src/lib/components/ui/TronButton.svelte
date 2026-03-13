<script lang="ts">
	import type { Snippet } from 'svelte';
	import type { HTMLButtonAttributes } from 'svelte/elements';

	interface Props extends HTMLButtonAttributes {
		children: Snippet;
		variant?: 'default' | 'primary' | 'danger';
		class?: string;
	}

	let {
		children,
		variant = 'default',
		class: className = '',
		disabled = false,
		type = 'button',
		...restProps
	}: Props = $props();

	let buttonClass = $derived(
		variant === 'primary'
			? 'tron-button-primary'
			: variant === 'danger'
				? 'tron-button-danger'
				: 'tron-button'
	);
</script>

<button class="{buttonClass} {className}" {disabled} {type} {...restProps}>
	{@render children()}
</button>
