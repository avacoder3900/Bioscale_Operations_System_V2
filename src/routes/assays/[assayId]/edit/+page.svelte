<script lang="ts">
	import { enhance } from '$app/forms';
	import BcodeEditor from '$lib/components/assay/BcodeEditor.svelte';

	let { data, form } = $props();

	interface Instruction {
		type: string;
		params?: number[];
		code?: Instruction[];
	}

	let name = $state(data.assay.name);
	let description = $state(data.assay.description ?? '');
	let changeNotes = $state('');
	let currentInstructions = $state<Instruction[]>(data.instructions);
	let instructionsJson = $state(JSON.stringify(data.instructions));
	let submitting = $state(false);

	function handleCompile(instructions: Instruction[], _bcodeString: string) {
		currentInstructions = instructions;
		instructionsJson = JSON.stringify(instructions);
	}
</script>

<div class="mx-auto max-w-7xl space-y-6 p-4">
	<!-- Header -->
	<div class="flex items-center gap-3">
		<a
			href="/assays/{data.assay.assayId}"
			class="flex items-center justify-center rounded"
			style="min-height: 44px; min-width: 44px; color: var(--color-tron-text-secondary)"
		>
			&#8592;
		</a>
		<div>
			<h1 class="text-2xl font-bold" style="color: var(--color-tron-cyan, #00ffff)">
				Edit Assay
			</h1>
			<p class="text-sm" style="color: var(--color-tron-text-secondary)">
				{data.assay.assayId} &middot; v{data.assay.version ?? 1}
			</p>
		</div>
	</div>

	{#if form?.error}
		<div class="tron-card border p-3" style="border-color: #ef4444; color: #ef4444">
			{form.error}
		</div>
	{/if}

	<form
		method="POST"
		use:enhance={() => {
			submitting = true;
			return async ({ update }) => {
				submitting = false;
				await update();
			};
		}}
	>
		<!-- Metadata fields -->
		<div class="tron-card mb-4 space-y-3 p-4">
			<div>
				<label class="mb-1 block text-sm font-bold" style="color: var(--color-tron-text-secondary)">
					Assay Name *
				</label>
				<input
					name="name"
					type="text"
					class="tron-input w-full px-3 py-2"
					style="min-height: 44px"
					placeholder="e.g., Troponin I Rapid Test"
					bind:value={name}
					required
				/>
			</div>
			<div>
				<label class="mb-1 block text-sm font-bold" style="color: var(--color-tron-text-secondary)">
					Description
				</label>
				<textarea
					name="description"
					class="tron-input w-full px-3 py-2"
					style="min-height: 66px"
					placeholder="Optional description..."
					bind:value={description}
				></textarea>
			</div>
			<div>
				<label class="mb-1 block text-sm font-bold" style="color: var(--color-tron-text-secondary)">
					Change Notes
				</label>
				<input
					name="changeNotes"
					type="text"
					class="tron-input w-full px-3 py-2"
					style="min-height: 44px"
					placeholder="What changed? (optional, for version history)"
					bind:value={changeNotes}
				/>
			</div>
		</div>

		<!-- Hidden field for instructions JSON -->
		<input type="hidden" name="instructions" value={instructionsJson} />

		<!-- BCODE Editor pre-populated with existing instructions -->
		<BcodeEditor initialInstructions={data.instructions} oncompile={handleCompile} />

		<!-- Submit -->
		<div class="mt-4 flex justify-end gap-2">
			<a
				href="/assays/{data.assay.assayId}"
				class="tron-button px-4 py-2"
				style="min-height: 44px"
			>
				Cancel
			</a>
			<button
				type="submit"
				class="tron-button px-6 py-2"
				style="min-height: 44px; background: var(--color-tron-cyan, #00ffff); color: #000"
				disabled={submitting || !name.trim() || currentInstructions.length < 2}
			>
				{submitting ? 'Saving...' : 'Save Changes'}
			</button>
		</div>
	</form>
</div>
