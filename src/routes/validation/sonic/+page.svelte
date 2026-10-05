<script lang="ts">
	import { applyAction, deserialize, enhance } from '$app/forms';
	import { invalidateAll } from '$app/navigation';
	import type { ActionResult } from '@sveltejs/kit';

	interface Props {
		data: {
			spus: Array<{ id: string; udi: string; status: string }>;
			recent: Array<{
				id: string; spuUdi: string | null; spuId: string | null; fileName: string | null; size: number | null;
				mimeType: string | null; notes: string | null; recordedBy: string | null; at: string | null; url: string | null;
			}>;
			/** True when the browser sends the file straight to the R2 Worker (no 4.5 MB cap). */
			directUpload: boolean;
			maxBytes: number;
			/** Files up to this size go through the form action even when directUpload is on. */
			proxyMaxBytes: number;
		};
		form: { error?: string; uploaded?: boolean; spuUdi?: string; fileName?: string; size?: number } | null;
	}
	let { data, form }: Props = $props();

	let selectedSpuId = $state('');
	let hasFile = $state(false);
	let uploading = $state(false);
	let progress = $state<number | null>(null);
	let fileNonce = $state(0);
	let clientError = $state<string | null>(null);

	const mb = (n: number | null) => (n == null ? '—' : `${(n / 1048576).toFixed(1)} MB`);
	const when = (iso: string | null) => (iso ? new Date(iso).toLocaleString() : '—');
	const limitLabel = $derived(data.directUpload ? '80 MB' : '4.5 MB');

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

	/** POST one named form action from JS and read its ActionResult. */
	async function callAction(name: string, fields: Record<string, string>): Promise<ActionResult> {
		const fd = new FormData();
		for (const [k, v] of Object.entries(fields)) fd.set(k, v);
		const res = await fetch(`?/${name}`, { method: 'POST', body: fd, headers: { 'x-sveltekit-action': 'true' } });
		return deserialize(await res.text());
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
		if (!(file instanceof File) || file.size === 0) {
			clientError = 'Choose the audio file. If it lives in iCloud, open it in the Files app first so it downloads to the phone.';
			return;
		}
		uploading = true;
		clientError = null;
		progress = 0;
		try {
			const p = await callAction('presign', { spuId, fileName: file.name, size: String(file.size), mimeType: file.type });
			const grant = p.type === 'success' ? (p.data as { presign?: { url: string; token: string; expires: number; maxBytes: number; key: string } })?.presign : undefined;
			if (!grant) {
				clientError = describeFailure(p, 'Upload failed: could not start the upload');
				return;
			}
			await putWithProgress(grant.url, file, grant);
			progress = 100;
			const r = await callAction('record', { spuId, key: grant.key, fileName: file.name, size: String(file.size), mimeType: file.type, notes });
			if (r.type !== 'success') {
				clientError = describeFailure(r, 'Upload failed: the file was sent but could not be recorded');
				return;
			}
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
	}
</script>

<div class="space-y-6">
	<div>
		<h1 class="tron-heading text-2xl font-bold">Sonic Fingerprint</h1>
		<p class="tron-text-muted mt-1 text-sm">
			Scan the SONIC- barcode on a unit (firmware v96) — it runs the motion-only assay, about five
			minutes of the cortisol moves with no heat and no reads. Record the sound with a phone and drop
			the file here against the unit. The recording is the record; waveform analysis comes once we
			have a few to compare.
		</p>
	</div>

	{#if clientError ?? form?.error}
		<div class="rounded-lg bg-[var(--color-tron-red)]/10 p-4 text-sm text-[var(--color-tron-red)]">{clientError ?? form?.error}</div>
	{/if}
	{#if form?.uploaded && !clientError}
		<div class="rounded-lg bg-[var(--color-tron-green)]/10 p-4 text-sm text-[var(--color-tron-green)]">
			Stored {form.fileName} ({mb(form.size ?? null)}) against {form.spuUdi}. It's in the unit's journal.
		</div>
	{/if}

	<form
		method="POST"
		action="?/upload"
		enctype="multipart/form-data"
		use:enhance={({ cancel, formData }) => {
			// Only files too big for this POST (Vercel's 4.5 MB body cap, less a margin
			// for the other form fields) go straight to the Worker. Smaller ones ride
			// the proxied form action, which works even while the deployed Worker
			// lacks the /direct route (2026-10-05: it does — every direct upload failed).
			const picked = formData.get('file');
			const fitsProxy = picked instanceof File && picked.size <= data.proxyMaxBytes - 64 * 1024;
			if (data.directUpload && !fitsProxy) {
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
					if (result.type === 'success') { hasFile = false; fileNonce += 1; }
				} finally {
					uploading = false;
				}
			};
		}}
		class="space-y-4"
	>
		<div class="tron-card p-6">
			<h2 class="tron-heading mb-4 text-lg font-semibold">Unit</h2>
			<select name="spuId" bind:value={selectedSpuId} class="tron-select w-full" style="min-height: 44px;" required>
				<option value="" disabled>Choose the unit the recording is of…</option>
				{#each data.spus as s (s.id)}
					<option value={s.id}>{s.udi} — {s.status}</option>
				{/each}
			</select>
		</div>

		<div class="tron-card p-6">
			<h2 class="tron-heading mb-4 text-lg font-semibold">Recording</h2>
			{#key fileNonce}
				<input
					type="file"
					name="file"
					accept="audio/*,.wav,.m4a,.mp3,.aac,.ogg,.webm,.flac,.caf"
					class="tron-input w-full"
					style="min-height: 44px;"
					onchange={onFilePicked}
					required
				/>
			{/key}
			<p class="tron-text-muted mt-2 text-xs">
				Phone recording in any common format, up to {limitLabel}. Start recording before the scan and stop after the stage settles.
				{#if !data.directUpload}On iPhone, Voice Memos at Compressed quality is about 0.5 MB per minute; Lossless is roughly ten times that and will not fit.{/if}
			</p>
			<label for="sonic-notes" class="tron-label mt-4">Notes (optional)</label>
			<input id="sonic-notes" name="notes" type="text" class="tron-input w-full" style="min-height: 44px;" placeholder="Phone position, ambient noise, which dummy cartridge…" />
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
		<h2 class="tron-heading mb-3 text-sm font-semibold uppercase tracking-wide">Recordings ({data.recent.length})</h2>
		{#if data.recent.length === 0}
			<p class="text-sm text-[var(--color-tron-text-secondary)]">None yet.</p>
		{:else}
			<div class="space-y-3">
				{#each data.recent as r (r.id)}
					<div class="flex flex-wrap items-center gap-x-6 gap-y-2 border-b border-[var(--color-tron-border)]/50 pb-3 text-sm">
						<a href={r.spuId ? `/spu/${r.spuId}` : '#'} class="font-mono font-bold text-[var(--color-tron-cyan)] hover:underline">{r.spuUdi ?? '—'}</a>
						<span class="tron-text-primary">{r.fileName ?? '—'}</span>
						<span class="tron-text-muted text-xs">{mb(r.size)} · {when(r.at)} · {r.recordedBy ?? '—'}</span>
						{#if r.notes}<span class="tron-text-muted text-xs">{r.notes}</span>{/if}
						{#if r.url}
							<audio controls preload="none" src={r.url} class="h-8"></audio>
							<a href={r.url} class="text-xs text-[var(--color-tron-cyan)] hover:underline" download>Download</a>
						{/if}
					</div>
				{/each}
			</div>
		{/if}
	</div>
</div>
