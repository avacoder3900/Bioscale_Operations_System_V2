<script lang="ts">
	import { enhance } from '$app/forms';
	import { page } from '$app/stores';

	let { data, form } = $props();

	// ── view state ────────────────────────────────────────────────────────────
	const initialSection = (() => {
		const q = Number($page.url.searchParams.get('section'));
		if (Number.isFinite(q) && data.wi?.sections.some((s: any) => s.number === q)) return q;
		const first = data.wi?.sections.find((s: any) => s.steps.length) ?? data.wi?.sections[0];
		return first?.number ?? 0;
	})();
	let activeSection = $state(initialSection);
	let editMode = $state(false);
	let showUpload = $state(!data.wi);
	let showFrontMatter = $state(false);
	let lightbox = $state<{ url: string; caption: string } | null>(null);
	let editingStep = $state<string | null>(null);
	let editingMaterial = $state<string | null>(null);
	let showAddStep = $state(false);
	let showAddMaterial = $state<string | null>(null);
	let showAddImages = $state<string | null>(null);
	let showMove = $state<string | null>(null);
	let openPull = $state<Record<string, boolean>>({});
	let openHistory = $state<Record<string, boolean>>({});
	let unitsBuilt = $state<Record<string, number>>({});
	let busy = $state(false);

	// drafts for the inline step editor
	let draftTitle = $state('');
	let draftHtml = $state('');
	let draftEsd = $state(false);
	let draftDhr = $state('');
	let addStepHtml = $state('');
	let showAddSection = $state(false);
	let showDeleteSection = $state(false);
	let editFrontMatter = $state(false);
	let editMeta = $state(false);
	let fmPurpose = $state('');
	let fmScope = $state('');
	let fmResp = $state('');
	let fmNotes = $state('');
	function startFrontMatterEdit() {
		fmPurpose = data.wi?.frontMatter.purposeHtml ?? '';
		fmScope = data.wi?.frontMatter.scopeHtml ?? '';
		fmResp = data.wi?.frontMatter.responsibilitiesHtml ?? '';
		fmNotes = data.wi?.frontMatter.generalNotesHtml ?? '';
		editFrontMatter = true;
	}

	const section = $derived(data.wi?.sections.find((s: any) => s.number === activeSection) ?? null);
	const totalSteps = $derived(data.wi ? data.wi.sections.reduce((n: number, s: any) => n + s.steps.length, 0) : 0);

	// ── helpers ───────────────────────────────────────────────────────────────
	function sectionLabel(s: any) {
		return s.type === 'setup' ? 'Setup' : `Sub-Assembly ${s.number}`;
	}
	function fmt(d: string | null | undefined) {
		return d ? new Date(d).toLocaleString() : '—';
	}
	function stockFor(m: any) {
		return m.partDefinitionId ? data.stock[m.partDefinitionId] : null;
	}
	function partMaterials(step: any) {
		return step.materials.filter((m: any) => m.kind === 'part');
	}
	function otherMaterials(step: any) {
		return step.materials.filter((m: any) => m.kind !== 'part');
	}
	function startEdit(step: any) {
		editingStep = step._id;
		draftTitle = step.title ?? '';
		draftHtml = step.instructionsHtml ?? '';
		draftEsd = Boolean(step.requiresEsd);
		draftDhr = (step.dhrFields ?? []).join(', ');
	}
	function togglePull(stepId: string) {
		openPull[stepId] = !openPull[stepId];
		if (unitsBuilt[stepId] == null) unitsBuilt[stepId] = 1;
	}
	const kindLabel: Record<string, string> = { part: 'Part', tool: 'Tool', aid: 'Mfg Aid', supply: 'Supply' };
	const kindClass: Record<string, string> = {
		part: 'text-[var(--color-tron-cyan)] border-[var(--color-tron-cyan)]/40',
		tool: 'text-amber-300 border-amber-500/40',
		aid: 'text-purple-300 border-purple-500/40',
		supply: 'text-green-300 border-green-500/40'
	};

	// Generic enhance: keep the page's state, close inline editors on success.
	function afterSubmit(onSuccess?: () => void) {
		return () => {
			busy = true;
			return async ({ update, result }: any) => {
				await update({ reset: false });
				busy = false;
				if (result.type === 'success') onSuccess?.();
			};
		};
	}
</script>

<svelte:head><title>SPU Assembly Work Instruction · BIMS</title></svelte:head>

<div class="space-y-6">
	<!-- ═══ Header ═══ -->
	<div class="flex flex-wrap items-start justify-between gap-4">
		<div>
			<h1 class="text-2xl font-bold text-[var(--color-tron-cyan)]">{data.wi?.title || 'SPU Assembly Work Instruction'}</h1>
			{#if data.wi && editMode}
				{#if !editMeta}
					<button class="text-[11px] text-amber-300 hover:underline" onclick={() => (editMeta = true)}>edit title / assembly number</button>
				{:else}
					<form method="POST" action="?/updateMetadata" use:enhance={afterSubmit(() => (editMeta = false))} class="mt-1 flex flex-wrap items-center gap-2 text-xs">
						<input name="title" value={data.wi.title} class="w-72 rounded border border-[var(--color-tron-border)] bg-[var(--color-tron-bg)] px-2 py-1 text-[var(--color-tron-text)]" />
						<input name="assemblyNumber" value={data.wi.assemblyNumber ?? ''} placeholder="AS-SPU-001" class="w-32 rounded border border-[var(--color-tron-border)] bg-[var(--color-tron-bg)] px-2 py-1 font-mono text-[var(--color-tron-text)]" />
						<button class="rounded bg-amber-500 px-2 py-1 font-semibold text-black">Save</button>
						<button type="button" class="text-[var(--color-tron-text-secondary)]" onclick={() => (editMeta = false)}>cancel</button>
					</form>
				{/if}
			{/if}
			{#if data.wi}
				<p class="mt-1 text-sm text-[var(--color-tron-text-secondary)]">
					{data.wi.documentNumber}{#if data.wi.assemblyNumber} · {data.wi.assemblyNumber}{/if}
					· {data.wi.sections.length} sections · {totalSteps} steps
					· source: {data.wi.sourceFile?.originalFileName ?? '—'}
				</p>
				<p class="mt-1 text-xs text-[var(--color-tron-text-secondary)]">
					<span class="rounded border border-[var(--color-tron-cyan)]/40 bg-[var(--color-tron-cyan)]/10 px-2 py-0.5 font-mono font-semibold text-[var(--color-tron-cyan)]">Rev v{data.wi.currentVersion}</span>
					last changed by <span class="text-[var(--color-tron-text)]">{data.wi.lastChangedBy?.username ?? '—'}</span> on {fmt(data.wi.lastChangedAt)}
					· <a href="/spu/assembly-wi/revisions" class="underline hover:text-[var(--color-tron-cyan)]">full revision history</a>
				</p>
			{:else}
				<p class="mt-1 text-sm text-[var(--color-tron-text-secondary)]">No work instruction imported yet. Upload the .docx to get started.</p>
			{/if}
		</div>
		{#if data.canEdit}
			<div class="flex flex-wrap gap-2">
				<button class="rounded border border-[var(--color-tron-border)] px-3 py-1.5 text-sm text-[var(--color-tron-text-secondary)] hover:border-[var(--color-tron-cyan)] hover:text-[var(--color-tron-cyan)]" onclick={() => (showUpload = !showUpload)}>
					{showUpload ? 'Hide upload' : 'Upload .docx'}
				</button>
				{#if data.wi}
					<button
						class="rounded border px-3 py-1.5 text-sm {editMode ? 'border-amber-500 bg-amber-900/20 text-amber-300' : 'border-[var(--color-tron-border)] text-[var(--color-tron-text-secondary)] hover:border-[var(--color-tron-cyan)] hover:text-[var(--color-tron-cyan)]'}"
						onclick={() => { editMode = !editMode; editingStep = null; }}
					>
						{editMode ? 'Exit edit mode' : 'Edit mode'}
					</button>
				{/if}
			</div>
		{/if}
	</div>

	{#if form?.error}
		<div class="rounded border border-red-500/30 bg-red-900/20 px-4 py-3 text-sm text-red-300">{form.error}</div>
	{/if}
	{#if form?.success}
		<div class="rounded border border-green-500/30 bg-green-900/20 px-4 py-3 text-sm text-green-300">{form.message}</div>
	{/if}

	<!-- ═══ Upload ═══ -->
	{#if showUpload && data.canEdit}
		<form method="POST" action="?/upload" enctype="multipart/form-data" use:enhance={afterSubmit(() => (showUpload = false))}
			class="rounded-lg border border-[var(--color-tron-border)] bg-[var(--color-tron-surface)] p-4">
			<h2 class="text-sm font-semibold text-[var(--color-tron-text)]">Import work instruction (.docx)</h2>
			<p class="mt-1 text-xs text-[var(--color-tron-text-secondary)]">
				The parser reads the Step / Instructions / Photo tables, splits them by "Subassembly #N" headings, pulls materials from the italic bullets
				(e.g. <span class="font-mono">Heater Block (PT-SPU-013) x1</span>) and links them to the parts catalog.
				{#if data.wi}<strong class="text-amber-300">Re-importing replaces all sections and steps</strong> and records a new version.{/if}
			</p>
			<div class="mt-3 flex flex-wrap items-center gap-3">
				<input type="file" name="file" accept=".docx" required class="text-sm text-[var(--color-tron-text-secondary)]" />
				<button type="submit" disabled={busy} class="rounded bg-[var(--color-tron-cyan)] px-4 py-1.5 text-sm font-semibold text-black hover:opacity-90 disabled:opacity-50">
					{busy ? 'Importing…' : 'Import'}
				</button>
			</div>
		</form>
	{/if}

	{#if data.wi}
		<!-- ═══ Front matter ═══ -->
		<div class="rounded-lg border border-[var(--color-tron-border)] bg-[var(--color-tron-surface)]">
			<button class="flex w-full items-center justify-between px-4 py-2 text-left text-sm font-semibold text-[var(--color-tron-text)]" onclick={() => (showFrontMatter = !showFrontMatter)}>
				<span>Purpose, scope, responsibilities &amp; references</span>
				<span class="text-xs text-[var(--color-tron-text-secondary)]">{showFrontMatter ? 'hide' : 'show'}</span>
			</button>
			{#if showFrontMatter && editMode && editFrontMatter}
				<form method="POST" action="?/updateFrontMatter" use:enhance={afterSubmit(() => (editFrontMatter = false))} class="grid gap-3 border-t border-amber-500/30 bg-amber-900/5 px-4 py-3 text-xs md:grid-cols-2">
					<input type="hidden" name="purposeHtml" value={fmPurpose} />
					<input type="hidden" name="scopeHtml" value={fmScope} />
					<input type="hidden" name="responsibilitiesHtml" value={fmResp} />
					<input type="hidden" name="generalNotesHtml" value={fmNotes} />
					<div>Purpose<div contenteditable="true" bind:innerHTML={fmPurpose} class="wi-prose mt-1 min-h-[4rem] rounded border border-[var(--color-tron-border)] bg-[var(--color-tron-bg)] px-3 py-2 text-sm text-[var(--color-tron-text)]"></div></div>
					<div>Scope<div contenteditable="true" bind:innerHTML={fmScope} class="wi-prose mt-1 min-h-[4rem] rounded border border-[var(--color-tron-border)] bg-[var(--color-tron-bg)] px-3 py-2 text-sm text-[var(--color-tron-text)]"></div></div>
					<div>Responsibilities<div contenteditable="true" bind:innerHTML={fmResp} class="wi-prose mt-1 min-h-[4rem] rounded border border-[var(--color-tron-border)] bg-[var(--color-tron-bg)] px-3 py-2 text-sm text-[var(--color-tron-text)]"></div></div>
					<div>General notes<div contenteditable="true" bind:innerHTML={fmNotes} class="wi-prose mt-1 min-h-[4rem] rounded border border-[var(--color-tron-border)] bg-[var(--color-tron-bg)] px-3 py-2 text-sm text-[var(--color-tron-text)]"></div></div>
					<label>Definitions (one per line)<textarea name="definitions" rows="4" class="mt-1 w-full rounded border border-[var(--color-tron-border)] bg-[var(--color-tron-bg)] px-2 py-1 text-sm text-[var(--color-tron-text)]">{data.wi.frontMatter.definitions.join('\n')}</textarea></label>
					<label>References (one per line)<textarea name="references" rows="4" class="mt-1 w-full rounded border border-[var(--color-tron-border)] bg-[var(--color-tron-bg)] px-2 py-1 text-sm text-[var(--color-tron-text)]">{data.wi.frontMatter.references.join('\n')}</textarea></label>
					<div class="flex gap-2 md:col-span-2">
						<button class="rounded bg-amber-500 px-3 py-1 font-semibold text-black">Save front matter (creates v{data.wi.currentVersion + 1})</button>
						<button type="button" class="rounded border border-[var(--color-tron-border)] px-3 py-1 text-[var(--color-tron-text-secondary)]" onclick={() => (editFrontMatter = false)}>Cancel</button>
					</div>
				</form>
			{:else if showFrontMatter}
				<div class="wi-prose grid gap-4 border-t border-[var(--color-tron-border)] px-4 py-3 text-sm md:grid-cols-2">
					{#if editMode}<div class="md:col-span-2"><button class="text-[11px] text-amber-300 hover:underline" onclick={startFrontMatterEdit}>edit front matter</button></div>{/if}
					<div><h3>Purpose</h3>{@html data.wi.frontMatter.purposeHtml || '<p>—</p>'}</div>
					<div><h3>Scope</h3>{@html data.wi.frontMatter.scopeHtml || '<p>—</p>'}</div>
					<div><h3>Responsibilities</h3>{@html data.wi.frontMatter.responsibilitiesHtml || '<p>—</p>'}</div>
					<div>
						<h3>Definitions</h3>
						<ul>{#each data.wi.frontMatter.definitions as d}<li>{d}</li>{/each}</ul>
						<h3 class="mt-3">References</h3>
						<ul>{#each data.wi.frontMatter.references as r}<li>{r}</li>{/each}</ul>
					</div>
					{#if data.wi.frontMatter.generalNotesHtml}
						<div class="md:col-span-2"><h3>General notes</h3>{@html data.wi.frontMatter.generalNotesHtml}</div>
					{/if}
					{#if data.wi.sourceFile?.warnings?.length}
						<div class="md:col-span-2 rounded border border-amber-500/30 bg-amber-900/10 p-2 text-xs text-amber-200">
							<strong>Import warnings:</strong>
							<ul class="mt-1 list-disc pl-4">{#each data.wi.sourceFile.warnings as w}<li>{w}</li>{/each}</ul>
							{#if data.canEdit}
								<form method="POST" action="?/relinkParts" use:enhance={afterSubmit()} class="mt-2">
									<button class="rounded border border-amber-500/40 px-2 py-0.5 text-amber-300 hover:bg-amber-900/30">Re-link part numbers to catalog</button>
								</form>
							{/if}
						</div>
					{/if}
				</div>
			{/if}
		</div>

		<!-- ═══ Section tabs ═══ -->
		<div class="flex flex-wrap items-center gap-2 border-b border-[var(--color-tron-border)] pb-2">
			{#each data.wi.sections as s (s._id)}
				<button
					class="rounded-t px-3 py-2 text-sm transition {activeSection === s.number ? 'bg-[var(--color-tron-cyan)]/15 font-semibold text-[var(--color-tron-cyan)] border-b-2 border-[var(--color-tron-cyan)]' : 'text-[var(--color-tron-text-secondary)] hover:text-[var(--color-tron-text)]'}"
					onclick={() => { activeSection = s.number; editingStep = null; }}
					title="{sectionLabel(s)} — {s.title}"
				>
					{#if s.type === 'setup'}
						{s.title || 'Setup'}
					{:else}
						<span class="mr-1 font-mono text-[10px] opacity-70">{s.number}</span>{s.title || sectionLabel(s)}
					{/if}
					<span class="ml-1 rounded-full bg-[var(--color-tron-surface)] px-1.5 text-[10px] text-[var(--color-tron-text-secondary)]">{s.steps.length}</span>
				</button>
			{/each}
			{#if editMode}
				{#if !showAddSection}
					<button class="rounded border border-dashed border-[var(--color-tron-cyan)]/50 px-3 py-1.5 text-xs text-[var(--color-tron-cyan)] hover:bg-[var(--color-tron-cyan)]/10" onclick={() => (showAddSection = true)}>+ Add sub-assembly</button>
				{:else}
					<form method="POST" action="?/addSection" use:enhance={afterSubmit(() => (showAddSection = false))} class="flex items-center gap-1 text-xs">
						<input name="title" placeholder="Title (optional)" class="w-44 rounded border border-[var(--color-tron-border)] bg-[var(--color-tron-bg)] px-2 py-1 text-[var(--color-tron-text)]" />
						<input name="position" type="number" min="1" placeholder="as #" title="Sub-assembly number (blank = last)" class="w-16 rounded border border-[var(--color-tron-border)] bg-[var(--color-tron-bg)] px-2 py-1 text-[var(--color-tron-text)]" />
						<button class="rounded border border-[var(--color-tron-cyan)]/50 px-2 py-1 text-[var(--color-tron-cyan)]">Add</button>
						<button type="button" class="text-[var(--color-tron-text-secondary)]" onclick={() => (showAddSection = false)}>cancel</button>
					</form>
				{/if}
			{/if}
		</div>

		{#if section}
			<!-- ═══ Section header ═══ -->
			<div class="rounded-lg border border-[var(--color-tron-border)] bg-[var(--color-tron-surface)] p-4">
				<div class="flex flex-wrap items-start justify-between gap-3">
					<div>
						<div class="text-xs uppercase tracking-wide text-[var(--color-tron-text-secondary)]">{sectionLabel(section)}</div>
						<h2 class="text-lg font-semibold text-[var(--color-tron-text)]">{section.title}</h2>
					</div>
					{#if editMode}
						<div class="flex flex-wrap items-center gap-2">
							<form method="POST" action="?/renameSection" use:enhance={afterSubmit()} class="flex items-center gap-2">
								<input type="hidden" name="sectionNumber" value={section.number} />
								<input name="title" value={section.title} class="rounded border border-[var(--color-tron-border)] bg-[var(--color-tron-bg)] px-2 py-1 text-sm text-[var(--color-tron-text)]" />
								<button class="rounded border border-[var(--color-tron-cyan)]/50 px-2 py-1 text-xs text-[var(--color-tron-cyan)]">Rename</button>
							</form>
							{#if section.type !== 'setup'}
								<form method="POST" action="?/moveSection" use:enhance={afterSubmit(() => (activeSection = Math.max(1, section.number - 1)))} class="inline">
									<input type="hidden" name="sectionNumber" value={section.number} /><input type="hidden" name="toPosition" value={section.number - 1} />
									<button class="rounded border border-[var(--color-tron-border)] px-2 py-1 text-xs text-[var(--color-tron-text-secondary)] disabled:opacity-30" disabled={section.number <= 1} title="move earlier">◀</button>
								</form>
								<form method="POST" action="?/moveSection" use:enhance={afterSubmit(() => (activeSection = section.number + 1))} class="inline">
									<input type="hidden" name="sectionNumber" value={section.number} /><input type="hidden" name="toPosition" value={section.number + 1} />
									<button class="rounded border border-[var(--color-tron-border)] px-2 py-1 text-xs text-[var(--color-tron-text-secondary)] disabled:opacity-30" disabled={section.number >= data.wi.sections.filter((x: any) => x.type !== 'setup').length} title="move later">▶</button>
								</form>
							{/if}
							{#if !showDeleteSection}
								<button class="rounded border border-red-500/40 px-2 py-1 text-xs text-red-300 hover:bg-red-900/20" onclick={() => (showDeleteSection = true)}>Delete section</button>
							{:else}
								<form method="POST" action="?/deleteSection" use:enhance={afterSubmit(() => { showDeleteSection = false; activeSection = 0; })} class="flex items-center gap-1 rounded border border-red-500/40 bg-red-900/10 px-2 py-1 text-xs" onsubmit={(e) => { if (!confirm(`Delete ${sectionLabel(section)} "${section.title}"?`)) e.preventDefault(); }}>
									<input type="hidden" name="sectionNumber" value={section.number} />
									{#if section.steps.length}
										<span class="text-red-200">move its {section.steps.length} steps to</span>
										<select name="moveStepsTo" required class="rounded border border-[var(--color-tron-border)] bg-[var(--color-tron-bg)] px-1 py-0.5 text-[var(--color-tron-text)]">
											{#each data.wi.sections.filter((x: any) => x._id !== section._id) as t}<option value={t.number}>{sectionLabel(t)} — {t.title}</option>{/each}
										</select>
									{/if}
									<button class="rounded bg-red-500 px-2 py-0.5 font-semibold text-black">Delete</button>
									<button type="button" class="text-[var(--color-tron-text-secondary)]" onclick={() => (showDeleteSection = false)}>cancel</button>
								</form>
							{/if}
						</div>
					{/if}
				</div>
				{#if section.notesHtml}
					<div class="wi-prose mt-2 rounded border border-amber-500/20 bg-amber-900/10 px-3 py-2 text-sm text-amber-100/90">{@html section.notesHtml}</div>
				{/if}
				{#if section.materialsHtml}
					<details class="mt-2 text-sm">
						<summary class="cursor-pointer text-xs text-[var(--color-tron-text-secondary)]">Section materials table</summary>
						<div class="wi-prose mt-2">{@html section.materialsHtml}</div>
					</details>
				{/if}
				{#if !section.steps.length}
					<p class="mt-3 text-sm text-[var(--color-tron-text-secondary)]">
						No steps in this sub-assembly yet.
						{#if data.canEdit}Switch to edit mode to add steps here or move steps from another sub-assembly.{/if}
					</p>
				{/if}
			</div>

			<!-- ═══ Steps ═══ -->
			{#each section.steps as step, idx (step._id)}
				<article id="step-{section.number}-{step.stepNumber}" class="rounded-lg border border-[var(--color-tron-border)] bg-[var(--color-tron-surface)]">
					<!-- step header -->
					<div class="flex flex-wrap items-start justify-between gap-2 border-b border-[var(--color-tron-border)] px-4 py-3">
						<div class="flex items-start gap-3">
							<div class="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-[var(--color-tron-cyan)]/15 font-mono text-sm font-bold text-[var(--color-tron-cyan)]">{step.stepNumber}</div>
							<div>
								<h3 class="font-semibold text-[var(--color-tron-text)]">{step.title || `Step ${step.stepNumber}`}</h3>
								<div class="mt-1 flex flex-wrap gap-1 text-[10px]">
									<span class="text-[var(--color-tron-text-secondary)]">{sectionLabel(section)} · step {step.stepNumber} of {section.steps.length}</span>
									{#if step.requiresEsd}<span class="rounded border border-red-500/40 bg-red-900/20 px-1.5 py-0.5 text-red-300">ESD required</span>{/if}
									{#each step.dhrFields ?? [] as f}<span class="rounded border border-[var(--color-tron-border)] px-1.5 py-0.5 text-[var(--color-tron-text-secondary)]">DHR: {f} S/N</span>{/each}
									{#if step.images.length}<span class="rounded border border-[var(--color-tron-border)] px-1.5 py-0.5 text-[var(--color-tron-text-secondary)]">{step.images.length} photo{step.images.length === 1 ? '' : 's'}</span>{/if}
								</div>
							</div>
						</div>
						<div class="flex flex-wrap gap-1">
							{#if partMaterials(step).length && data.canEdit}
								<button class="rounded border px-2 py-1 text-xs {openPull[step._id] ? 'border-green-500 bg-green-900/20 text-green-300' : 'border-green-500/40 text-green-300 hover:bg-green-900/20'}" onclick={() => togglePull(step._id)}>
									{openPull[step._id] ? 'Close pull form' : 'Pull from inventory'}
								</button>
							{/if}
							{#if (data.pullsByStep[step._id] ?? []).length}
								<button class="rounded border border-[var(--color-tron-border)] px-2 py-1 text-xs text-[var(--color-tron-text-secondary)] hover:text-[var(--color-tron-text)]" onclick={() => (openHistory[step._id] = !openHistory[step._id])}>
									Pull history ({data.pullsByStep[step._id].length})
								</button>
							{/if}
							{#if editMode}
								<button class="rounded border border-amber-500/40 px-2 py-1 text-xs text-amber-300 hover:bg-amber-900/20" onclick={() => (editingStep === step._id ? (editingStep = null) : startEdit(step))}>
									{editingStep === step._id ? 'Cancel edit' : 'Edit step'}
								</button>
								<button class="rounded border border-[var(--color-tron-border)] px-2 py-1 text-xs text-[var(--color-tron-text-secondary)] hover:text-[var(--color-tron-text)]" onclick={() => (showAddImages = showAddImages === step._id ? null : step._id)}>Add images</button>
								<button class="rounded border border-[var(--color-tron-border)] px-2 py-1 text-xs text-[var(--color-tron-text-secondary)] hover:text-[var(--color-tron-text)]" onclick={() => (showAddMaterial = showAddMaterial === step._id ? null : step._id)}>Add material</button>
								<button class="rounded border border-[var(--color-tron-border)] px-2 py-1 text-xs text-[var(--color-tron-text-secondary)] hover:text-[var(--color-tron-text)]" onclick={() => (showMove = showMove === step._id ? null : step._id)}>Move</button>
								<form method="POST" action="?/deleteStep" use:enhance={afterSubmit()} onsubmit={(e) => { if (!confirm(`Delete step ${step.stepNumber} in ${sectionLabel(section)}?`)) e.preventDefault(); }}>
									<input type="hidden" name="sectionNumber" value={section.number} />
									<input type="hidden" name="stepId" value={step._id} />
									<button class="rounded border border-red-500/40 px-2 py-1 text-xs text-red-300 hover:bg-red-900/20">Delete</button>
								</form>
							{/if}
						</div>
					</div>

					<!-- step editor -->
					{#if editMode && editingStep === step._id}
						<form method="POST" action="?/updateStep" use:enhance={afterSubmit(() => (editingStep = null))} class="space-y-3 border-b border-amber-500/30 bg-amber-900/5 px-4 py-3">
							<input type="hidden" name="sectionNumber" value={section.number} />
							<input type="hidden" name="stepId" value={step._id} />
							<input type="hidden" name="instructionsHtml" value={draftHtml} />
							<label class="block text-xs text-[var(--color-tron-text-secondary)]">Title
								<input name="title" bind:value={draftTitle} class="mt-1 w-full rounded border border-[var(--color-tron-border)] bg-[var(--color-tron-bg)] px-2 py-1 text-sm text-[var(--color-tron-text)]" />
							</label>
							<div class="text-xs text-[var(--color-tron-text-secondary)]">Instructions <span class="opacity-70">(rich text — select text and use ⌘B / ⌘I for bold / italic)</span>
								<div contenteditable="true" bind:innerHTML={draftHtml} class="wi-prose mt-1 min-h-[8rem] rounded border border-[var(--color-tron-border)] bg-[var(--color-tron-bg)] px-3 py-2 text-sm text-[var(--color-tron-text)] focus:border-[var(--color-tron-cyan)] focus:outline-none"></div>
							</div>
							<div class="flex flex-wrap items-center gap-4 text-xs text-[var(--color-tron-text-secondary)]">
								<label class="flex items-center gap-1"><input type="checkbox" name="requiresEsd" bind:checked={draftEsd} /> ESD protection required</label>
								<label class="flex items-center gap-1">DHR serial fields (comma separated)
									<input name="dhrFields" bind:value={draftDhr} class="rounded border border-[var(--color-tron-border)] bg-[var(--color-tron-bg)] px-2 py-1 text-[var(--color-tron-text)]" placeholder="Stepper Motor, Stage Board" />
								</label>
							</div>
							<button type="submit" disabled={busy} class="rounded bg-amber-500 px-3 py-1 text-sm font-semibold text-black disabled:opacity-50">Save step (creates v{data.wi.currentVersion + 1})</button>
						</form>
					{/if}

					<!-- move / add images / add material panels -->
					{#if editMode && showMove === step._id}
						<form method="POST" action="?/moveStep" use:enhance={afterSubmit(() => (showMove = null))} class="flex flex-wrap items-end gap-3 border-b border-[var(--color-tron-border)] px-4 py-3 text-xs">
							<input type="hidden" name="sectionNumber" value={section.number} />
							<input type="hidden" name="stepId" value={step._id} />
							<label class="text-[var(--color-tron-text-secondary)]">Move to
								<select name="toSection" class="ml-1 rounded border border-[var(--color-tron-border)] bg-[var(--color-tron-bg)] px-2 py-1 text-[var(--color-tron-text)]">
									{#each data.wi.sections as s}<option value={s.number} selected={s.number === section.number}>{sectionLabel(s)} — {s.title}</option>{/each}
								</select>
							</label>
							<label class="text-[var(--color-tron-text-secondary)]">as step #
								<input type="number" name="toPosition" min="1" placeholder="end" class="ml-1 w-20 rounded border border-[var(--color-tron-border)] bg-[var(--color-tron-bg)] px-2 py-1 text-[var(--color-tron-text)]" />
							</label>
							<button class="rounded border border-[var(--color-tron-cyan)]/50 px-3 py-1 text-[var(--color-tron-cyan)]">Move step</button>
						</form>
					{/if}
					{#if editMode && showAddImages === step._id}
						<form method="POST" action="?/addImages" enctype="multipart/form-data" use:enhance={afterSubmit(() => (showAddImages = null))} class="flex flex-wrap items-end gap-3 border-b border-[var(--color-tron-border)] px-4 py-3 text-xs">
							<input type="hidden" name="sectionNumber" value={section.number} />
							<input type="hidden" name="stepId" value={step._id} />
							<input type="file" name="images" accept="image/*" multiple required class="text-[var(--color-tron-text-secondary)]" />
							<input name="caption" placeholder="caption (optional, single image)" class="rounded border border-[var(--color-tron-border)] bg-[var(--color-tron-bg)] px-2 py-1 text-[var(--color-tron-text)]" />
							<button disabled={busy} class="rounded border border-[var(--color-tron-cyan)]/50 px-3 py-1 text-[var(--color-tron-cyan)] disabled:opacity-50">{busy ? 'Uploading…' : 'Add to step'}</button>
						</form>
					{/if}
					{#if editMode && showAddMaterial === step._id}
						<form method="POST" action="?/addMaterial" use:enhance={afterSubmit(() => (showAddMaterial = null))} class="border-b border-[var(--color-tron-border)] px-4 py-3 text-xs">
							<input type="hidden" name="sectionNumber" value={section.number} />
							<input type="hidden" name="stepId" value={step._id} />
							<div class="flex flex-wrap items-end gap-2">
								<label class="text-[var(--color-tron-text-secondary)]">Document syntax
									<input name="text" list="catalog-parts" placeholder="Heater Block (PT-SPU-013) x1" class="ml-1 w-72 rounded border border-[var(--color-tron-border)] bg-[var(--color-tron-bg)] px-2 py-1 font-mono text-[var(--color-tron-text)]" />
								</label>
								<span class="text-[var(--color-tron-text-secondary)]">or</span>
								<select name="kind" class="rounded border border-[var(--color-tron-border)] bg-[var(--color-tron-bg)] px-2 py-1 text-[var(--color-tron-text)]">
									<option value="part">Part</option><option value="tool">Tool</option><option value="aid">Mfg Aid</option><option value="supply">Supply</option>
								</select>
								<input name="partNumber" list="catalog-parts" placeholder="PT-SPU-000" class="w-32 rounded border border-[var(--color-tron-border)] bg-[var(--color-tron-bg)] px-2 py-1 font-mono text-[var(--color-tron-text)]" />
								<input name="name" placeholder="name" class="w-48 rounded border border-[var(--color-tron-border)] bg-[var(--color-tron-bg)] px-2 py-1 text-[var(--color-tron-text)]" />
								<input name="quantity" type="number" step="any" min="0" value="1" class="w-20 rounded border border-[var(--color-tron-border)] bg-[var(--color-tron-bg)] px-2 py-1 text-[var(--color-tron-text)]" />
								<input name="unit" placeholder="ea" class="w-16 rounded border border-[var(--color-tron-border)] bg-[var(--color-tron-bg)] px-2 py-1 text-[var(--color-tron-text)]" />
								<button class="rounded border border-[var(--color-tron-cyan)]/50 px-3 py-1 text-[var(--color-tron-cyan)]">Add material</button>
							</div>
						</form>
					{/if}

					<div class="grid gap-4 px-4 py-4 lg:grid-cols-5">
						<!-- instructions -->
						<div class="lg:col-span-3">
							<div class="wi-prose text-sm text-[var(--color-tron-text)]">{@html step.instructionsHtml || '<p class="opacity-60">No written instructions.</p>'}</div>

							<!-- materials -->
							{#if step.materials.length}
								<div class="mt-4">
									<div class="mb-1 text-xs font-semibold uppercase tracking-wide text-[var(--color-tron-text-secondary)]">Materials &amp; tools</div>
									<table class="w-full text-xs">
										<thead class="text-left text-[10px] uppercase text-[var(--color-tron-text-secondary)]">
											<tr><th class="py-1 pr-2">Kind</th><th class="py-1 pr-2">Part #</th><th class="py-1 pr-2">Name</th><th class="py-1 pr-2 text-right">Qty / device</th><th class="py-1 pr-2 text-right">On hand</th>{#if editMode}<th></th>{/if}</tr>
										</thead>
										<tbody>
											{#each step.materials as m (m._id)}
												{@const stock = stockFor(m)}
												<tr class="border-t border-[var(--color-tron-border)]/60 align-top">
													<td class="py-1 pr-2"><span class="rounded border px-1.5 py-0.5 text-[10px] {kindClass[m.kind]}">{kindLabel[m.kind]}</span></td>
													<td class="py-1 pr-2 font-mono text-[var(--color-tron-cyan)]">{m.partNumber ?? '—'}</td>
													<td class="py-1 pr-2 text-[var(--color-tron-text)]">
														{m.name}{#if m.notes}<span class="ml-1 text-[var(--color-tron-text-secondary)]">({m.notes})</span>{/if}
														{#if m.kind === 'part' && !m.partDefinitionId}<span class="ml-1 rounded border border-amber-500/40 px-1 text-[10px] text-amber-300">not in catalog</span>{/if}
													</td>
													<td class="py-1 pr-2 text-right text-[var(--color-tron-text)]">{m.kind === 'part' ? `${m.quantity} ${m.unit}` : m.quantity > 1 ? `${m.quantity} ${m.unit}` : '—'}</td>
													<td class="py-1 pr-2 text-right">
														{#if stock}
															<span class={stock.inventoryCount <= 0 ? 'text-red-300' : stock.inventoryCount < (m.quantity ?? 1) * 5 ? 'text-amber-300' : 'text-green-300'}>{stock.inventoryCount}</span>
														{:else}<span class="text-[var(--color-tron-text-secondary)]">—</span>{/if}
													</td>
													{#if editMode}
														<td class="py-1 text-right whitespace-nowrap">
															<button class="text-[10px] text-amber-300 hover:underline" onclick={() => (editingMaterial = editingMaterial === m._id ? null : m._id)}>edit</button>
															<form method="POST" action="?/removeMaterial" use:enhance={afterSubmit()} class="inline">
																<input type="hidden" name="sectionNumber" value={section.number} />
																<input type="hidden" name="stepId" value={step._id} />
																<input type="hidden" name="materialId" value={m._id} />
																<button class="ml-2 text-[10px] text-red-300 hover:underline">remove</button>
															</form>
														</td>
													{/if}
												</tr>
												{#if editMode && editingMaterial === m._id}
													<tr>
														<td colspan="6" class="pb-2">
															<form method="POST" action="?/updateMaterial" use:enhance={afterSubmit(() => (editingMaterial = null))} class="flex flex-wrap items-end gap-2 rounded border border-amber-500/30 bg-amber-900/5 p-2 text-[11px]">
																<input type="hidden" name="sectionNumber" value={section.number} />
																<input type="hidden" name="stepId" value={step._id} />
																<input type="hidden" name="materialId" value={m._id} />
																<select name="kind" class="rounded border border-[var(--color-tron-border)] bg-[var(--color-tron-bg)] px-2 py-1 text-[var(--color-tron-text)]">
																	{#each ['part', 'tool', 'aid', 'supply'] as k}<option value={k} selected={k === m.kind}>{kindLabel[k]}</option>{/each}
																</select>
																<input name="partNumber" list="catalog-parts" value={m.partNumber ?? ''} placeholder="PT-SPU-000" class="w-32 rounded border border-[var(--color-tron-border)] bg-[var(--color-tron-bg)] px-2 py-1 font-mono text-[var(--color-tron-text)]" />
																<input name="name" value={m.name} class="w-56 rounded border border-[var(--color-tron-border)] bg-[var(--color-tron-bg)] px-2 py-1 text-[var(--color-tron-text)]" />
																<input name="quantity" type="number" step="any" min="0" value={m.quantity} class="w-20 rounded border border-[var(--color-tron-border)] bg-[var(--color-tron-bg)] px-2 py-1 text-[var(--color-tron-text)]" />
																<input name="unit" value={m.unit} class="w-16 rounded border border-[var(--color-tron-border)] bg-[var(--color-tron-bg)] px-2 py-1 text-[var(--color-tron-text)]" />
																<input name="notes" value={m.notes ?? ''} placeholder="notes" class="w-40 rounded border border-[var(--color-tron-border)] bg-[var(--color-tron-bg)] px-2 py-1 text-[var(--color-tron-text)]" />
																<button class="rounded bg-amber-500 px-2 py-1 font-semibold text-black">Save</button>
															</form>
														</td>
													</tr>
												{/if}
											{/each}
										</tbody>
									</table>
								</div>
							{/if}

							<!-- pull form -->
							{#if openPull[step._id] && data.canEdit}
								<form method="POST" action="?/pullMaterials" use:enhance={afterSubmit(() => (openPull[step._id] = false))} class="mt-4 rounded-lg border border-green-500/30 bg-green-900/10 p-3 text-xs">
									<input type="hidden" name="sectionNumber" value={section.number} />
									<input type="hidden" name="stepId" value={step._id} />
									<div class="mb-2 flex flex-wrap items-end gap-3">
										<div class="font-semibold text-green-300">Pull materials for step {step.stepNumber} from inventory</div>
										<label class="text-[var(--color-tron-text-secondary)]">Units built
											<input type="number" name="unitsBuilt" min="1" step="1" bind:value={unitsBuilt[step._id]} class="ml-1 w-16 rounded border border-[var(--color-tron-border)] bg-[var(--color-tron-bg)] px-2 py-1 text-[var(--color-tron-text)]" />
										</label>
										<label class="text-[var(--color-tron-text-secondary)]">SPU serial (optional)
											<input name="deviceSerial" placeholder="SPU-…" class="ml-1 w-32 rounded border border-[var(--color-tron-border)] bg-[var(--color-tron-bg)] px-2 py-1 font-mono text-[var(--color-tron-text)]" />
										</label>
										<label class="text-[var(--color-tron-text-secondary)]">Notes
											<input name="notes" class="ml-1 w-48 rounded border border-[var(--color-tron-border)] bg-[var(--color-tron-bg)] px-2 py-1 text-[var(--color-tron-text)]" />
										</label>
									</div>
									<table class="w-full">
										<thead class="text-left text-[10px] uppercase text-[var(--color-tron-text-secondary)]"><tr><th class="py-1">Pull</th><th class="py-1">Part</th><th class="py-1 text-right">On hand</th><th class="py-1 text-right">Deduct</th></tr></thead>
										<tbody>
											{#each partMaterials(step) as m (m._id)}
												{@const stock = stockFor(m)}
												{@const linked = Boolean(m.partDefinitionId)}
												<tr class="border-t border-green-500/20">
													<td class="py-1"><input type="checkbox" name="pull_{m._id}" checked={linked && m.deductFromInventory !== false} disabled={!linked} /></td>
													<td class="py-1"><span class="font-mono text-[var(--color-tron-cyan)]">{m.partNumber ?? '—'}</span> {m.name}
														{#if !linked}<span class="ml-1 text-amber-300">not linked to catalog — edit the material to set a valid part number</span>{/if}
													</td>
													<td class="py-1 text-right">{stock ? stock.inventoryCount : '—'}</td>
													<td class="py-1 text-right">
														<input type="number" name="qty_{m._id}" step="any" min="0" value={(m.quantity ?? 1) * (unitsBuilt[step._id] ?? 1)} disabled={!linked} class="w-20 rounded border border-[var(--color-tron-border)] bg-[var(--color-tron-bg)] px-2 py-1 text-right text-[var(--color-tron-text)]" />
														<span class="text-[var(--color-tron-text-secondary)]">{m.unit}</span>
													</td>
												</tr>
											{/each}
										</tbody>
									</table>
									<div class="mt-2 flex items-center justify-between">
										<span class="text-[var(--color-tron-text-secondary)]">Each row becomes an inventory consumption transaction attributed to you, with the step reference in its notes.</span>
										<button type="submit" disabled={busy} class="rounded bg-green-500 px-3 py-1 font-semibold text-black disabled:opacity-50">{busy ? 'Deducting…' : 'Deduct from inventory'}</button>
									</div>
								</form>
							{/if}

							<!-- pull history -->
							{#if openHistory[step._id] && data.pullsByStep[step._id]}
								<div class="mt-3 rounded border border-[var(--color-tron-border)] p-2 text-[11px]">
									<div class="mb-1 font-semibold text-[var(--color-tron-text-secondary)]">Inventory pulls for this step</div>
									{#each data.pullsByStep[step._id] as p (p._id)}
										<div class="flex flex-wrap justify-between gap-2 border-t border-[var(--color-tron-border)]/60 py-1">
											<span><span class="font-mono text-[var(--color-tron-cyan)]">{p.partNumber ?? ''}</span> {p.name} <span class="text-red-300">−{p.quantity} {p.unit}</span> <span class="text-[var(--color-tron-text-secondary)]">({p.previousQuantity} → {p.newQuantity})</span>{#if p.deviceSerial} · SPU {p.deviceSerial}{/if}</span>
											<span class="text-[var(--color-tron-text-secondary)]">{p.performedBy?.username} · {fmt(p.performedAt)}</span>
										</div>
									{/each}
								</div>
							{/if}

							{#if otherMaterials(step).length === 0 && partMaterials(step).length === 0 && !step.materials.length}
								<p class="mt-3 text-[11px] text-[var(--color-tron-text-secondary)]">No materials listed for this step.</p>
							{/if}
						</div>

						<!-- images -->
						<div class="lg:col-span-2">
							{#if step.images.length}
								<div class="grid grid-cols-2 gap-2">
									{#each step.images as im, i (im._id)}
										<figure class="group relative">
											<button class="block w-full overflow-hidden rounded border border-[var(--color-tron-border)] bg-black/30" onclick={() => (lightbox = { url: im.url, caption: im.caption || im.alt || `Step ${step.stepNumber} · image ${i + 1}` })}>
												<img src={im.url} alt={im.alt || `Step ${step.stepNumber} image ${i + 1}`} loading="lazy" class="h-36 w-full object-contain transition group-hover:scale-[1.02]" />
											</button>
											{#if im.caption}<figcaption class="mt-0.5 text-[10px] text-[var(--color-tron-text-secondary)]">{im.caption}</figcaption>{/if}
											{#if editMode}
												<div class="mt-1 flex flex-wrap items-center gap-1 text-[10px]">
													<form method="POST" action="?/updateImage" use:enhance={afterSubmit()} class="flex flex-1 gap-1">
														<input type="hidden" name="sectionNumber" value={section.number} />
														<input type="hidden" name="stepId" value={step._id} />
														<input type="hidden" name="imageId" value={im._id} />
														<input name="caption" value={im.caption ?? ''} placeholder="caption" class="w-full min-w-0 rounded border border-[var(--color-tron-border)] bg-[var(--color-tron-bg)] px-1 py-0.5 text-[var(--color-tron-text)]" />
														<button class="text-amber-300 hover:underline">save</button>
													</form>
													<form method="POST" action="?/updateImage" use:enhance={afterSubmit()} class="inline">
														<input type="hidden" name="sectionNumber" value={section.number} /><input type="hidden" name="stepId" value={step._id} /><input type="hidden" name="imageId" value={im._id} /><input type="hidden" name="direction" value="up" />
														<button class="text-[var(--color-tron-text-secondary)] hover:text-[var(--color-tron-text)]" disabled={i === 0} title="move earlier">◀</button>
													</form>
													<form method="POST" action="?/updateImage" use:enhance={afterSubmit()} class="inline">
														<input type="hidden" name="sectionNumber" value={section.number} /><input type="hidden" name="stepId" value={step._id} /><input type="hidden" name="imageId" value={im._id} /><input type="hidden" name="direction" value="down" />
														<button class="text-[var(--color-tron-text-secondary)] hover:text-[var(--color-tron-text)]" disabled={i === step.images.length - 1} title="move later">▶</button>
													</form>
													<form method="POST" action="?/removeImage" use:enhance={afterSubmit()} class="inline" onsubmit={(e) => { if (!confirm('Remove this image from the step?')) e.preventDefault(); }}>
														<input type="hidden" name="sectionNumber" value={section.number} /><input type="hidden" name="stepId" value={step._id} /><input type="hidden" name="imageId" value={im._id} />
														<button class="text-red-300 hover:underline">remove</button>
													</form>
												</div>
											{/if}
										</figure>
									{/each}
								</div>
							{:else}
								<div class="flex h-24 items-center justify-center rounded border border-dashed border-[var(--color-tron-border)] text-xs text-[var(--color-tron-text-secondary)]">No reference photos</div>
							{/if}
						</div>
					</div>
				</article>
			{/each}

			<!-- add step -->
			{#if editMode}
				<div class="rounded-lg border border-dashed border-[var(--color-tron-border)] p-4">
					{#if !showAddStep}
						<button class="text-sm text-[var(--color-tron-cyan)] hover:underline" onclick={() => { showAddStep = true; addStepHtml = ''; }}>+ Add a step to {sectionLabel(section)}</button>
					{:else}
						<form method="POST" action="?/addStep" use:enhance={afterSubmit(() => (showAddStep = false))} class="space-y-2 text-sm">
							<input type="hidden" name="sectionNumber" value={section.number} />
							<input type="hidden" name="instructionsHtml" value={addStepHtml} />
							<div class="flex flex-wrap gap-2">
								<input name="title" placeholder="Step title" class="flex-1 rounded border border-[var(--color-tron-border)] bg-[var(--color-tron-bg)] px-2 py-1 text-[var(--color-tron-text)]" />
								<select name="afterStepId" class="rounded border border-[var(--color-tron-border)] bg-[var(--color-tron-bg)] px-2 py-1 text-xs text-[var(--color-tron-text)]">
									<option value="">at the end</option>
									{#each section.steps as s}<option value={s._id}>after step {s.stepNumber}</option>{/each}
								</select>
								<label class="flex items-center gap-1 text-xs text-[var(--color-tron-text-secondary)]"><input type="checkbox" name="requiresEsd" /> ESD</label>
							</div>
							<div contenteditable="true" bind:innerHTML={addStepHtml} class="wi-prose min-h-[6rem] rounded border border-[var(--color-tron-border)] bg-[var(--color-tron-bg)] px-3 py-2 text-[var(--color-tron-text)] focus:border-[var(--color-tron-cyan)] focus:outline-none"></div>
							<div class="flex gap-2">
								<button type="submit" class="rounded bg-[var(--color-tron-cyan)] px-3 py-1 font-semibold text-black">Add step</button>
								<button type="button" class="rounded border border-[var(--color-tron-border)] px-3 py-1 text-[var(--color-tron-text-secondary)]" onclick={() => (showAddStep = false)}>Cancel</button>
							</div>
						</form>
					{/if}
				</div>
			{/if}
		{/if}

		<!-- ═══ Recent revisions ═══ -->
		<div class="rounded-lg border border-[var(--color-tron-border)] bg-[var(--color-tron-surface)] p-4">
			<div class="flex items-center justify-between">
				<h2 class="text-sm font-semibold text-[var(--color-tron-text)]">Recent revisions</h2>
				<a href="/spu/assembly-wi/revisions" class="text-xs text-[var(--color-tron-cyan)] hover:underline">All {data.wi.revisions.length} revisions &amp; material pulls →</a>
			</div>
			<ul class="mt-2 divide-y divide-[var(--color-tron-border)] text-xs">
				{#each data.recentRevisions as r (r._id)}
					<li class="flex flex-wrap items-baseline gap-2 py-1.5">
						<span class="font-mono font-semibold text-[var(--color-tron-cyan)]">{r.label}</span>
						<span class="text-[var(--color-tron-text)]">{r.summary}</span>
						<span class="ml-auto whitespace-nowrap text-[var(--color-tron-text-secondary)]">{r.changedBy?.username ?? '—'} · {fmt(r.changedAt)}</span>
					</li>
				{/each}
			</ul>
		</div>

		<datalist id="catalog-parts">
			{#each data.catalog as p}<option value={p.partNumber}>{p.name} (on hand {p.inventoryCount ?? 0})</option>{/each}
		</datalist>
	{/if}
</div>

<!-- lightbox -->
{#if lightbox}
	<div class="fixed inset-0 z-50 flex items-center justify-center bg-black/85 p-4" role="dialog" aria-modal="true" tabindex="-1" onclick={() => (lightbox = null)} onkeydown={(e) => { if (e.key === 'Escape') lightbox = null; }}>
		<figure class="max-h-full max-w-5xl">
			<img src={lightbox.url} alt={lightbox.caption} class="max-h-[85vh] w-auto rounded object-contain" />
			<figcaption class="mt-2 text-center text-sm text-white/80">{lightbox.caption} <span class="ml-2 text-white/50">(click to close)</span></figcaption>
		</figure>
	</div>
{/if}

<style>
	.wi-prose :global(p) { margin: 0 0 0.5rem; }
	.wi-prose :global(p:last-child) { margin-bottom: 0; }
	.wi-prose :global(ul), .wi-prose :global(ol) { margin: 0.25rem 0 0.5rem 1.25rem; }
	.wi-prose :global(ul) { list-style: disc; }
	.wi-prose :global(ol) { list-style: decimal; }
	.wi-prose :global(strong) { color: var(--color-tron-text); font-weight: 600; }
	.wi-prose :global(h3) { font-weight: 600; margin-bottom: 0.25rem; color: var(--color-tron-text); }
	.wi-prose :global(table) { border-collapse: collapse; width: 100%; font-size: 0.8rem; }
	.wi-prose :global(td), .wi-prose :global(th) { border: 1px solid var(--color-tron-border); padding: 0.25rem 0.5rem; text-align: left; vertical-align: top; }
	.wi-prose :global(img) { max-width: 100%; height: auto; }
	.wi-prose :global(.photo-note) { color: var(--color-tron-text-secondary); font-size: 0.75rem; }
</style>
