<script lang="ts">
	import { enhance } from '$app/forms';

	interface Step {
		id: string;
		configId: string;
		stepNumber: number;
		title: string;
		description: string | null;
		imageUrl: string | null;
		createdAt: string;
		updatedAt: string;
	}

	interface Props {
		data: { steps: Step[]; configId: string };
		form: { success?: boolean; message?: string; error?: string } | null;
	}

	let { data, form }: Props = $props();

	let showAddForm = $state(false);
	let editingId = $state<string | null>(null);

	let addTitle = $state('');
	let addDescription = $state('');
	let addStepNumber = $state(data.steps.length + 1);

	let editTitle = $state('');
	let editDescription = $state('');
	let editStepNumber = $state(1);
	let editRemoveImage = $state(false);

	function startEdit(step: Step) {
		editingId = step.id;
		editTitle = step.title;
		editDescription = step.description ?? '';
		editStepNumber = step.stepNumber;
		editRemoveImage = false;
	}

	function cancelEdit() {
		editingId = null;
	}

	function resetAddForm() {
		addTitle = '';
		addDescription = '';
		addStepNumber = data.steps.length + 1;
		showAddForm = false;
	}
</script>

<div class="space-y-6">
	<div class="flex items-center justify-between">
		<h2 class="text-xl font-semibold text-[var(--color-tron-text)]">WI-03 Process Steps</h2>
		<button
			type="button"
			onclick={() => {
				addStepNumber = data.steps.length + 1;
				showAddForm = !showAddForm;
			}}
			class="rounded bg-[var(--color-tron-cyan)] px-4 py-2 text-sm font-medium text-[var(--color-tron-bg-primary)]"
		>
			{showAddForm ? 'Cancel' : '+ Add Step'}
		</button>
	</div>

	{#if form?.error}
		<p class="text-sm text-[var(--color-tron-error)]">{form.error}</p>
	{/if}
	{#if form?.success && form?.message}
		<p class="text-sm text-green-400">{form.message}</p>
	{/if}

	{#if showAddForm}
		<form
			method="POST"
			action="?/addStep"
			enctype="multipart/form-data"
			use:enhance={() => {
				return async ({ update }) => {
					await update();
					resetAddForm();
				};
			}}
			class="rounded-lg border border-[var(--color-tron-border)] bg-[var(--color-tron-bg-secondary)] p-4 space-y-3"
		>
			<h3 class="text-sm font-medium text-[var(--color-tron-text)]">New Step</h3>
			<div class="grid grid-cols-2 gap-3">
				<div>
					<label class="block text-xs text-[var(--color-tron-text-secondary)]">Step Number</label>
					<input
						type="number"
						name="stepNumber"
						bind:value={addStepNumber}
						min="1"
						class="mt-1 w-full rounded border border-[var(--color-tron-border)] bg-[var(--color-tron-bg-primary)] px-3 py-2 text-sm text-[var(--color-tron-text)]"
					/>
				</div>
				<div>
					<label class="block text-xs text-[var(--color-tron-text-secondary)]">Title</label>
					<input
						type="text"
						name="title"
						bind:value={addTitle}
						required
						class="mt-1 w-full rounded border border-[var(--color-tron-border)] bg-[var(--color-tron-bg-primary)] px-3 py-2 text-sm text-[var(--color-tron-text)]"
						placeholder="Step title"
					/>
				</div>
			</div>
			<div>
				<label class="block text-xs text-[var(--color-tron-text-secondary)]">Description</label>
				<textarea
					name="description"
					bind:value={addDescription}
					rows="3"
					class="mt-1 w-full rounded border border-[var(--color-tron-border)] bg-[var(--color-tron-bg-primary)] px-3 py-2 text-sm text-[var(--color-tron-text)]"
					placeholder="Detailed instructions for this step..."
				></textarea>
			</div>
			<div>
				<label class="block text-xs text-[var(--color-tron-text-secondary)]">Reference Photo</label>
				<input
					type="file"
					name="image"
					accept="image/*"
					class="mt-1 block w-full text-sm text-[var(--color-tron-text-secondary)] file:mr-4 file:rounded file:border-0 file:bg-[var(--color-tron-cyan)] file:px-3 file:py-1.5 file:text-sm file:text-[var(--color-tron-bg-primary)]"
				/>
			</div>
			<button
				type="submit"
				class="rounded bg-[var(--color-tron-cyan)] px-4 py-2 text-sm font-medium text-[var(--color-tron-bg-primary)]"
			>
				Add Step
			</button>
		</form>
	{/if}

	{#if data.steps.length === 0}
		<p class="text-sm text-[var(--color-tron-text-secondary)]">No process steps defined yet. Add one above.</p>
	{:else}
		<div class="space-y-3">
			{#each data.steps as step (step.id)}
				<div class="rounded-lg border border-[var(--color-tron-border)] bg-[var(--color-tron-bg-secondary)] p-4">
					{#if editingId === step.id}
						<form
							method="POST"
							action="?/editStep"
							enctype="multipart/form-data"
							use:enhance={() => {
								return async ({ update }) => {
									await update();
									cancelEdit();
								};
							}}
							class="space-y-3"
						>
							<input type="hidden" name="id" value={step.id} />
							<div class="grid grid-cols-2 gap-3">
								<div>
									<label class="block text-xs text-[var(--color-tron-text-secondary)]">Step Number</label>
									<input
										type="number"
										name="stepNumber"
										bind:value={editStepNumber}
										min="1"
										class="mt-1 w-full rounded border border-[var(--color-tron-border)] bg-[var(--color-tron-bg-primary)] px-3 py-2 text-sm text-[var(--color-tron-text)]"
									/>
								</div>
								<div>
									<label class="block text-xs text-[var(--color-tron-text-secondary)]">Title</label>
									<input
										type="text"
										name="title"
										bind:value={editTitle}
										required
										class="mt-1 w-full rounded border border-[var(--color-tron-border)] bg-[var(--color-tron-bg-primary)] px-3 py-2 text-sm text-[var(--color-tron-text)]"
									/>
								</div>
							</div>
							<div>
								<label class="block text-xs text-[var(--color-tron-text-secondary)]">Description</label>
								<textarea
									name="description"
									bind:value={editDescription}
									rows="3"
									class="mt-1 w-full rounded border border-[var(--color-tron-border)] bg-[var(--color-tron-bg-primary)] px-3 py-2 text-sm text-[var(--color-tron-text)]"
								></textarea>
							</div>
							<div>
								<label class="block text-xs text-[var(--color-tron-text-secondary)]">Replace Photo</label>
								<input
									type="file"
									name="image"
									accept="image/*"
									class="mt-1 block w-full text-sm text-[var(--color-tron-text-secondary)] file:mr-4 file:rounded file:border-0 file:bg-[var(--color-tron-cyan)] file:px-3 file:py-1.5 file:text-sm file:text-[var(--color-tron-bg-primary)]"
								/>
								{#if step.imageUrl}
									<label class="mt-2 flex items-center gap-2 text-xs text-[var(--color-tron-text-secondary)]">
										<input type="checkbox" name="removeImage" value="true" bind:checked={editRemoveImage} />
										Remove existing photo
									</label>
								{/if}
							</div>
							<div class="flex gap-2">
								<button
									type="submit"
									class="rounded bg-[var(--color-tron-cyan)] px-4 py-2 text-sm font-medium text-[var(--color-tron-bg-primary)]"
								>
									Save
								</button>
								<button
									type="button"
									onclick={cancelEdit}
									class="rounded border border-[var(--color-tron-border)] px-4 py-2 text-sm text-[var(--color-tron-text-secondary)]"
								>
									Cancel
								</button>
							</div>
						</form>
					{:else}
						<div class="flex items-start justify-between gap-4">
							<div class="flex-1">
								<div class="flex items-center gap-2">
									<span class="inline-flex h-6 w-6 items-center justify-center rounded-full bg-[var(--color-tron-cyan)] text-xs font-bold text-[var(--color-tron-bg-primary)]">
										{step.stepNumber}
									</span>
									<h3 class="text-sm font-medium text-[var(--color-tron-text)]">{step.title}</h3>
								</div>
								{#if step.description}
									<p class="mt-1 text-sm text-[var(--color-tron-text-secondary)] whitespace-pre-wrap">{step.description}</p>
								{/if}
								{#if step.imageUrl}
									<img src={step.imageUrl} alt="Step {step.stepNumber}" class="mt-2 max-h-40 rounded border border-[var(--color-tron-border)]" />
								{/if}
							</div>
							<div class="flex gap-2">
								<button
									type="button"
									onclick={() => startEdit(step)}
									class="rounded border border-[var(--color-tron-border)] px-3 py-1 text-xs text-[var(--color-tron-text-secondary)] hover:text-[var(--color-tron-cyan)]"
								>
									Edit
								</button>
								<form method="POST" action="?/deleteStep" use:enhance>
									<input type="hidden" name="id" value={step.id} />
									<button
										type="submit"
										class="rounded border border-[var(--color-tron-error)] px-3 py-1 text-xs text-[var(--color-tron-error)] hover:bg-[var(--color-tron-error)] hover:text-white"
									>
										Delete
									</button>
								</form>
							</div>
						</div>
					{/if}
				</div>
			{/each}
		</div>
	{/if}
</div>
