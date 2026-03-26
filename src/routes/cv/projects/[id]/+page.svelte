<script lang="ts">
	let { data } = $props();
	let activeTab = $state('import');
	const tabs = ['Import', 'Labels', 'Train', 'Test', 'Review', 'Integrate'];

	// Import tab
	let uploading = $state(false);
	let uploadMsg = $state('');
	let dragOver = $state(false);

	// Labels tab
	let labeling = $state<string | null>(null);

	// Train tab
	let training = $state(false);
	let trainStatus = $state<any>(null);
	let trainPollTimer = $state<ReturnType<typeof setInterval> | null>(null);

	// Test tab
	let testFile = $state<File | null>(null);
	let testing = $state(false);
	let testResult = $state<any>(null);

	const statusColors: Record<string, string> = {
		untrained: 'var(--color-tron-text-secondary)',
		training: 'var(--color-tron-yellow)',
		trained: 'var(--color-tron-green)',
		failed: 'var(--color-tron-red)'
	};

	async function uploadFiles(files: FileList | File[]) {
		uploading = true;
		uploadMsg = '';
		let count = 0;
		let lastError = '';
		for (const file of files) {
			try {
				// Step 1: Get presigned URL
				const presignRes = await fetch('/api/cv/images/presign', {
					method: 'POST',
					headers: { 'Content-Type': 'application/json' },
					body: JSON.stringify({ projectId: data.project._id, filename: file.name, contentType: file.type || 'image/jpeg' })
				});
				if (!presignRes.ok) {
					const err = await presignRes.json().catch(() => ({}));
					lastError = err.error || `Presign failed (${presignRes.status})`;
					continue;
				}
				const { uploadUrl, key } = await presignRes.json();

				// Step 2: Upload directly to R2 via presigned URL
				const putRes = await fetch(uploadUrl, {
					method: 'PUT',
					headers: { 'Content-Type': file.type || 'image/jpeg' },
					body: file
				});
				if (!putRes.ok) {
					lastError = `R2 upload failed (${putRes.status})`;
					continue;
				}

				// Step 3: Create DB record
				const recordRes = await fetch('/api/cv/images/record', {
					method: 'POST',
					headers: { 'Content-Type': 'application/json' },
					body: JSON.stringify({ projectId: data.project._id, key, filename: file.name, contentType: file.type || 'image/jpeg', fileSize: file.size })
				});
				if (recordRes.ok) {
					count++;
				} else {
					const err = await recordRes.json().catch(() => ({}));
					lastError = err.error || `Record failed (${recordRes.status})`;
				}
			} catch (e: any) {
				lastError = e.message || 'Network error';
				console.error('Upload exception:', e);
			}
		}
		uploadMsg = count > 0
			? `Uploaded ${count} image${count !== 1 ? 's' : ''}${lastError ? ` (${files.length - count} failed: ${lastError})` : ''}`
			: `Upload failed: ${lastError || 'Unknown error'}`;
		uploading = false;
		if (count > 0) setTimeout(() => location.reload(), 800);
	}

	function handleDrop(e: DragEvent) {
		e.preventDefault();
		dragOver = false;
		if (e.dataTransfer?.files.length) uploadFiles(e.dataTransfer.files);
	}

	function handleFileInput(e: Event) {
		const input = e.target as HTMLInputElement;
		if (input.files?.length) uploadFiles(input.files);
	}

	async function toggleLabel(imageId: string, current: string | null, newLabel: string) {
		labeling = imageId;
		const label = current === newLabel ? null : newLabel;
		try {
			await fetch(`/api/cv/images/${imageId}/label`, {
				method: 'PATCH',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ label })
			});
			const img = data.images.find((i: any) => i._id === imageId);
			if (img) img.label = label;
			data.images = [...data.images]; // trigger reactivity
		} catch { /* skip */ }
		labeling = null;
	}

	async function startTraining() {
		training = true;
		try {
			const res = await fetch('/api/cv/train', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ projectId: data.project._id })
			});
			const json = await res.json();
			if (!res.ok) { trainStatus = { status: 'failed', message: json.error }; training = false; return; }
			trainStatus = { status: 'training', progress: 0, message: 'Training started...' };
			pollTraining();
		} catch (err: any) {
			trainStatus = { status: 'failed', message: err.message };
			training = false;
		}
	}

	function pollTraining() {
		trainPollTimer = setInterval(async () => {
			try {
				const res = await fetch(`/api/cv/train?projectId=${data.project._id}`);
				const json = await res.json();
				trainStatus = json.data;
				if (trainStatus.status === 'complete' || trainStatus.status === 'failed') {
					clearInterval(trainPollTimer!);
					trainPollTimer = null;
					training = false;
				}
			} catch { /* retry */ }
		}, 3000);
	}

	async function runTest() {
		if (!testFile) return;
		testing = true;
		testResult = null;
		// First upload the test image
		const fd = new FormData();
		fd.append('file', testFile);
		fd.append('projectId', data.project._id);
		try {
			const uploadRes = await fetch('/api/cv/images', { method: 'POST', body: fd });
			const uploadJson = await uploadRes.json();
			if (!uploadRes.ok) { testResult = { error: uploadJson.error }; testing = false; return; }

			// Run inference
			const inferRes = await fetch('/api/cv/infer', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ imageId: uploadJson.data._id, projectId: data.project._id })
			});
			testResult = (await inferRes.json()).data || (await inferRes.json());
		} catch (err: any) {
			testResult = { error: err.message };
		}
		testing = false;
	}

	function fmtDate(d: string) {
		return new Date(d).toLocaleDateString('en-US', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
	}
</script>

<div class="space-y-6">
	<!-- Header -->
	<div class="flex items-center justify-between">
		<div>
			<a href="/cv" class="text-xs text-[var(--color-tron-text-secondary)] hover:text-[var(--color-tron-cyan)]">&larr; All Projects</a>
			<h2 class="text-2xl font-bold text-[var(--color-tron-cyan)]">{data.project.name}</h2>
			{#if data.project.description}
				<p class="mt-1 text-sm text-[var(--color-tron-text-secondary)]">{data.project.description}</p>
			{/if}
		</div>
		<span
			class="rounded-full px-3 py-1 text-sm font-semibold"
			style="color: {statusColors[data.project.modelStatus]}; background: color-mix(in srgb, {statusColors[data.project.modelStatus]} 20%, transparent)"
		>
			{data.project.modelStatus?.toUpperCase()}
		</span>
	</div>

	<!-- Stats Bar -->
	<div class="grid grid-cols-2 gap-3 sm:grid-cols-5">
		<div class="rounded-lg border border-[var(--color-tron-border)] bg-[var(--color-tron-bg-secondary)] p-3 text-center">
			<div class="text-xl font-bold text-[var(--color-tron-text-primary)]">{data.project.imageCount || 0}</div>
			<div class="text-xs text-[var(--color-tron-text-secondary)]">Images</div>
		</div>
		<div class="rounded-lg border border-[var(--color-tron-border)] bg-[var(--color-tron-bg-secondary)] p-3 text-center">
			<div class="text-xl font-bold text-[var(--color-tron-green)]">{data.labelStats.approved}</div>
			<div class="text-xs text-[var(--color-tron-text-secondary)]">Approved</div>
		</div>
		<div class="rounded-lg border border-[var(--color-tron-border)] bg-[var(--color-tron-bg-secondary)] p-3 text-center">
			<div class="text-xl font-bold text-[var(--color-tron-red)]">{data.labelStats.rejected}</div>
			<div class="text-xs text-[var(--color-tron-text-secondary)]">Rejected</div>
		</div>
		<div class="rounded-lg border border-[var(--color-tron-border)] bg-[var(--color-tron-bg-secondary)] p-3 text-center">
			<div class="text-xl font-bold text-[var(--color-tron-text-secondary)]">{data.labelStats.unlabeled}</div>
			<div class="text-xs text-[var(--color-tron-text-secondary)]">Unlabeled</div>
		</div>
		<div class="rounded-lg border border-[var(--color-tron-border)] bg-[var(--color-tron-bg-secondary)] p-3 text-center">
			<div class="text-xl font-bold text-[var(--color-tron-purple)]">{data.inspections.length}</div>
			<div class="text-xs text-[var(--color-tron-text-secondary)]">Inspections</div>
		</div>
	</div>

	<!-- Tab Bar -->
	<div class="flex gap-1 overflow-x-auto rounded-lg border border-[var(--color-tron-border)] bg-[var(--color-tron-bg-secondary)] p-1">
		{#each tabs as tab}
			<button
				class="whitespace-nowrap rounded-md px-4 py-2 text-sm font-medium transition-colors {activeTab === tab.toLowerCase() ? 'bg-[var(--color-tron-cyan)]/20 text-[var(--color-tron-cyan)]' : 'text-[var(--color-tron-text-secondary)] hover:text-[var(--color-tron-text-primary)]'}"
				onclick={() => activeTab = tab.toLowerCase()}
			>
				{tab}
			</button>
		{/each}
	</div>

	<!-- Tab Content -->
	<div class="rounded-lg border border-[var(--color-tron-border)] bg-[var(--color-tron-bg-secondary)] p-6">

		<!-- IMPORT TAB -->
		{#if activeTab === 'import'}
			<div
				class="flex min-h-[200px] flex-col items-center justify-center rounded-lg border-2 border-dashed transition-colors {dragOver ? 'border-[var(--color-tron-cyan)] bg-[var(--color-tron-cyan)]/5' : 'border-[var(--color-tron-border)]'}"
				role="button"
				tabindex="0"
				ondragover={(e) => { e.preventDefault(); dragOver = true; }}
				ondragleave={() => dragOver = false}
				ondrop={handleDrop}
			>
				<svg class="mb-3 h-12 w-12 text-[var(--color-tron-text-secondary)]" fill="none" stroke="currentColor" viewBox="0 0 24 24">
					<path stroke-linecap="round" stroke-linejoin="round" stroke-width="1.5" d="M7 16a4 4 0 01-.88-7.903A5 5 0 1115.9 6L16 6a5 5 0 011 9.9M15 13l-3-3m0 0l-3 3m3-3v12"/>
				</svg>
				<p class="mb-2 text-[var(--color-tron-text-primary)]">Drag & drop images here</p>
				<p class="mb-4 text-sm text-[var(--color-tron-text-secondary)]">or click to browse</p>
				<label class="cursor-pointer rounded-lg bg-[var(--color-tron-cyan)] px-4 py-2 text-sm font-medium text-black hover:opacity-90">
					Browse Files
					<input type="file" accept="image/*" multiple class="hidden" onchange={handleFileInput} />
				</label>
			</div>
			{#if uploading}
				<p class="mt-3 text-center text-sm text-[var(--color-tron-yellow)]">Uploading...</p>
			{/if}
			{#if uploadMsg}
				<p class="mt-3 text-center text-sm text-[var(--color-tron-green)]">{uploadMsg}</p>
			{/if}

		<!-- LABELS TAB -->
		{:else if activeTab === 'labels'}
			{#if data.images.length === 0}
				<p class="text-center text-[var(--color-tron-text-secondary)]">No images yet. Upload images in the Import tab.</p>
			{:else}
				<div class="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4">
					{#each data.images as image (image._id)}
						<div class="group relative overflow-hidden rounded-lg border border-[var(--color-tron-border)] bg-[var(--color-tron-bg-primary)]">
							<div class="aspect-square bg-[var(--color-tron-bg-tertiary)]">
								{#if image.imageUrl}
									<img src={image.imageUrl} alt={image.filename} class="h-full w-full object-cover" />
								{:else}
									<div class="flex h-full items-center justify-center text-xs text-[var(--color-tron-text-secondary)]">No preview</div>
								{/if}
							</div>
							<!-- Label badge -->
							{#if image.label}
								<span class="absolute left-2 top-2 rounded-full px-2 py-0.5 text-xs font-semibold {image.label === 'approved' ? 'bg-[var(--color-tron-green)]/20 text-[var(--color-tron-green)]' : 'bg-[var(--color-tron-red)]/20 text-[var(--color-tron-red)]'}">
									{image.label === 'approved' ? 'GOOD' : 'DEFECT'}
								</span>
							{/if}
							<!-- Label buttons -->
							<div class="flex border-t border-[var(--color-tron-border)]">
								<button
									class="flex-1 py-1.5 text-xs font-medium transition-colors {image.label === 'approved' ? 'bg-[var(--color-tron-green)]/20 text-[var(--color-tron-green)]' : 'text-[var(--color-tron-text-secondary)] hover:text-[var(--color-tron-green)]'}"
									disabled={labeling === image._id}
									onclick={() => toggleLabel(image._id, image.label, 'approved')}
								>&#10003; Good</button>
								<button
									class="flex-1 border-l border-[var(--color-tron-border)] py-1.5 text-xs font-medium transition-colors {image.label === 'rejected' ? 'bg-[var(--color-tron-red)]/20 text-[var(--color-tron-red)]' : 'text-[var(--color-tron-text-secondary)] hover:text-[var(--color-tron-red)]'}"
									disabled={labeling === image._id}
									onclick={() => toggleLabel(image._id, image.label, 'rejected')}
								>&#10007; Defect</button>
							</div>
						</div>
					{/each}
				</div>
			{/if}

		<!-- TRAIN TAB -->
		{:else if activeTab === 'train'}
			<div class="space-y-6">
				<div class="grid grid-cols-3 gap-4">
					<div class="rounded-lg border border-[var(--color-tron-border)] bg-[var(--color-tron-bg-primary)] p-4 text-center">
						<div class="text-2xl font-bold text-[var(--color-tron-green)]">{data.labelStats.approved}</div>
						<div class="text-xs text-[var(--color-tron-text-secondary)]">Good Images</div>
					</div>
					<div class="rounded-lg border border-[var(--color-tron-border)] bg-[var(--color-tron-bg-primary)] p-4 text-center">
						<div class="text-2xl font-bold text-[var(--color-tron-red)]">{data.labelStats.rejected}</div>
						<div class="text-xs text-[var(--color-tron-text-secondary)]">Defect Images</div>
					</div>
					<div class="rounded-lg border border-[var(--color-tron-border)] bg-[var(--color-tron-bg-primary)] p-4 text-center">
						<div class="text-2xl font-bold text-[var(--color-tron-text-secondary)]">{data.labelStats.unlabeled}</div>
						<div class="text-xs text-[var(--color-tron-text-secondary)]">Unlabeled</div>
					</div>
				</div>

				{#if trainStatus}
					<div class="rounded-lg border border-[var(--color-tron-border)] bg-[var(--color-tron-bg-primary)] p-4">
						<div class="mb-2 flex items-center justify-between text-sm">
							<span class="text-[var(--color-tron-text-primary)]">Training Status</span>
							<span class="font-semibold" style="color: {trainStatus.status === 'complete' ? 'var(--color-tron-green)' : trainStatus.status === 'failed' ? 'var(--color-tron-red)' : 'var(--color-tron-yellow)'}">{trainStatus.status?.toUpperCase()}</span>
						</div>
						{#if trainStatus.progress !== undefined}
							<div class="mb-2 h-2 overflow-hidden rounded-full bg-[var(--color-tron-bg-tertiary)]">
								<div class="h-full rounded-full bg-gradient-to-r from-[var(--color-tron-cyan)] to-[var(--color-tron-green)] transition-all" style="width: {Math.round(trainStatus.progress * 100)}%"></div>
							</div>
						{/if}
						{#if trainStatus.message}
							<p class="text-xs text-[var(--color-tron-text-secondary)]">{trainStatus.message}</p>
						{/if}
					</div>
				{/if}

				<button
					class="w-full rounded-lg bg-[var(--color-tron-cyan)] px-4 py-3 text-sm font-medium text-black hover:opacity-90 disabled:opacity-50"
					disabled={training || (data.labelStats.approved + data.labelStats.rejected) < 5}
					onclick={startTraining}
				>
					{#if training}Training in Progress...{:else}Start Training{/if}
				</button>
				{#if (data.labelStats.approved + data.labelStats.rejected) < 5}
					<p class="text-center text-xs text-[var(--color-tron-text-secondary)]">Need at least 5 labeled images to start training.</p>
				{/if}
			</div>

		<!-- TEST TAB -->
		{:else if activeTab === 'test'}
			<div class="space-y-4">
				{#if data.project.modelStatus !== 'trained'}
					<p class="text-center text-[var(--color-tron-text-secondary)]">Train a model first before running tests.</p>
				{:else}
					<div>
						<label class="mb-1 block text-xs uppercase tracking-wider text-[var(--color-tron-text-secondary)]">Test Image</label>
						<input type="file" accept="image/*" class="w-full text-sm text-[var(--color-tron-text-primary)]" onchange={(e) => { const t = e.target as HTMLInputElement; testFile = t.files?.[0] || null; }} />
					</div>
					<button
						class="rounded-lg bg-[var(--color-tron-cyan)] px-4 py-2 text-sm font-medium text-black hover:opacity-90 disabled:opacity-50"
						disabled={!testFile || testing}
						onclick={runTest}
					>
						{testing ? 'Running Inference...' : 'Run Test'}
					</button>

					{#if testResult}
						{#if testResult.error}
							<div class="rounded border border-[var(--color-tron-red)]/30 bg-[var(--color-tron-red)]/10 p-4 text-sm text-[var(--color-tron-red)]">{testResult.error}</div>
						{:else}
							<div class="rounded-lg border border-[var(--color-tron-border)] bg-[var(--color-tron-bg-primary)] p-6 text-center">
								<div class="mb-2 text-4xl font-bold {testResult.result === 'pass' ? 'text-[var(--color-tron-green)]' : 'text-[var(--color-tron-red)]'}">
									{testResult.result?.toUpperCase()}
								</div>
								<div class="text-sm text-[var(--color-tron-text-secondary)]">
									Confidence: <span class="font-semibold text-[var(--color-tron-text-primary)]">{Math.round((testResult.confidenceScore || 0) * 100)}%</span>
								</div>
								{#if testResult.processingTimeMs}
									<div class="text-xs text-[var(--color-tron-text-secondary)]">{Math.round(testResult.processingTimeMs)}ms</div>
								{/if}
							</div>
						{/if}
					{/if}
				{/if}
			</div>

		<!-- REVIEW TAB -->
		{:else if activeTab === 'review'}
			{#if data.inspections.length === 0}
				<p class="text-center text-[var(--color-tron-text-secondary)]">No inspections yet.</p>
			{:else}
				<div class="overflow-x-auto">
					<table class="w-full">
						<thead>
							<tr class="border-b border-[var(--color-tron-border)] text-left">
								<th class="px-4 py-3 text-xs uppercase tracking-wider text-[var(--color-tron-text-secondary)]">Result</th>
								<th class="px-4 py-3 text-xs uppercase tracking-wider text-[var(--color-tron-text-secondary)]">Confidence</th>
								<th class="px-4 py-3 text-xs uppercase tracking-wider text-[var(--color-tron-text-secondary)]">Status</th>
								<th class="px-4 py-3 text-xs uppercase tracking-wider text-[var(--color-tron-text-secondary)]">Phase</th>
								<th class="px-4 py-3 text-xs uppercase tracking-wider text-[var(--color-tron-text-secondary)]">Date</th>
							</tr>
						</thead>
						<tbody class="divide-y divide-[var(--color-tron-border)]">
							{#each data.inspections as insp (insp._id)}
								<tr class="transition-colors hover:bg-[var(--color-tron-bg-tertiary)]">
									<td class="px-4 py-2">
										{#if insp.result}
											<span class="rounded-full px-2 py-0.5 text-xs font-semibold {insp.result === 'pass' ? 'bg-[var(--color-tron-green)]/20 text-[var(--color-tron-green)]' : 'bg-[var(--color-tron-red)]/20 text-[var(--color-tron-red)]'}">
												{insp.result.toUpperCase()}
											</span>
										{:else}
											<span class="text-xs text-[var(--color-tron-text-secondary)]">—</span>
										{/if}
									</td>
									<td class="px-4 py-2 text-sm text-[var(--color-tron-text-primary)]">{insp.confidenceScore ? Math.round(insp.confidenceScore * 100) + '%' : '—'}</td>
									<td class="px-4 py-2 text-sm text-[var(--color-tron-text-secondary)]">{insp.status}</td>
									<td class="px-4 py-2 text-sm text-[var(--color-tron-text-secondary)]">{insp.phase || '—'}</td>
									<td class="px-4 py-2 text-sm text-[var(--color-tron-text-secondary)]">{fmtDate(insp.createdAt)}</td>
								</tr>
							{/each}
						</tbody>
					</table>
				</div>
			{/if}

		<!-- INTEGRATE TAB -->
		{:else if activeTab === 'integrate'}
			<div class="space-y-4">
				<h3 class="text-lg font-semibold text-[var(--color-tron-text-primary)]">API Endpoints</h3>
				<div class="space-y-2 text-sm">
					{#each [
						['GET', `/api/cv/projects/${data.project._id}`, 'Get project details'],
						['GET', `/api/cv/projects/${data.project._id}/images`, 'List project images'],
						['POST', '/api/cv/images', 'Upload image (multipart, projectId required)'],
						['PATCH', '/api/cv/images/:id/label', 'Set image label (approved/rejected)'],
						['POST', '/api/cv/train', 'Start training (projectId in body)'],
						['GET', `/api/cv/train?projectId=${data.project._id}`, 'Poll training status'],
						['POST', '/api/cv/infer', 'Run inference (imageId + projectId in body)']
					] as [method, path, desc]}
						<div class="flex items-start gap-3 rounded border border-[var(--color-tron-border)] bg-[var(--color-tron-bg-primary)] p-3">
							<span class="rounded bg-[var(--color-tron-cyan)]/20 px-2 py-0.5 text-xs font-bold text-[var(--color-tron-cyan)]">{method}</span>
							<div>
								<code class="text-xs text-[var(--color-tron-text-primary)]">{path}</code>
								<p class="text-xs text-[var(--color-tron-text-secondary)]">{desc}</p>
							</div>
						</div>
					{/each}
				</div>

				<h3 class="mt-6 text-lg font-semibold text-[var(--color-tron-text-primary)]">Manufacturing Gate Integration</h3>
				<p class="text-sm text-[var(--color-tron-text-secondary)]">
					To use this CV project as a manufacturing quality gate, call the inference endpoint at each production phase.
					Images with a "fail" result can automatically block the cartridge from proceeding to the next phase.
				</p>
				<div class="rounded border border-[var(--color-tron-border)] bg-[var(--color-tron-bg-primary)] p-3">
					<p class="mb-1 text-xs text-[var(--color-tron-text-secondary)]">Project ID</p>
					<code class="text-sm text-[var(--color-tron-cyan)]">{data.project._id}</code>
				</div>
			</div>
		{/if}
	</div>
</div>
