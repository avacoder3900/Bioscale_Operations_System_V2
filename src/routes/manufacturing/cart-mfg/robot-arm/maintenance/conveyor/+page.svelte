<script lang="ts">
	import ConveyorPanel from '$lib/components/robot-arm/ConveyorPanel.svelte';

	let { data } = $props();
</script>

<ConveyorPanel initial={data.conveyor} />
