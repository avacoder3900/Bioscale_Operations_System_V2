<script lang="ts">
	import { applyAction, deserialize, enhance } from '$app/forms';
	import { goto, invalidateAll } from '$app/navigation';
	import type { ActionResult } from '@sveltejs/kit';

	type Analysis = { state: 'pending' } | { state: 'done'; durationS: number | null } | { state: 'error'; error: string };
	interface Recording {
		id: string; spuUdi: string | null; spuId: string | null; fileName: string | null; size: number | null;
		mimeType: string | null; notes: string | null; recordedBy: string | null; at: string | null; url: string | null;
		assay: string | null; analysis: Analysis; reference: boolean;
		verdict: { passed: number; total: number; at: string | null } | null;
	}
	interface Props {
		data: {
			spus: Array<{ id: string; udi: string; status: string }>;
			recent: Recording[];
			/** True when the browser sends the file straight to the R2 Worker (no 4.5 MB cap). */
			directUpload: boolean;
			maxBytes: number;
			assays: Array<{ key: string; label: string }>;
			refCounts: Record<string, number>;
			minReferences: number;
		};
		form: { error?: string; uploaded?: boolean; sessionId?: string; spuUdi?: string; fileName?: string; size?: number } | null;
	}
	let { data, form }: Props = $props();

	let selectedSpuId = $state('');
	let assay = $state('SONIC');
	let hasFile = $state(false);
	let uploading = $state(false);
	let progress = $state<number | null>(null);
	let fileNonce = $state(0);
	let clientError = $state<string | null>(null);
	let notice = $state<string | null>(null);
	/** Sessions being analyzed right now (server decode + fingerprint). */
	let busy = $state<Record<string, string>>({});
	let selected = $state<Record<string, boolean>>({});
	let assayFilter = $state('ALL');

	const mb = (n: number | null) => (n == null ? '—' : `${(n / 1048576).toFixed(1)} MB`);
	const when = (iso: string | null) => (iso ? new Date(iso).toLocaleString() : '—');
	const limitLabel = $derived(data.directUpload ? '80 MB' : '4.5 MB');
	const shown = $derived(data.recent.filter((r) => assayFilter === 'ALL' || (r.assay ?? 'UNKNOWN') === assayFilter));
	const selectedIds = $derived(Object.keys(selected).filter((k) => selected[k]));
	const pending = $derived(data.recent.filter((r) => r.analysis.state === 'pending'));

	// Proxied uploads ride through a Vercel function, which drops bodies over 4.5 MB
	// before the form action runs — so the server's own size check never sees a big
	// file. Gate it here. With direct upload on, the cap is the Worker's 80 MB.
	function onFilePicked(e: Event) {
		const f = (e.currentTarget as HTMLInputElement).files?.[0] ?? null;
		if (f && f.size > data.maxBytes) {
			clientError = data.directUpload
				? `Upload failed: ${f.name} is ${mb(f.size)}, over the ${limitLabel} limit. Record a shorter clip or switch Voice Memos to Compressed quality.`
				: `Upload failed: ${f.name} is ${mb(f.size)}, over the ${limitLabel} limit. Switch Voice Memos to Compressed quality (Settings → Voice Memos → Audio Quality) or record a shorter clip.`;
			hasFile = false;
			return;
		}
		clientError = null;
		hasFile = f != null;
	}

	function describeFailure(result: ActionResult, fallback: string): string {
		if (result.type === 'failure') return (result.data as { error?: string } | undefined)?.error ?? fallback;
		if (result.type === 'error') {
			const status = (result as { status?: number }).status;
			const msg = (result.error as { message?: string } | undefined)?.message;
			return `${fallback}${status ? ` (HTTP ${status})` : ''}${msg ? `: ${msg}` : ''}`;
		}
		return fallback;
	}

	/**
	 * POST one named form action from JS and read its ActionResult. Never throws: a network
	 * failure or a non-JSON body (e.g. Vercel's plain-text timeout page) becomes an error result.
	 */
	async function callAction(name: string, fields: Record<string, string>): Promise<ActionResult> {
		const fd = new FormData();
		for (const [k, v] of Object.entries(fields)) fd.set(k, v);
		let res: Response;
		try {
			res = await fetch(`?/${name}`, { method: 'POST', body: fd, headers: { 'x-sveltekit-action': 'true' } });
		} catch (err) {
			return { type: 'error', error: { message: err instanceof Error ? err.message : String(err) } };
		}
		const text = await res.text();
		try {
			return deserialize(text);
		} catch {
			return { type: 'error', status: res.status, error: { message: text.slice(0, 200) || res.statusText } };
		}
	}

	/** Decode + fingerprint on the server, then (if the reference set allows) score. */
	async function analyze(id: string, udi: string | null) {
		busy = { ...busy, [id]: `Analyzing ${udi ?? ''}…` };
		try {
			const r = await callAction('analyze', { sessionId: id });
			if (r.type === 'success') {
				const d = (r.data ?? {}) as { verdictStatus?: string; referenceCount?: number; scoreError?: string };
				notice =
					d.verdictStatus === 'scored'
						? `${udi}: analyzed and scored against the reference set.`
						: d.verdictStatus === 'insufficient'
							? `${udi}: analyzed. No verdict yet — this assay has ${d.referenceCount ?? 0} of ${data.minReferences} reference recordings needed.`
							: d.verdictStatus === 'no-assay'
								? `${udi}: analyzed. Set its assay to get a verdict.`
								: d.verdictStatus === 'error'
									? `${udi}: analyzed, but scoring against the references failed${d.scoreError ? `: ${d.scoreError}` : ''}.`
									: `${udi}: analyzed.`;
				clientError = null;
			} else {
				clientError = describeFailure(r, `Analysis of ${udi} failed`);
			}
		} finally {
			const { [id]: _, ...rest } = busy;
			busy = rest;
			await invalidateAll();
		}
	}

	async function analyzeAllPending() {
		for (const r of pending) await analyze(r.id, r.spuUdi);
	}

	async function simpleAction(name: string, fields: Record<string, string>, ok: string): Promise<boolean> {
		const r = await callAction(name, fields);
		const success = r.type === 'success';
		if (success) {
			notice = ok;
			clientError = null;
		} else clientError = describeFailure(r, `${name} failed`);
		await invalidateAll();
		return success;
	}

	/** The row's assay select is one-way bound: put it back if the change did not stick. */
	async function changeAssay(r: Recording, el: HTMLSelectElement) {
		const ok = await simpleAction('setAssay', { sessionId: r.id, assay: el.value }, `${r.spuUdi}: assay set.`);
		if (!ok) el.value = r.assay ?? '';
	}

	function compareSelected() {
		if (selectedIds.length < 2) return;
		goto(`/validation/sonic/compare?ids=${selectedIds.join(',')}`);
	}

	/** PUT the file to the Worker with upload progress (fetch has none). */
	function putWithProgress(url: string, file: File, h: { token: string; expires: number; maxBytes: number }): Promise<void> {
		return new Promise((resolve, reject) => {
			const xhr = new XMLHttpRequest();
			xhr.open('PUT', url);
			xhr.setRequestHeader('Content-Type', file.type || 'application/octet-stream');
			xhr.setRequestHeader('X-Upload-Token', h.token);
			xhr.setRequestHeader('X-Upload-Expires', String(h.expires));
			xhr.setRequestHeader('X-Upload-Max', String(h.maxBytes));
			xhr.upload.onprogress = (ev) => {
				if (ev.lengthComputable) progress = Math.round((ev.loaded / ev.total) * 100);
			};
			xhr.onload = () =>
				xhr.status >= 200 && xhr.status < 300
					? resolve()
					: reject(new Error(`storage returned HTTP ${xhr.status}${xhr.responseText ? `: ${xhr.responseText.slice(0, 200)}` : ''}`));
			xhr.onerror = () => reject(new Error('network error while sending the file to storage'));
			xhr.onabort = () => reject(new Error('upload was interrupted (keep the page open until it finishes)'));
			xhr.send(file);
		});
	}

	/** Direct path: presign → PUT to the Worker → record. Nothing here is the 4.5 MB body. */
	async function directUpload(formData: FormData) {
		const file = formData.get('file');
		const spuId = formData.get('spuId')?.toString() ?? '';
		const notes = formData.get('notes')?.toString() ?? '';
		const assayField = formData.get('assay')?.toString() ?? 'SONIC';
		if (!(file instanceof File) || file.size === 0) {
			clientError = 'Choose the audio file. If it lives in iCloud, open it in the Files app first so it downloads to the phone.';
			return;
		}
		uploading = true;
		clientError = null;
		progress = 0;
		let recorded: { sessionId?: string; spuUdi?: string } | null = null;
		try {
			const p = await callAction('presign', { spuId, fileName: file.name, size: String(file.size), mimeType: file.type });
			const grant = p.type === 'success' ? (p.data as { presign?: { url: string; token: string; expires: number; maxBytes: number; key: string } })?.presign : undefined;
			if (!grant) {
				clientError = describeFailure(p, 'Upload failed: could not start the upload');
				return;
			}
			await putWithProgress(grant.url, file, grant);
			progress = 100;
			const r = await callAction('record', { spuId, key: grant.key, fileName: file.name, size: String(file.size), mimeType: file.type, notes, assay: assayField });
			if (r.type !== 'success') {
				clientError = describeFailure(r, 'Upload failed: the file was sent but could not be recorded');
				return;
			}
			recorded = r.data as { sessionId?: string; spuUdi?: string };
			await applyAction(r);
			await invalidateAll();
			hasFile = false;
			fileNonce += 1;
		} catch (err) {
			clientError = `Upload failed: ${err instanceof Error ? err.message : String(err)}. The recording was not stored.`;
		} finally {
			uploading = false;
			progress = null;
		}
		if (recorded?.sessionId) await analyze(recorded.sessionId, recorded.spuUdi ?? null);
	}
</script>

<div class="space-y-6">
	<div class="flex flex-wrap items-start justify-between gap-4">
		<div>
			<h1 class="tron-heading text-2xl font-bold">Sonic Fingerprint</h1>
			<p class="tron-text-muted mt-1 max-w-3xl text-sm">
				Scan the SONIC- barcode on a unit (firmware v96) — it runs the motion-only assay, about five
				minutes of the cortisol moves with no heat and no reads. Record the sound with a phone and drop
				the file here against the unit. The recording is analyzed on the server and compared with the
				reference units of the same assay, section by section (advisory — it does not gate release).
			</p>
		</div>
		<a href="/validation/sonic/compare" class="rounded border border-[var(--color-tron-cyan)] px-4 py-2 text-sm text-[var(--color-tron-cyan)] hover:bg-[var(--color-tron-cyan)]/10" style="min-height: 44px; display: inline-flex; align-items: center;">
			Compare recordings →
		</a>
	</div>

	{#if clientError ?? form?.error}
		<div class="rounded-lg bg-[var(--color-tron-red)]/10 p-4 text-sm text-[var(--color-tron-red)]">{clientError ?? form?.error}</div>
	{/if}
	{#if form?.uploaded && !clientError}
		<div class="rounded-lg bg-[var(--color-tron-green)]/10 p-4 text-sm text-[var(--color-tron-green)]">
			Stored {form.fileName} ({mb(form.size ?? null)}) against {form.spuUdi}. It's in the unit's journal.
		</div>
	{/if}
	{#if notice}
		<div class="rounded-lg bg-[var(--color-tron-cyan)]/10 p-3 text-sm text-[var(--color-tron-cyan)]">{notice}</div>
	{/if}
	{#each Object.entries(busy) as [id, msg] (id)}
		<div class="rounded-lg bg-[var(--color-tron-orange)]/10 p-3 text-sm text-[var(--color-tron-orange)]">{msg} (decoding and fingerprinting on the server — a few seconds)</div>
	{/each}

	<form
		method="POST"
		action="?/upload"
		enctype="multipart/form-data"
		use:enhance={({ cancel, formData }) => {
			if (data.directUpload) {
				// The file must not ride this POST (4.5 MB cap) — send it to the Worker instead.
				cancel();
				void directUpload(formData);
				return;
			}
			uploading = true;
			clientError = null;
			return async ({ result, update }) => {
				try {
					if (result.type === 'error') {
						// Vercel's 413 comes back as plain text, so enhance can't parse it as an
						// action result. Surface it here instead of dropping to the error page.
						const status = (result as { status?: number }).status;
						const msg = (result.error as { message?: string } | undefined)?.message;
						clientError = status === 413 || /JSON|Unexpected token/i.test(msg ?? '')
							? 'Upload failed: the file is over the 4.5 MB limit and was rejected before it reached the server.'
							: `Upload failed${status ? ` (HTTP ${status})` : ''}${msg ? `: ${msg}` : ''}. The recording was not stored.`;
						return;
					}
					await update({ reset: result.type === 'success' });
					if (result.type === 'success') {
						hasFile = false;
						fileNonce += 1;
						const d = result.data as { sessionId?: string; spuUdi?: string } | undefined;
						if (d?.sessionId) void analyze(d.sessionId, d.spuUdi ?? null);
					}
				} finally {
					uploading = false;
				}
			};
		}}
		class="space-y-4"
	>
		<div class="grid gap-4 md:grid-cols-2">
			<div class="tron-card p-6">
				<h2 class="tron-heading mb-4 text-lg font-semibold">Unit</h2>
				<select name="spuId" bind:value={selectedSpuId} aria-label="Unit the recording is of" class="tron-select w-full" style="min-height: 44px;" required>
					<option value="" disabled>Choose the unit the recording is of…</option>
					{#each data.spus as s (s.id)}
						<option value={s.id}>{s.udi} — {s.status}</option>
					{/each}
				</select>
			</div>
			<div class="tron-card p-6">
				<h2 class="tron-heading mb-4 text-lg font-semibold">Assay that was running</h2>
				<select name="assay" bind:value={assay} aria-label="Assay that was running" class="tron-select w-full" style="min-height: 44px;">
					{#each data.assays as a (a.key)}
						<option value={a.key}>{a.label} — {data.refCounts[a.key] ?? 0} reference{(data.refCounts[a.key] ?? 0) === 1 ? '' : 's'}</option>
					{/each}
				</select>
				<p class="tron-text-muted mt-2 text-xs">Recordings are only ever compared with references of the same assay.</p>
			</div>
		</div>

		<div class="tron-card p-6">
			<h2 class="tron-heading mb-4 text-lg font-semibold">Recording</h2>
			{#key fileNonce}
				<input
					type="file"
					name="file"
					accept="audio/*,.wav,.m4a,.mp3,.aac,.ogg,.webm,.flac,.caf"
					aria-label="Recording file"
					class="tron-input w-full"
					style="min-height: 44px;"
					onchange={onFilePicked}
					required
				/>
			{/key}
			<p class="tron-text-muted mt-2 text-xs">
				Phone recording, up to {limitLabel}. m4a (iPhone Voice Memos) and wav are analyzed; other formats are stored only.
				Use the same phone at the same marked spot on every unit, start recording before the scan and stop after the stage settles.
				{#if !data.directUpload}On iPhone, Voice Memos at Compressed quality is about 0.5 MB per minute; Lossless is roughly ten times that and will not fit.{/if}
			</p>
			<label for="sonic-notes" class="tron-label mt-4">Notes (optional)</label>
			<input id="sonic-notes" name="notes" type="text" class="tron-input w-full" style="min-height: 44px;" placeholder="Phone model and position, ambient noise, which dummy cartridge…" />
		</div>

		<button
			type="submit"
			disabled={!selectedSpuId || !hasFile || uploading}
			class="w-full rounded-lg bg-[var(--color-tron-orange)] px-6 py-4 text-lg font-semibold text-[var(--color-tron-bg-primary)] transition-all hover:bg-[var(--color-tron-orange)]/90 disabled:cursor-not-allowed disabled:opacity-50"
			style="min-height: 44px"
		>
			{#if uploading}
				{progress == null ? 'Uploading…' : progress < 100 ? `Uploading… ${progress}%` : 'Recording…'}
			{:else}
				Store recording
			{/if}
		</button>
	</form>

	<div class="tron-card p-4">
		<div class="mb-3 flex flex-wrap items-center gap-3">
			<h2 class="tron-heading text-sm font-semibold uppercase tracking-wide">Recordings ({shown.length})</h2>
			<select bind:value={assayFilter} aria-label="Filter recordings by assay" class="tron-select text-sm" style="min-height: 44px;">
				<option value="ALL">All assays</option>
				{#each data.assays as a (a.key)}<option value={a.key}>{a.key}</option>{/each}
				<option value="UNKNOWN">Assay not set</option>
			</select>
			<div class="ml-auto flex flex-wrap gap-2">
				{#if pending.length}
					<button type="button" onclick={analyzeAllPending} disabled={Object.keys(busy).length > 0} class="rounded border border-[var(--color-tron-orange)] px-3 py-2 text-sm text-[var(--color-tron-orange)] hover:bg-[var(--color-tron-orange)]/10 disabled:opacity-40" style="min-height: 44px;">
						Analyze all pending ({pending.length})
					</button>
				{/if}
				<button type="button" onclick={compareSelected} disabled={selectedIds.length < 2} class="rounded bg-[var(--color-tron-cyan)] px-3 py-2 text-sm font-semibold text-[var(--color-tron-bg-primary)] disabled:opacity-40" style="min-height: 44px;">
					Compare selected ({selectedIds.length})
				</button>
			</div>
		</div>
		<p class="tron-text-muted mb-3 text-xs">
			★ = reference (a known-good unit). Each assay needs {data.minReferences}+ references before new recordings get a verdict.
			Verdicts are advisory and don't affect release.
		</p>
		{#if shown.length === 0}
			<p class="text-sm text-[var(--color-tron-text-secondary)]">None yet.</p>
		{:else}
			<div class="space-y-3">
				{#each shown as r (r.id)}
					<div class="flex flex-wrap items-center gap-x-4 gap-y-2 border-b border-[var(--color-tron-border)]/50 pb-3 text-sm">
						<label class="inline-flex items-center justify-center" style="min-height: 44px; min-width: 44px;">
							<input type="checkbox" bind:checked={selected[r.id]} disabled={r.analysis.state !== 'done'} title={r.analysis.state === 'done' ? 'Select to compare' : 'Analyze first'} aria-label={`Select ${r.spuUdi ?? 'recording'} to compare`} class="h-5 w-5" />
						</label>
						<button
							type="button"
							title={r.reference ? 'Reference — click to remove' : 'Use as reference (known-good unit)'}
							aria-label={r.reference ? `Remove ${r.spuUdi ?? 'recording'} from references` : `Use ${r.spuUdi ?? 'recording'} as a reference`}
							aria-pressed={r.reference}
							style="min-height: 44px; min-width: 44px;"
							class="text-lg disabled:opacity-40 {r.reference ? 'text-[var(--color-tron-orange)]' : 'text-[var(--color-tron-text-secondary)]'}"
							disabled={r.analysis.state !== 'done' || !r.assay}
							onclick={() => simpleAction('setReference', { sessionId: r.id, on: r.reference ? '0' : '1' }, r.reference ? `${r.spuUdi} is no longer a reference.` : `${r.spuUdi} is now a ${r.assay} reference.`)}
						>{r.reference ? '★' : '☆'}</button>
						{#if r.spuId}
							<a href={`/spu/${r.spuId}`} class="inline-flex items-center font-mono font-bold text-[var(--color-tron-cyan)] hover:underline" style="min-height: 44px;">{r.spuUdi ?? '—'}</a>
						{:else}
							<span class="font-mono font-bold">{r.spuUdi ?? '—'}</span>
						{/if}
						<select
							class="tron-select text-xs"
							style="min-height: 44px;"
							aria-label={`Assay of ${r.spuUdi ?? 'recording'}`}
							value={r.assay ?? ''}
							onchange={(e) => changeAssay(r, e.currentTarget as HTMLSelectElement)}
						>
							{#if !r.assay}<option value="" disabled>assay?</option>{/if}
							{#each data.assays as a (a.key)}<option value={a.key}>{a.key}</option>{/each}
						</select>
						{#if busy[r.id]}
							<span class="rounded bg-[var(--color-tron-orange)]/15 px-2 py-0.5 text-xs text-[var(--color-tron-orange)]">analyzing…</span>
						{:else if r.analysis.state === 'done'}
							<span class="rounded bg-[var(--color-tron-green)]/15 px-2 py-0.5 text-xs text-[var(--color-tron-green)]">✓ analyzed</span>
						{:else if r.analysis.state === 'error'}
							<span class="rounded bg-[var(--color-tron-red)]/15 px-2 py-0.5 text-xs text-[var(--color-tron-red)]" title={r.analysis.error}>✗ {r.analysis.error}</span>
						{:else}
							<span class="rounded bg-[var(--color-tron-text-secondary)]/15 px-2 py-0.5 text-xs">not analyzed</span>
						{/if}
						{#if r.verdict}
							<span class="rounded px-2 py-0.5 text-xs font-semibold {r.verdict.passed === r.verdict.total ? 'bg-[var(--color-tron-green)]/15 text-[var(--color-tron-green)]' : 'bg-[var(--color-tron-orange)]/15 text-[var(--color-tron-orange)]'}">
								{r.verdict.passed === r.verdict.total ? 'PASS' : 'CHECK'} {r.verdict.passed}/{r.verdict.total}
							</span>
						{/if}
						<span class="tron-text-primary">{r.fileName ?? '—'}</span>
						<span class="tron-text-muted text-xs">{mb(r.size)} · {when(r.at)} · {r.recordedBy ?? '—'}</span>
						{#if r.notes}<span class="tron-text-muted text-xs">{r.notes}</span>{/if}
						{#if r.url}
							<audio controls preload="none" src={r.url} class="h-8"></audio>
						{/if}
						<span class="ml-auto flex items-center gap-3 text-xs">
							{#if r.analysis.state === 'done'}
								<a href="/validation/sonic/{r.id}" class="inline-flex items-center text-[var(--color-tron-cyan)] hover:underline" style="min-height: 44px;">Details</a>
							{/if}
							<button type="button" class="text-[var(--color-tron-cyan)] hover:underline disabled:opacity-40" style="min-height: 44px;" disabled={!!busy[r.id]} onclick={() => analyze(r.id, r.spuUdi)}>
								{r.analysis.state === 'pending' ? 'Analyze' : 'Re-analyze'}
							</button>
							{#if r.url}<a href={r.url} class="inline-flex items-center text-[var(--color-tron-cyan)] hover:underline" style="min-height: 44px;" download>Download</a>{/if}
						</span>
					</div>
				{/each}
			</div>
		{/if}
	</div>
</div>
