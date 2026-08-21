<script lang="ts">
	import type { Snippet } from 'svelte';
	import type { HTMLButtonAttributes } from 'svelte/elements';

	interface Props extends HTMLButtonAttributes {
		children: Snippet;
		variant?: 'default' | 'primary' | 'danger' | 'ghost';
		/** 'sm' = compact card-action size (kanban board cards). */
		size?: 'md' | 'sm';
		class?: string;
	}

	let {
		children,
		variant = 'default',
		size = 'md',
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
				: variant === 'ghost'
					? 'tron-button-ghost'
					: 'tron-button'
	);
</script>

<button class="{buttonClass} {size === 'sm' ? '!min-h-0 !px-2 !py-0.5 !text-xs !font-medium' : ''} {className}" {disabled} {type} {...restProps}>
	{@render children()}
</button>
