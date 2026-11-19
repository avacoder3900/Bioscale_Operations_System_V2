<script lang="ts">
	// The Deck Calibration Studio on the arm line (see +page.server.ts).
	import Studio from '../../../deck-calibration/+page.svelte';
	let { data } = $props();
</script>

<Studio {data} />
