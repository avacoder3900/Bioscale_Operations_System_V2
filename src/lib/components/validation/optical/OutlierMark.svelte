<script lang="ts">
	// The single place the group-outlier glyph and its wording live, so the table,
	// the plot and the CSV can never say different things about the same finding.
	//
	// This glyph means ONE thing: outlier versus its own group. Within-cartridge
	// noise is rendered as a text chip instead — reusing one glyph for two meanings
	// is how a legend stops being read.
	interface Props {
		reason: string | null;
	}
	let { reason }: Props = $props();
</script>

{#if reason}
	<span class="ml-1 cursor-help text-amber-400" title={reason} aria-label={reason}>⚠</span>
{/if}
