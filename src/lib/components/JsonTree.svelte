<script lang="ts">
	import Self from './JsonTree.svelte';
	// Lightweight, dependency-free collapsible JSON viewer. Mirrors the research
	// app's "view the cartridge data" pathway (a JSONEditor dump) but styled to
	// match BIMS and without pulling in svelte-jsoneditor.
	interface Props {
		value: unknown;
		name?: string | null;
		/** Objects/arrays at depth <= this start expanded. */
		defaultOpenDepth?: number;
		depth?: number;
	}

	let { value, name = null, defaultOpenDepth = 1, depth = 0 }: Props = $props();

	const isObject = $derived(value !== null && typeof value === 'object');
	const isArray = $derived(Array.isArray(value));
	const entries = $derived(
		isObject ? Object.entries(value as Record<string, unknown>) : []
	);

	let open = $state(depth < defaultOpenDepth);

	function summary(v: unknown): string {
		if (Array.isArray(v)) return `Array(${v.length})`;
		if (v && typeof v === 'object') return `{${Object.keys(v as object).length}}`;
		return '';
	}

	function fmtPrimitive(v: unknown): string {
		if (v === null) return 'null';
		if (v === undefined) return 'undefined';
		if (typeof v === 'string') return `"${v}"`;
		return String(v);
	}

	function primitiveClass(v: unknown): string {
		if (v === null || v === undefined) return 'text-[var(--color-tron-text-secondary)] italic';
		if (typeof v === 'number') return 'text-[var(--color-tron-cyan)]';
		if (typeof v === 'boolean') return 'text-[var(--color-tron-orange)]';
		return 'text-[var(--color-tron-green)]';
	}
</script>

{#if isObject}
	<div class="font-mono text-xs leading-relaxed">
		<button
			type="button"
			onclick={() => (open = !open)}
			class="flex items-center gap-1 text-left hover:opacity-80"
		>
			<span class="inline-block w-3 text-[var(--color-tron-text-secondary)]">{open ? '▾' : '▸'}</span>
			{#if name !== null}
				<span class="text-[var(--color-tron-text-primary)]">{name}</span>
			{/if}
			<span class="text-[var(--color-tron-text-secondary)]">{summary(value)}</span>
		</button>
		{#if open}
			<div class="ml-4 border-l border-[var(--color-tron-border)] pl-3">
				{#each entries as [key, child] (key)}
					<Self
						value={child}
						name={isArray ? `[${key}]` : key}
						{defaultOpenDepth}
						depth={depth + 1}
					/>
				{/each}
				{#if entries.length === 0}
					<div class="text-[var(--color-tron-text-secondary)] italic">{isArray ? 'empty array' : 'empty object'}</div>
				{/if}
			</div>
		{/if}
	</div>
{:else}
	<div class="font-mono text-xs leading-relaxed">
		{#if name !== null}
			<span class="text-[var(--color-tron-text-primary)]">{name}</span><span class="text-[var(--color-tron-text-secondary)]">: </span>
		{/if}
		<span class={primitiveClass(value)}>{fmtPrimitive(value)}</span>
	</div>
{/if}
