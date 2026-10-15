<script lang="ts">
	/**
	 * The badge box for a badge-gated bucket form outside the board (the board
	 * has its own `badgeField` snippet, wired to its one-badge-for-the-rail state).
	 * Posts as `badge`. Enter never submits — a scan gun sends one after the code —
	 * it calls `onscanned` instead, so the page can move focus to the next box.
	 * With `show` false (badge enforcement off) the box is not drawn; a value
	 * already bound still rides along hidden so a badge scanned anyway is honoured.
	 */
	interface Props {
		value: string;
		show?: boolean;
		required?: boolean;
		id?: string;
		label?: string;
		class?: string;
		onscanned?: () => void;
	}
	let { value = $bindable(''), show = true, required = true, id = 'badge', label = 'Scan your badge', class: inputClass = '', onscanned }: Props = $props();
</script>

{#if show}
	<label class="block">
		<span class="text-[10px] uppercase tracking-wider {value.trim() ? 'text-[var(--color-tron-text-secondary)]' : 'text-[var(--color-tron-cyan)]'}">{label}{#if value.trim()} <span class="normal-case tracking-normal text-green-300">· on</span>{/if}</span>
		<input {id} type="text" name="badge" bind:value {required} autocomplete="off" placeholder="scan badge…"
			onkeydown={(e) => { if (e.key === 'Enter') { e.preventDefault(); value = value.trim(); onscanned?.(); } }}
			class="{inputClass} font-mono {value.trim() ? '' : 'border-[var(--color-tron-cyan)]/60 ring-1 ring-[var(--color-tron-cyan)]/30'}" />
	</label>
{:else}
	<input type="hidden" name="badge" {value} />
{/if}
