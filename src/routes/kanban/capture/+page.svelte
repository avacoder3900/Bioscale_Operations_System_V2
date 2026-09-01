<script lang="ts">
	// KB2-38 — detailed capture: the whole item, where it lands, and where in that list.
	import { enhance } from '$app/forms';
	import TronButton from '$lib/components/ui/TronButton.svelte';
	import TronInput from '$lib/components/ui/TronInput.svelte';
	import { SIZE_CLASSES, CLASSES_OF_SERVICE, ITEM_TYPES } from '$lib/shared/kanban-status';
	import { tagColor } from '$lib/shared/tag-color';

	let { data, form } = $props();

	let submitting = $state(false);
	let landing = $state<'captured' | 'processed' | 'committed'>(data.initialLanding);
	let itemType = $state<string>('deliverable');
	let classOfService = $state<string>('standard');
	let sizeClass = $state<string>('');
	let tagsInput = $state('');

	// Shaping fields are required the moment the item is not landing plain 'captured'.
	const shaped = $derived(landing !== 'captured');
	const isSoftware = $derived(
		tagsInput
			.split(',')
			.map((t) => t.trim().toLowerCase())
			.includes('software')
	);
	const bottomSlot = $derived((landing === 'committed' ? data.ready.count : data.tier1Count) + 1);
	const submitLabel = $derived(
		landing === 'committed' ? 'Capture & Commit' : landing === 'processed' ? 'Capture & Process' : 'Capture'
	);

	const sizeLabels: Record<string, string> = { short: 'Short', medium: 'Medium', long: 'Long' };
	const cosLabels: Record<string, string> = {
		standard: 'Standard',
		fixed_date: 'Fixed date',
		chore: 'Chore',
		expedite: 'Expedite'
	};
	const typeLabels: Record<string, string> = {
		deliverable: 'Deliverable',
		spike: 'Investigation (spike)',
		chore: 'Chore',
		milestone: 'Milestone'
	};
</script>

<div class="space-y-6">
	<div class="flex flex-wrap items-start justify-between gap-3">
		<div>
			<a href="/kanban/inventory" class="tron-text-muted text-xs hover:underline">← Back</a>
			<h2 class="tron-text-primary text-2xl font-bold">Detailed capture</h2>
			<p class="tron-text-muted text-sm">
				Write the whole item once and put it exactly where it goes: Tier 1 as an option, processed and
				ready to commit, or straight onto the Board.
			</p>
		</div>
		<span
			class="rounded-full border px-3 py-1 text-xs font-bold"
			style="border-color: var(--color-tron-border); background: var(--color-tron-bg-tertiary); color: var(--color-tron-text-secondary);"
			title="Tier 1 options · ready queue depth vs cap"
		>
			Tier 1 {data.tier1Count} · Ready {data.ready.count}/{data.ready.cap}
		</span>
	</div>

	{#if form?.error}
		<div
			class="rounded border border-[rgba(255,51,102,0.3)] bg-[rgba(255,51,102,0.1)] px-4 py-3 text-sm"
			style="color: var(--color-tron-red);"
		>
			{form.error}
		</div>
	{/if}

	<form
		method="POST"
		action="?/create"
		use:enhance={() => {
			submitting = true;
			return async ({ update }) => {
				submitting = false;
				await update({ reset: false });
			};
		}}
	>
		<div class="grid grid-cols-1 gap-6 lg:grid-cols-3">
			<!-- Main column: what the item is -->
			<div class="space-y-4 lg:col-span-2">
				<div class="tron-card space-y-4">
					<TronInput label="Title" name="title" placeholder="One line is enough" required />

					<div>
						<label for="description" class="tron-label">Description</label>
						<textarea id="description" name="description" class="tron-input w-full" rows="4" placeholder="Context, links, notes…"></textarea>
					</div>

					<div>
						<label for="deliverable" class="tron-label">
							Deliverable (DoR){#if landing === 'committed'}<span style="color: var(--color-tron-red);"> *</span>{/if}
						</label>
						<textarea
							id="deliverable"
							name="deliverable"
							class="tron-input w-full"
							rows="3"
							required={landing === 'committed'}
							placeholder="What will exist or be true when this is done — and how you'd verify it. Outcome, not steps."
						></textarea>
					</div>

					<div>
						<label for="handoffBrief" class="tron-label">
							Agent handoff brief (software DoR){#if landing === 'committed' && isSoftware}<span style="color: var(--color-tron-red);"> *</span>{/if}
						</label>
						<textarea
							id="handoffBrief"
							name="handoffBrief"
							class="tron-input w-full"
							rows="3"
							required={landing === 'committed' && isSoftware}
							placeholder="Only needed to commit items tagged 'software': what a coding agent needs to start."
						></textarea>
					</div>
				</div>

				{#if itemType === 'spike'}
					<div class="tron-card space-y-3">
						<h3 class="tron-text-primary text-sm font-bold">Investigation</h3>
						<div>
							<label for="spikeQuestion" class="tron-label">Question <span style="color: var(--color-tron-red);">*</span></label>
							<textarea id="spikeQuestion" name="spikeQuestion" class="tron-input w-full" rows="2" required placeholder="The question this answers. If it can't be written, it isn't shaped enough to fund."></textarea>
						</div>
						<div class="flex items-end gap-2">
							<div class="w-28">
								<TronInput label="Timebox" name="spikeTimeboxAmount" type="number" min="1" step="1" required />
							</div>
							<select name="spikeTimeboxUnit" class="tron-select">
								<option value="days">days</option>
								<option value="hours">hours</option>
							</select>
						</div>
					</div>
				{/if}
			</div>

			<!-- Sidebar: where it lands, and how it is shaped -->
			<div class="space-y-4">
				<div class="tron-card space-y-3">
					<h3 class="tron-text-primary text-sm font-bold">Landing</h3>
					<div class="space-y-2 text-sm">
						<label class="flex items-start gap-2">
							<input type="radio" name="landing" value="captured" bind:group={landing} class="mt-1" />
							<span><span class="tron-text-primary font-medium">Capture</span><br /><span class="tron-text-muted text-xs">Tier 1 option. Shape it later.</span></span>
						</label>
						<label class="flex items-start gap-2">
							<input type="radio" name="landing" value="processed" bind:group={landing} class="mt-1" />
							<span><span class="tron-text-primary font-medium">Process</span><br /><span class="tron-text-muted text-xs">Sized and classed now — a real candidate, ready to commit.</span></span>
						</label>
						<label class="flex items-start gap-2 {data.canReplenish ? '' : 'opacity-50'}" title={data.canReplenish ? '' : 'Needs the kanban:replenish permission'}>
							<input type="radio" name="landing" value="committed" bind:group={landing} class="mt-1" disabled={!data.canReplenish} />
							<span><span class="tron-text-primary font-medium">Commit</span><br /><span class="tron-text-muted text-xs">Straight onto the Board's ready queue. Full DoR required; cap {data.ready.cap}.</span></span>
						</label>
					</div>

					<div>
						<label for="position" class="tron-label">
							Position in {landing === 'committed' ? 'ready queue' : 'Tier 1'}
						</label>
						<input
							id="position"
							name="position"
							type="number"
							min="1"
							step="1"
							class="tron-input w-full"
							placeholder="bottom (#{bottomSlot})"
							autocomplete="off"
						/>
						<p class="tron-text-muted mt-1 text-xs">1 = top. Blank = bottom. Everything below shifts down one.</p>
					</div>

					{#if landing === 'committed'}
						<div>
							<label for="commitNote" class="tron-label">Commit note</label>
							<input id="commitNote" name="commitNote" class="tron-input w-full" placeholder="Why this goes on the Board today (optional)" />
						</div>
					{/if}
				</div>

				<div class="tron-card space-y-3">
					<h3 class="tron-text-primary text-sm font-bold">Shaping</h3>

					<div>
						<label for="itemType" class="tron-label">Item type</label>
						<select id="itemType" name="itemType" class="tron-select w-full" bind:value={itemType}>
							{#each ITEM_TYPES as t (t)}
								<option value={t}>{typeLabels[t] ?? t}</option>
							{/each}
						</select>
					</div>

					<fieldset>
						<legend class="tron-label">
							Size class{#if shaped}<span style="color: var(--color-tron-red);"> *</span>{/if}
						</legend>
						<div class="space-y-1.5">
							{#each SIZE_CLASSES as sc (sc)}
								<label class="flex items-start gap-2 text-sm">
									<input type="radio" name="sizeClass" value={sc} bind:group={sizeClass} required={shaped} class="mt-1" />
									<span>
										<span class="tron-text-primary font-medium">{sizeLabels[sc]}</span>
										{#if data.sizeClassDefinitions[sc]}
											<br /><span class="tron-text-muted text-xs">{data.sizeClassDefinitions[sc]}</span>
										{/if}
									</span>
								</label>
							{/each}
						</div>
						<p class="tron-text-muted mt-2 text-xs">{data.sizingDecisionTest}</p>
					</fieldset>

					<div>
						<label for="classOfService" class="tron-label">
							Class of service{#if shaped}<span style="color: var(--color-tron-red);"> *</span>{/if}
						</label>
						<select id="classOfService" name="classOfService" class="tron-select w-full" bind:value={classOfService}>
							{#each CLASSES_OF_SERVICE as c (c)}
								<option value={c}>{cosLabels[c] ?? c}</option>
							{/each}
						</select>
					</div>

					<TronInput
						label={itemType === 'milestone'
							? 'Due date (hard anchor)'
							: classOfService === 'fixed_date'
								? 'Due date (external, required)'
								: 'Due date'}
						name="dueDate"
						type="date"
						required={itemType === 'milestone' || (shaped && classOfService === 'fixed_date')}
					/>

					<div class="grid grid-cols-2 gap-2">
						<TronInput label="Estimate (working days)" name="estimateDays" type="number" min="0.5" step="0.5" placeholder="duration" />
						<TronInput label="Effort (if different)" name="effortDays" type="number" min="0.5" step="0.5" placeholder="hands-on" />
					</div>

					<div>
						<label for="assignedTo" class="tron-label">Assign to</label>
						<select id="assignedTo" name="assignedTo" class="tron-select w-full">
							<option value="">Unassigned</option>
							{#each data.users as u (u.id)}
								<option value={u.id}>{u.username}</option>
							{/each}
						</select>
					</div>

					<div>
						<label for="tags" class="tron-label">Tags</label>
						<input
							id="tags"
							name="tags"
							class="tron-input w-full"
							placeholder="comma-separated"
							autocomplete="off"
							list="tag-vocabulary"
							bind:value={tagsInput}
						/>
						<datalist id="tag-vocabulary">
							{#each data.tagVocabulary as t (t)}
								<option value={t}></option>
							{/each}
						</datalist>
						{#if data.tagVocabulary.length}
							<div class="mt-1.5 flex flex-wrap gap-1">
								{#each data.tagVocabulary.slice(0, 24) as t (t)}
									<button
										type="button"
										class="rounded-full px-2 py-0.5 text-[10px] font-medium"
										style="background: {tagColor(t)}25; color: {tagColor(t)};"
										onclick={() => {
											const cur = tagsInput.split(',').map((x) => x.trim()).filter(Boolean);
											if (!cur.some((x) => x.toLowerCase() === t.toLowerCase())) cur.push(t);
											tagsInput = cur.join(', ');
										}}
									>
										{t}
									</button>
								{/each}
							</div>
						{/if}
					</div>
				</div>

				<div class="flex items-center justify-end gap-2">
					<a href="/kanban/inventory" class="tron-text-muted text-sm hover:underline">Cancel</a>
					<TronButton type="submit" variant="primary" disabled={submitting}>{submitLabel}</TronButton>
				</div>
			</div>
		</div>
	</form>
</div>
