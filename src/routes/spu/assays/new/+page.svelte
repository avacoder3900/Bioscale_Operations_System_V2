<script lang="ts">
	import { enhance } from '$app/forms';
	import BcodeEditor from '$lib/components/assay/BcodeEditor.svelte';
	import { TEST_ASSAY } from '$lib/utils/test-data';

	let { form } = $props();

	interface Instruction {
		type: string;
		params?: number[];
		code?: Instruction[];
	}

	let name = $state('');
	let description = $state('');
	let currentInstructions = $state<Instruction[]>([]);
	let instructionsJson = $state('[]');
	let submitting = $state(false);
	let editorKey = $state(0);
	let autofillInstructions = $state<Instruction[] | undefined>(undefined);

	// Derive submit-readiness: name filled + at least 3 instructions (START + something + END)
	let canSubmit = $derived(!submitting && name.trim().length > 0 && currentInstructions.length >= 3);

	function handleCompile(instructions: Instruction[], _bcodeString: string) {
		currentInstructions = instructions;
		instructionsJson = JSON.stringify(instructions);
	}

	function fillTestData() {
		try {
			name = TEST_ASSAY.name;
			description = TEST_ASSAY.description;
			const instrs = [...TEST_ASSAY.instructions];
			autofillInstructions = instrs;
			currentInstructions = instrs;
			instructionsJson = JSON.stringify(instrs);
			editorKey++;
			console.log('[fillTestData] loaded', instrs.length, 'instructions, name:', name);
		} catch (e) {
			console.error('[fillTestData] ERROR:', e);
			alert('Fill test data error: ' + (e instanceof Error ? e.message : String(e)));
		}
	}
</script>

<div class="mx-auto max-w-7xl space-y-6 p-4">
	<!-- Header -->
	<div class="flex items-center gap-3">
		<a
			href="/spu/assays"
			class="flex items-center justify-center rounded"
			style="min-height: 44px; min-width: 44px; color: var(--color-tron-text-secondary)"
		>
			&#8592;
		</a>
		<h1 class="text-2xl font-bold" style="color: var(--color-tron-cyan, #00ffff)">
			New Assay Protocol
		</h1>
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
					SKU Code
				</label>
				<input
					name="skuCode"
					type="text"
					class="tron-input w-full px-3 py-2"
					style="min-height: 44px"
					placeholder="e.g., TROP-I-001 (auto-generated if blank)"
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
					placeholder="Optional description of the assay protocol..."
					bind:value={description}
				></textarea>
			</div>
			<div class="flex justify-end">
				<button
					type="button"
					class="tron-button text-sm"
					style="min-height: 44px; border-color: #f97316; color: #f97316"
					onclick={fillTestData}
				>
					&#9881; Fill Test Data
				</button>
			</div>
		</div>

		<!-- Hidden field for instructions JSON -->
		<input type="hidden" name="instructions" value={instructionsJson} />

		<!-- BCODE Editor -->
		{#key editorKey}
			<BcodeEditor initialInstructions={autofillInstructions} oncompile={handleCompile} />
		{/key}

		<!-- Submit -->
		<div class="mt-4 flex justify-end gap-2">
			<a href="/spu/assays" class="tron-button px-4 py-2" style="min-height: 44px">
				Cancel
			</a>
			<button
				type="submit"
				class="tron-button px-6 py-2"
				style="min-height: 44px; background: var(--color-tron-cyan, #00ffff); color: #000"
				disabled={!canSubmit}
			>
				{submitting ? 'Creating...' : canSubmit ? 'Create Assay' : `Need name + instructions (${currentInstructions.length} loaded)`}
			</button>
		</div>
	</form>
</div>
