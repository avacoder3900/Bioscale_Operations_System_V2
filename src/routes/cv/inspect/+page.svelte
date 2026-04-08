<script lang="ts">
	let { data } = $props();

	let selectedProjectId = $state('');
	let file = $state<File | null>(null);
	let inspecting = $state(false);
	let inspectError = $state('');
	let result = $state<any>(null);

	async function runInspection() {
		if (!selectedProjectId || !file) return;
		inspecting = true;
		inspectError = '';
		result = null;

		try {
			// Upload image
			const fd = new FormData();
			fd.append('file', file);
			fd.append('projectId', selectedProjectId);
			const uploadRes = await fetch('/api/cv/images', { method: 'POST', body: fd });
			const uploadJson = await uploadRes.json();
			if (!uploadRes.ok) { inspectError = uploadJson.error; inspecting = false; return; }

			// Run inference
			const inferRes = await fetch('/api/cv/infer', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ imageId: uploadJson.data._id, projectId: selectedProjectId })
			});
			const inferJson = await inferRes.json();
			if (!inferRes.ok) { inspectError = inferJson.error; inspecting = false; return; }
			result = inferJson.data;
		} catch (err: any) {
			inspectError = err.message;
		}
		inspecting = false;
	}
</script>

<div class="space-y-6">
	<div class="flex items-center justify-between">
		<h2 class="text-2xl font-bold text-[var(--color-tron-cyan)]">Inspect Image</h2>
		<a href="/cv/history" class="text-sm text-[var(--color-tron-text-secondary)] hover:text-[var(--color-tron-cyan)]">View History &rarr;</a>
	</div>

	<div class="grid gap-6 lg:grid-cols-2">
		<!-- Left: Setup -->
		<div class="space-y-4">
			<div class="rounded-lg border border-[var(--color-tron-border)] bg-[var(--color-tron-bg-secondary)] p-4">
				<div class="space-y-4">
					<div>
						<label for="project" class="mb-1 block text-xs uppercase tracking-wider text-[var(--color-tron-text-secondary)]">Project *</label>
						<select
							id="project"
							bind:value={selectedProjectId}
							class="w-full rounded border border-[var(--color-tron-border)] bg-[var(--color-tron-bg-primary)] px-3 py-2 text-sm text-[var(--color-tron-text-primary)]"
						>
							<option value="">Select a trained project...</option>
							{#each data.projects as p}
								<option value={p._id}>{p.name} ({p.projectType})</option>
							{/each}
						</select>
					</div>

					{#if data.projects.length === 0}
						<p class="text-sm text-[var(--color-tron-yellow)]">No trained projects available. Train a model first.</p>
					{/if}

					<div>
						<label for="imageFile" class="mb-1 block text-xs uppercase tracking-wider text-[var(--color-tron-text-secondary)]">Image *</label>
						<input
							id="imageFile"
							type="file"
							accept="image/*"
							class="w-full text-sm text-[var(--color-tron-text-primary)]"
							onchange={(e) => { const t = e.target as HTMLInputElement; file = t.files?.[0] || null; }}
						/>
					</div>

					<!-- Preview -->
					{#if file}
						<div class="overflow-hidden rounded-lg border border-[var(--color-tron-border)] bg-black">
							<img src={URL.createObjectURL(file)} alt="Preview" class="aspect-video w-full object-contain" />
						</div>
					{/if}

					<button
						onclick={runInspection}
						disabled={inspecting || !selectedProjectId || !file}
						class="w-full rounded-lg bg-[var(--color-tron-cyan)] px-4 py-3 text-lg font-bold text-black transition-colors hover:opacity-90 disabled:opacity-50"
					>
						{inspecting ? 'Running Inspection...' : 'Run Inspection'}
					</button>

					{#if inspectError}
						<div class="rounded border border-[var(--color-tron-red)]/30 bg-[var(--color-tron-red)]/10 p-3 text-sm text-[var(--color-tron-red)]">{inspectError}</div>
					{/if}
				</div>
			</div>
		</div>

		<!-- Right: Result -->
		<div>
			{#if result}
				<div class="rounded-lg border-2 {result.result === 'pass' ? 'border-[var(--color-tron-green)]' : 'border-[var(--color-tron-red)]'} bg-[var(--color-tron-bg-secondary)] p-6">
					<div class="mb-4 text-center">
						<div class="text-5xl font-bold {result.result === 'pass' ? 'text-[var(--color-tron-green)]' : 'text-[var(--color-tron-red)]'}">
							{result.result?.toUpperCase()}
						</div>
					</div>
					<div class="grid grid-cols-2 gap-4 text-center">
						<div>
							<div class="text-xs uppercase text-[var(--color-tron-text-secondary)]">Confidence</div>
							<div class="text-xl font-semibold text-[var(--color-tron-text-primary)]">
								{result.confidenceScore ? Math.round(result.confidenceScore * 100) : '—'}%
							</div>
						</div>
						<div>
							<div class="text-xs uppercase text-[var(--color-tron-text-secondary)]">Processing</div>
							<div class="text-xl font-semibold text-[var(--color-tron-text-primary)]">
								{result.processingTimeMs ? Math.round(result.processingTimeMs) : '—'}ms
							</div>
						</div>
					</div>
					{#if result.defects?.length}
						<div class="mt-4 border-t border-[var(--color-tron-border)] pt-3">
							<p class="mb-2 text-xs uppercase tracking-wider text-[var(--color-tron-text-secondary)]">Defects</p>
							{#each result.defects as defect}
								<div class="flex items-center gap-2 text-sm">
									<span class="text-[var(--color-tron-red)]">&#9679;</span>
									<span class="text-[var(--color-tron-text-primary)]">{defect.type}</span>
									<span class="text-[var(--color-tron-text-secondary)]">— {defect.location} ({defect.severity})</span>
								</div>
							{/each}
						</div>
					{/if}
				</div>
			{:else if !inspecting}
				<div class="flex aspect-video items-center justify-center rounded-lg border border-dashed border-[var(--color-tron-border)] bg-[var(--color-tron-bg-secondary)]">
					<p class="text-[var(--color-tron-text-secondary)]">Inspection result will appear here</p>
				</div>
			{:else}
				<div class="flex aspect-video items-center justify-center rounded-lg border border-[var(--color-tron-border)] bg-[var(--color-tron-bg-secondary)]">
					<div class="text-center">
						<div class="mb-2 animate-pulse text-lg text-[var(--color-tron-cyan)]">Processing...</div>
						<p class="text-sm text-[var(--color-tron-text-secondary)]">Running inference on your image</p>
					</div>
				</div>
			{/if}
		</div>
	</div>
</div>
