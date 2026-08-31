<script lang="ts">
	import { enhance } from '$app/forms';
	import { TronCard } from '$lib/components/ui';

	let { data, form } = $props();
	let submitting = $state(false);
	let clientError = $state<string | null>(null);
	let stage = $state<string>('');
	let selectedFile = $state<File | null>(null);
	let httpStatus = $state<number | null>(null);
	let timing = $state<{ startedAt?: number; finishedAt?: number }>({});

	const VERCEL_LIMIT_BYTES = 4_500_000;
	const SOFT_WARN_BYTES = 3_500_000;

	function fmtBytes(b: number) {
		if (b < 1024) return `${b} B`;
		if (b < 1024 * 1024) return `${(b / 1024).toFixed(1)} KB`;
		return `${(b / 1024 / 1024).toFixed(2)} MB`;
	}

	function onFileChange(e: Event) {
		const input = e.currentTarget as HTMLInputElement;
		selectedFile = input.files?.[0] ?? null;
		clientError = null;
		stage = '';
		httpStatus = null;
		timing = {};
	}

	// Files past Vercel's serverless body cap don't go through the form at all —
	// they're PUT straight to R2 through the Cloudflare Worker, and only the
	// resulting key is posted here.
	let usesDirectUpload = $derived(!!selectedFile && selectedFile.size > VERCEL_LIMIT_BYTES);

	let sizeWarning = $derived(
		selectedFile && selectedFile.size > SOFT_WARN_BYTES && !usesDirectUpload
			? `File is ${fmtBytes(selectedFile.size)} — close to Vercel's 4.5 MB limit, may 413.`
			: null
	);
	let blockSubmit = $derived(!selectedFile);
</script>

<div class="mx-auto max-w-3xl space-y-6 p-6">
	<header>
		<h1 class="tron-text-primary text-2xl font-bold">SPU Work Instruction</h1>
		<p class="tron-text-muted text-sm">
			Upload a .docx — BIMS renders it 1:1 with barcode-scan widgets injected next to each
			<code>(PT-SPU-NNN) xN</code> reference.
		</p>
	</header>

	<TronCard>
		{#if data.wi && data.activeVersion}
			<div class="space-y-2">
				<p class="tron-text-muted text-xs uppercase tracking-wide">Active</p>
				<p class="tron-text-primary text-lg font-medium">{data.wi.title}</p>
				<p class="tron-text-muted text-xs">
					rev {data.wi.revision || '-'} · v{data.activeVersion.version} ·
					{data.activeVersion.partCount} parts · {data.activeVersion.barcodeFieldCount} scan fields
				</p>
				{#if data.wi.effectiveDate}
					<p class="tron-text-muted text-xs">
						Effective {new Date(data.wi.effectiveDate).toLocaleDateString()}
					</p>
				{/if}
				<a
					href="/spu/work-instruction/view/{data.activeVersion.id}?wi={data.wi.id}"
					class="mt-2 inline-block text-xs text-[var(--color-tron-cyan)] hover:underline"
				>
					View rendered document →
				</a>
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
			use:enhance={async ({ formData, cancel }) => {
				clientError = null;
				httpStatus = null;
				submitting = true;
				timing = { startedAt: Date.now() };

				const f = selectedFile;
				if (f && f.size > VERCEL_LIMIT_BYTES) {
					// Two-step: mint a single-key token, PUT the bytes to R2 via the
					// Worker, then post only the key. Keeps the request to Vercel tiny.
					try {
						stage = `Requesting upload token for ${fmtBytes(f.size)}…`;
						const tokRes = await fetch('/spu/work-instruction/upload-token', {
							method: 'POST',
							headers: { 'Content-Type': 'application/json' },
							body: JSON.stringify({ fileName: f.name, size: f.size })
						});
						if (!tokRes.ok) {
							throw new Error(`token request ${tokRes.status}: ${(await tokRes.text()).slice(0, 200)}`);
						}
						const tok = await tokRes.json();

						stage = `Uploading ${fmtBytes(f.size)} to R2…`;
						const putRes = await fetch(tok.putUrl, {
							method: 'PUT',
							headers: { 'Content-Type': tok.contentType },
							body: f
						});
						if (!putRes.ok) {
							throw new Error(`R2 upload ${putRes.status}: ${(await putRes.text()).slice(0, 200)}`);
						}

						formData.delete('file');
						formData.set('r2Key', tok.key);
						formData.set('fileName', f.name);
						formData.set('mimeType', f.type || tok.contentType);
						stage = 'Uploaded to R2; asking server to parse…';
					} catch (err: any) {
						clientError = `Direct upload failed: ${err?.message ?? String(err)}`;
						stage = 'Direct upload failed';
						submitting = false;
						cancel();
						return;
					}
				} else {
					stage = `Sending ${f ? fmtBytes(f.size) : '?'} to server…`;
				}

				return async ({ result, update }) => {
					timing.finishedAt = Date.now();
					try {
						stage = 'Server replied; updating page…';
						await update();
					} catch (err: any) {
						clientError = err?.message ?? 'Unknown client error';
					}

					const r = result as any;
					if (r?.type === 'failure') {
						httpStatus = r.status ?? null;
						stage = `Server returned ${httpStatus} (form action failure — see Audit dump)`;
					} else if (r?.type === 'error') {
						httpStatus = r.status ?? null;
						const errObj = r.error ?? {};
						const msg = errObj.message ?? JSON.stringify(errObj);
						if (httpStatus === 413) {
							clientError = `HTTP 413 Payload Too Large. Vercel's serverless body limit (~4.5 MB) was hit before our parser ran. Your file is ${selectedFile ? fmtBytes(selectedFile.size) : '?'}.`;
						} else {
							clientError = `HTTP ${httpStatus ?? '?'} error: ${msg}`;
						}
						stage = `Server returned ${httpStatus ?? 'error'}`;
					} else if (r?.type === 'success') {
						stage = 'Success';
					} else if (r?.type === 'redirect') {
						stage = `Redirect to ${r.location}`;
					} else {
						stage = `Unknown result type: ${r?.type ?? 'undefined'}`;
					}
					submitting = false;
				};
			}}
			class="space-y-4"
		>
			<div>
				<label class="tron-text-primary block text-sm font-medium" for="wi-file">
					Upload (.docx or .pdf)
				</label>
				<p class="tron-text-muted mt-1 text-xs">
					Files over <span class="font-mono">4.5 MB</span> upload straight to R2 storage, bypassing
					the Vercel serverless body cap.
				</p>
				{#if usesDirectUpload && selectedFile}
					<p class="mt-1 text-xs text-[var(--color-tron-cyan)]">
						{fmtBytes(selectedFile.size)} — will use direct-to-R2 upload.
					</p>
				{/if}
			</div>
			<input
				id="wi-file"
				type="file"
				name="file"
				accept=".docx,application/vnd.openxmlformats-officedocument.wordprocessingml.document,.pdf,application/pdf"
				required
				disabled={submitting}
				onchange={onFileChange}
				class="block w-full text-sm"
			/>
			{#if selectedFile}
				<div class="rounded-lg border border-white/10 bg-black/20 p-2 text-xs">
					<p class="tron-text-primary">{selectedFile.name}</p>
					<p class="tron-text-muted">
						{fmtBytes(selectedFile.size)} · {selectedFile.type || 'unknown mime'}
					</p>
				</div>
			{/if}
			{#if sizeWarning}
				<div class="rounded-lg border border-[var(--color-tron-orange,#ffaa00)] bg-[rgba(255,170,0,0.1)] p-3">
					<p class="text-xs text-[var(--color-tron-orange,#ffaa00)]">{sizeWarning}</p>
				</div>
			{/if}
			<button
				type="submit"
				disabled={submitting || blockSubmit}
				class="rounded-lg bg-[var(--color-tron-cyan)] px-4 py-2 font-semibold text-black hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-50"
			>
				{submitting ? 'Parsing…' : 'Upload & Parse'}
			</button>

			{#if stage || timing.startedAt}
				<div class="rounded-lg border border-white/10 bg-black/30 p-3 text-xs">
					<p class="tron-text-primary mb-1 font-semibold">Pipeline status</p>
					<p class="tron-text-muted">Stage: <span class="text-[var(--color-tron-cyan)]">{stage || '(idle)'}</span></p>
					{#if httpStatus !== null}
						<p class="tron-text-muted">HTTP status: <span class="font-mono text-[var(--color-tron-cyan)]">{httpStatus}</span></p>
					{/if}
					{#if timing.startedAt && timing.finishedAt}
						<p class="tron-text-muted">
							Round-trip: <span class="font-mono">{((timing.finishedAt - timing.startedAt) / 1000).toFixed(2)}s</span>
						</p>
					{/if}
				</div>
			{/if}

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

		{#if form}
			<details class="mt-6 rounded-lg border border-white/10 bg-black/30 p-3">
				<summary class="cursor-pointer text-xs font-semibold text-[var(--color-tron-cyan)]">
					Audit dump (click to expand) — deployed parser v{data.parserVersion}
				</summary>
				<pre class="mt-2 max-h-96 overflow-auto whitespace-pre-wrap text-[10px] text-[var(--color-tron-text-secondary)]">{JSON.stringify(form, null, 2)}</pre>
			</details>
		{/if}

		{#if (form as any)?.parsed}
			{@const f = form as any}
			<div class="mt-6 space-y-4 border-t border-white/10 pt-4">
				<div class="rounded-lg border border-[var(--color-tron-cyan)] bg-[rgba(0,229,255,0.08)] p-4">
					<p class="tron-text-primary text-base font-semibold">
						Parsed {f.fileName}
					</p>
					<p class="tron-text-muted mt-1 text-xs">
						{f.partCount} part references · {f.totalRequiredScans} barcode scans · v{f.version} (parser v{f.parserVersion})
					</p>
					<a
						href="/spu/work-instruction/view/{f.versionId}?wi={f.workInstructionId}"
						class="mt-3 inline-block rounded-lg bg-[var(--color-tron-cyan)] px-4 py-2 text-sm font-semibold text-black hover:opacity-90"
					>
						View rendered document →
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

				{#if f.partsList && f.partsList.length > 0}
					<div class="rounded-lg border border-white/10 p-3">
						<p class="tron-text-muted mb-2 text-xs uppercase tracking-wide">
							Parts detected (in document order)
						</p>
						<ul class="space-y-1 text-xs">
							{#each f.partsList as p, i}
								<li class="flex items-baseline gap-2">
									<span class="tron-text-muted w-6 text-right font-mono">{i + 1}.</span>
									<span class="font-mono text-[var(--color-tron-cyan)]">{p.partNumber}</span>
									<span class="tron-text-primary">{p.partName || '(unnamed)'}</span>
									<span class="tron-text-muted">×{p.quantity}</span>
								</li>
							{/each}
						</ul>
					</div>
				{/if}
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
							v{v.version} · {v.partCount} parts
							{#if v.discarded}
								<span class="ml-2 text-[var(--color-tron-red)]">(discarded)</span>
							{/if}
						</span>
						{#if !v.discarded}
							<a
								href="/spu/work-instruction/view/{v.id}?wi={data.wi?.id}"
								class="text-xs text-[var(--color-tron-cyan)] hover:underline"
							>
								View
							</a>
						{/if}
					</li>
				{/each}
			</ul>
		</TronCard>
	{/if}

	<p class="tron-text-muted text-center text-xs">Parser v{data.parserVersion}</p>
</div>
