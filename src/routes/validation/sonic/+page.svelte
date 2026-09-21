<script lang="ts">
	import { enhance } from '$app/forms';

	interface Props {
		data: {
			spus: Array<{ id: string; udi: string; status: string }>;
			recent: Array<{
				id: string; spuUdi: string | null; spuId: string | null; fileName: string | null; size: number | null;
				mimeType: string | null; notes: string | null; recordedBy: string | null; at: string | null; url: string | null;
			}>;
		};
		form: { error?: string; uploaded?: boolean; spuUdi?: string; fileName?: string; size?: number } | null;
	}
	let { data, form }: Props = $props();

	let selectedSpuId = $state('');
	let hasFile = $state(false);
	let uploading = $state(false);
	let fileNonce = $state(0);

	const mb = (n: number | null) => (n == null ? '—' : `${(n / 1048576).toFixed(1)} MB`);
	const when = (iso: string | null) => (iso ? new Date(iso).toLocaleString() : '—');
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

	{#if form?.error}
		<div class="rounded-lg bg-[var(--color-tron-red)]/10 p-4 text-sm text-[var(--color-tron-red)]">{form.error}</div>
	{/if}
	{#if form?.uploaded}
		<div class="rounded-lg bg-[var(--color-tron-green)]/10 p-4 text-sm text-[var(--color-tron-green)]">
			Stored {form.fileName} ({mb(form.size ?? null)}) against {form.spuUdi}. It's in the unit's journal.
		</div>
	{/if}

	<form
		method="POST"
		action="?/upload"
		enctype="multipart/form-data"
		use:enhance={() => {
			uploading = true;
			return async ({ result, update }) => {
				try {
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
					onchange={(e) => (hasFile = ((e.currentTarget as HTMLInputElement).files?.length ?? 0) > 0)}
					required
				/>
			{/key}
			<p class="tron-text-muted mt-2 text-xs">Phone recording in any common format, up to 80 MB. Start recording before the scan and stop after the stage settles.</p>
			<label for="sonic-notes" class="tron-label mt-4">Notes (optional)</label>
			<input id="sonic-notes" name="notes" type="text" class="tron-input w-full" style="min-height: 44px;" placeholder="Phone position, ambient noise, which dummy cartridge…" />
		</div>

		<button
			type="submit"
			disabled={!selectedSpuId || !hasFile || uploading}
			class="w-full rounded-lg bg-[var(--color-tron-orange)] px-6 py-4 text-lg font-semibold text-[var(--color-tron-bg-primary)] transition-all hover:bg-[var(--color-tron-orange)]/90 disabled:cursor-not-allowed disabled:opacity-50"
			style="min-height: 44px"
		>
			{uploading ? 'Uploading…' : 'Store recording'}
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
