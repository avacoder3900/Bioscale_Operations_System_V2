<script lang="ts">
	import { enhance } from '$app/forms';
	import { TronCard } from '$lib/components/ui';
	import ElectronicSignature from '$lib/components/signature/ElectronicSignature.svelte';

	let { data, form } = $props();

	let loading = $state(false);
	let passwordValue = $state('');

	function formatDuration(ms: number): string {
		const totalSeconds = Math.floor(ms / 1000);
		const minutes = Math.floor(totalSeconds / 60);
		const seconds = totalSeconds % 60;
		return `${minutes}m ${seconds}s`;
	}
</script>

<div class="mx-auto max-w-2xl space-y-6">
	<div class="text-center">
		<div
			class="bg-opacity-20 mx-auto mb-4 flex h-20 w-20 items-center justify-center rounded-full bg-[var(--color-tron-green)]"
		>
			<svg
				class="h-10 w-10 text-[var(--color-tron-green)]"
				fill="none"
				viewBox="0 0 24 24"
				stroke="currentColor"
			>
				<path
					stroke-linecap="round"
					stroke-linejoin="round"
					stroke-width="2"
					d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z"
				/>
			</svg>
		</div>
		<h2 class="tron-text-primary text-2xl font-bold">Assembly Complete</h2>
		<p class="tron-text-muted">Review and sign to finalize</p>
	</div>

	<TronCard>
		<h3 class="tron-text-primary mb-4 text-lg font-medium">Assembly Summary</h3>
		<dl class="grid grid-cols-2 gap-4">
			<div>
				<dt class="tron-text-muted text-sm">SPU UDI</dt>
				<dd class="tron-text-primary font-mono">{data.spu.udi}</dd>
			</div>
			<div>
				<dt class="tron-text-muted text-sm">Duration</dt>
				<dd class="tron-text-primary">{formatDuration(data.elapsedMs)}</dd>
			</div>
			<div>
				<dt class="tron-text-muted text-sm">Parts Scanned</dt>
				<dd class="tron-text-primary">{data.scannedParts.length}</dd>
			</div>
			<div>
				<dt class="tron-text-muted text-sm">Assembled By</dt>
				<dd class="tron-text-primary">{data.userName}</dd>
			</div>
		</dl>
	</TronCard>

	<TronCard>
		<h3 class="tron-text-primary mb-4 text-lg font-medium">Parts Used</h3>
		<div class="overflow-x-auto">
			<table class="tron-table">
				<thead>
					<tr>
						<th>Part #</th>
						<th>Name</th>
						<th>Lot #</th>
					</tr>
				</thead>
				<tbody>
					{#each data.scannedParts as part}
						<tr>
							<td class="font-mono">{part.partNumber}</td>
							<td>{part.partName}</td>
							<td class="font-mono">{part.lotNumber}</td>
						</tr>
					{/each}
				</tbody>
			</table>
		</div>
	</TronCard>

	<form
		method="POST"
		action="?/sign"
		use:enhance={() => {
			loading = true;
			return async ({ update }) => {
				loading = false;
				await update();
			};
		}}
	>
		<input type="hidden" name="password" bind:value={passwordValue} />
		<ElectronicSignature
			meaning="I confirm this assembly is complete per SOP-001"
			userName={data.userName}
			onSign={(password) => {
				passwordValue = password;
				const form = document.querySelector('form[action="?/sign"]') as HTMLFormElement;
				form?.requestSubmit();
			}}
			{loading}
			error={form?.error}
		/>
	</form>
</div>
