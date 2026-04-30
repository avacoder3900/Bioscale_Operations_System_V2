<script lang="ts">
	import { enhance } from '$app/forms';
	import { TronCard } from '$lib/components/ui';

	let { data, form } = $props();
	let submitting = $state(false);
	let clientError = $state<string | null>(null);
</script>

<div class="mx-auto max-w-3xl space-y-6 p-6">
	<header>
		<h1 class="tron-text-primary text-2xl font-bold">SPU Work Instruction</h1>
		<p class="tron-text-muted text-sm">One canonical work instruction governs every SPU build.</p>
	</header>

	<TronCard>
		{#if data.wi && data.activeVersion}
			<div class="space-y-2">
				<p class="tron-text-muted text-xs uppercase tracking-wide">Active</p>
				<p class="tron-text-primary text-lg font-medium">{data.wi.title}</p>
				<p class="tron-text-muted text-xs">
					rev {data.wi.revision || '-'} · v{data.activeVersion.version} ·
					{data.activeVersion.stepCount} steps · {data.activeVersion.barcodeFieldCount} scan fields
				</p>
				{#if data.wi.effectiveDate}
					<p class="tron-text-muted text-xs">
						Effective {new Date(data.wi.effectiveDate).toLocaleDateString()}
					</p>
				{/if}
			</div>
		{:else}
			<p class="tron-text-muted text-sm">No active SPU work instruction. Upload a .docx to begin.</p>
		{/if}
	</TronCard>

	<TronCard>
		<form
			method="POST"
			action="?/upload"
			enctype="multipart/form-data"
			use:enhance={() => {
				clientError = null;
				submitting = true;
				return async ({ result, update }) => {
					try {
						await update();
					} catch (err: any) {
						clientError = err?.message ?? 'Unknown client error';
					}
					submitting = false;
					if (result?.type === 'error') {
						clientError = `Server error: ${(result as any).error?.message ?? 'unknown'}`;
					}
				};
			}}
			class="space-y-4"
		>
			<div>
				<label class="tron-text-primary block text-sm font-medium" for="wi-file">Upload (.docx or .pdf)</label>
				<p class="tron-text-muted text-xs">
					Parser auto-extracts <code>PT-SPU-XXX</code> + <code>qty=X</code> and generates barcode fields. You confirm before induction.
				</p>
			</div>
			<input
				id="wi-file"
				type="file"
				name="file"
				accept=".docx,application/vnd.openxmlformats-officedocument.wordprocessingml.document,.pdf,application/pdf"
				required
				disabled={submitting}
				class="block w-full text-sm"
			/>
			<button
				type="submit"
				disabled={submitting}
				class="rounded-lg bg-[var(--color-tron-cyan)] px-4 py-2 font-semibold text-black hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-50"
			>
				{submitting ? 'Parsing…' : 'Upload & Parse'}
			</button>
			{#if (form as any)?.error}
				<div class="rounded-lg border border-[var(--color-tron-red)] bg-[rgba(255,51,102,0.1)] p-3">
					<p class="text-sm text-[var(--color-tron-red)]">{(form as any).error}</p>
				</div>
			{/if}
			{#if clientError}
				<div class="rounded-lg border border-[var(--color-tron-red)] bg-[rgba(255,51,102,0.1)] p-3">
					<p class="text-sm text-[var(--color-tron-red)]">{clientError}</p>
				</div>
			{/if}
		</form>

		{#if (form as any)?.parsed}
			{@const f = form as any}
			<div class="mt-6 space-y-4 border-t border-white/10 pt-4">
				<div class="rounded-lg border border-[var(--color-tron-cyan)] bg-[rgba(0,229,255,0.08)] p-3">
					<p class="tron-text-primary text-sm font-semibold">
						Parsed {f.fileName} — {f.steps.length} steps · {f.totalRequiredScans} barcode fields · v{f.version} (parser v{f.parserVersion})
					</p>
					<a
						href="/spu/work-instruction/review/{f.versionId}?wi={f.workInstructionId}"
						class="mt-1 inline-block text-xs text-[var(--color-tron-cyan)] hover:underline"
					>
						Open in review editor →
					</a>
				</div>

				{#if f.warnings && f.warnings.length > 0}
					<div class="rounded-lg border border-[var(--color-tron-orange,#ffaa00)] bg-[rgba(255,170,0,0.08)] p-3">
						<p class="tron-text-primary mb-1 text-xs font-semibold">Warnings ({f.warnings.length})</p>
						<ul class="list-disc pl-5 text-xs text-[var(--color-tron-orange,#ffaa00)]">
							{#each f.warnings as w}
								<li>{w}</li>
							{/each}
						</ul>
					</div>
				{/if}

				{#each f.steps as s}
					<div class="rounded-lg border border-white/10 p-3">
						<p class="tron-text-primary text-sm font-semibold">
							Step {s.stepNumber} — {s.title}
						</p>
						<p class="tron-text-muted mt-1 text-xs">
							{s.partRequirements.length} part requirement(s) · {s.fieldCount} barcode field(s) · {s.images.length} image(s)
						</p>
						{#if s.images.length > 0}
							<div class="mt-2 flex flex-wrap gap-2">
								{#each s.images as imgUrl}
									<a href={imgUrl} target="_blank" rel="noopener noreferrer">
										<img
											src={imgUrl}
											alt="step image"
											loading="lazy"
											class="h-24 w-auto rounded border border-white/10 object-contain"
										/>
									</a>
								{/each}
							</div>
						{/if}
						{#if s.content}
							<pre class="tron-text-muted mt-2 max-h-48 overflow-auto whitespace-pre-wrap rounded bg-black/30 p-2 text-xs">{s.content}</pre>
						{:else}
							<p class="tron-text-muted mt-2 text-xs italic">(no body text)</p>
						{/if}
						{#if s.partRequirements.length > 0}
							<div class="mt-2 flex flex-wrap gap-1">
								{#each s.partRequirements as p}
									<span class="rounded bg-[var(--color-tron-bg-tertiary,rgba(255,255,255,0.05))] px-2 py-0.5 font-mono text-xs text-[var(--color-tron-cyan)]">
										{p.partNumber} ×{p.quantity}
									</span>
								{/each}
							</div>
						{/if}
					</div>
				{/each}
			</div>
		{/if}

		{#if data.activeVersion}
			<div class="mt-4 border-t border-white/10 pt-4">
				<a
					href="/spu/work-instruction/review/{data.activeVersion.id}?wi={data.wi?.id}"
					class="inline-block rounded-lg border border-[var(--color-tron-cyan)] px-4 py-2 text-sm text-[var(--color-tron-cyan)] hover:bg-[rgba(0,229,255,0.1)]"
				>
					Edit Active Version
				</a>
			</div>
		{/if}
	</TronCard>

	{#if data.draftVersions.length > 0}
		<TronCard>
			<p class="tron-text-muted mb-3 text-xs uppercase tracking-wide">Other versions</p>
			<ul class="space-y-2 text-sm">
				{#each data.draftVersions as v}
					<li class="flex items-center justify-between">
						<span class="tron-text-primary">
							v{v.version} · {v.stepCount} steps
							{#if v.discarded}
								<span class="ml-2 text-[var(--color-tron-red)]">(discarded)</span>
							{/if}
						</span>
						{#if !v.discarded}
							<a
								href="/spu/work-instruction/review/{v.id}?wi={data.wi?.id}"
								class="text-xs text-[var(--color-tron-cyan)] hover:underline"
							>
								Review
							</a>
						{/if}
					</li>
				{/each}
			</ul>
		</TronCard>
	{/if}

	<p class="tron-text-muted text-center text-xs">Parser v{data.parserVersion}</p>
</div>
