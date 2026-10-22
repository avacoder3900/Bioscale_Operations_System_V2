<script lang="ts">
	import { enhance } from '$app/forms';
	import { page } from '$app/stores';

	let { data, form } = $props();

	const BASE = '/manufacturing/cart-mfg/robot-arm/cleanup';

	// Preselect from ?source= (the Control tab's recordings list links here).
	let sourceName = $state('');
	// Same defaults as the server's (load.defaults); 10 steps ignores leader-hand tremor.
	let thresholdSteps = $state(10);
	let pauseS = $state(0.25);
	let busy = $state(false);

	$effect(() => {
		const fromUrl = $page.url.searchParams.get('source');
		if (fromUrl && !sourceName) sourceName = fromUrl;
	});

	const createEnhance = () => {
		busy = true;
		return async ({ update }: { update: (opts?: { reset?: boolean }) => Promise<void> }) => {
			await update({ reset: false });
			busy = false;
		};
	};

	function fmtDate(iso: string) {
		return new Date(iso).toLocaleString();
	}
</script>

<div class="space-y-5">
	{#if form?.error}
		<div class="rounded border border-red-500/40 bg-red-900/10 p-3 text-sm text-red-300">{form.error}</div>
	{:else if form?.success}
		<div class="rounded border border-green-500/40 bg-green-900/10 p-3 text-sm text-green-300">{form.success}</div>
	{/if}

	<section class="rounded-lg border border-[var(--color-tron-border)] bg-[var(--color-tron-surface)] p-4">
		<h2 class="mb-1 text-sm font-bold uppercase tracking-wider" style="color: var(--color-tron-text-secondary)">
			New clean-up
		</h2>
		<p class="mb-3 text-xs" style="color: var(--color-tron-text-secondary)">
			Splits a recording into numbered steps: servo moves that overlap in time share a step. That is all it
			does. Nothing is smoothed or removed; you decide what each step keeps, where each servo ends up and how
			long it takes. The original recording on the Pi is never changed.
		</p>

		{#if data.recordingsError}
			<p class="mb-3 rounded border border-amber-500/40 bg-amber-900/10 p-2 text-xs text-amber-300">
				Cannot list the Pi's recordings: {data.recordingsError}
			</p>
		{/if}

		<form method="POST" action="?/create" use:enhance={createEnhance} class="grid gap-3 sm:grid-cols-[1fr_auto_auto_auto] sm:items-end">
			<label class="block text-xs" style="color: var(--color-tron-text-secondary)">
				Recording on the Pi
				<select
					name="sourceName"
					bind:value={sourceName}
					required
					class="mt-1 w-full rounded border border-[var(--color-tron-border)] bg-black/40 px-2 py-1.5 text-sm"
					style="color: var(--color-tron-text)"
				>
					<option value="" disabled>Pick a recording…</option>
					{#each data.recordings as r (r.path)}
						<option value={r.name}>{r.name} · {(r.size_bytes / 1024).toFixed(0)} KB · {fmtDate(r.modified)}</option>
					{/each}
				</select>
			</label>
			<label class="block text-xs" style="color: var(--color-tron-text-secondary)" title="A servo change of this many encoder steps or less is not a move. 0 = every change counts.">
				Threshold (steps)
				<input
					name="thresholdSteps"
					type="number"
					min="0"
					max="500"
					step="1"
					bind:value={thresholdSteps}
					class="mt-1 w-28 rounded border border-[var(--color-tron-border)] bg-black/40 px-2 py-1.5 text-sm"
					style="color: var(--color-tron-text)"
				/>
			</label>
			<label class="block text-xs" style="color: var(--color-tron-text-secondary)" title="A servo that holds still this long has finished its move.">
				Pause ends a move (s)
				<input
					name="pauseS"
					type="number"
					min="0.05"
					max="5"
					step="0.05"
					bind:value={pauseS}
					class="mt-1 w-28 rounded border border-[var(--color-tron-border)] bg-black/40 px-2 py-1.5 text-sm"
					style="color: var(--color-tron-text)"
				/>
			</label>
			<button
				type="submit"
				disabled={busy || !sourceName}
				class="rounded border border-[var(--color-tron-cyan)]/50 bg-[var(--color-tron-cyan)]/10 px-4 py-2 text-sm font-medium transition-colors hover:bg-[var(--color-tron-cyan)]/20 disabled:cursor-not-allowed disabled:opacity-40"
				style="color: var(--color-tron-cyan)"
			>
				{busy ? 'Splitting…' : 'Split into steps'}
			</button>
		</form>
		<p class="mt-2 text-[11px]" style="color: var(--color-tron-text-secondary)">
			1 step ≈ 0.09° at the joint. Threshold 10 ignores hand tremor on the leader; you can re-split later with
			other settings.
		</p>
	</section>

	<section class="rounded-lg border border-[var(--color-tron-border)] bg-[var(--color-tron-surface)] p-4">
		<div class="flex flex-wrap items-center justify-between gap-3">
			<div class="min-w-0">
				<h2 class="mb-1 text-sm font-bold uppercase tracking-wider" style="color: var(--color-tron-text-secondary)">
					Overlay a pilot's recording on an animated one
				</h2>
				<p class="text-xs" style="color: var(--color-tron-text-secondary)">
					An animated recording plays smoothly but its joints settle short of each pose under load. A teleop
					recording of the same motion has the pilot's corrections for that baked in. The overlay lines the two
					up in time and gives the animation the pilot's positions — the result can be saved to the Pi as it
					is, or opened as a clean-up and sent to Animate.
				</p>
			</div>
			<a
				href={`${BASE}/overlay`}
				class="rounded border border-[var(--color-tron-cyan)]/50 bg-[var(--color-tron-cyan)]/10 px-4 py-2 text-sm font-medium transition-colors hover:bg-[var(--color-tron-cyan)]/20"
				style="color: var(--color-tron-cyan)"
			>
				Pick two recordings →
			</a>
		</div>
	</section>

	<section class="rounded-lg border border-[var(--color-tron-border)] bg-[var(--color-tron-surface)]">
		<div class="border-b border-[var(--color-tron-border)] px-4 py-3">
			<h2 class="text-sm font-bold uppercase tracking-wider" style="color: var(--color-tron-text-secondary)">
				Clean-ups ({data.cleanups.length})
			</h2>
		</div>
		{#if data.cleanups.length === 0}
			<p class="px-4 py-6 text-center text-xs" style="color: var(--color-tron-text-secondary)">
				None yet. Split a recording above to start.
			</p>
		{:else}
			<table class="w-full text-xs">
				<thead
					class="border-b border-[var(--color-tron-border)] text-left uppercase tracking-wider"
					style="color: var(--color-tron-text-secondary)"
				>
					<tr>
						<th class="px-4 py-2">Name</th>
						<th class="px-4 py-2">From</th>
						<th class="px-4 py-2">Steps</th>
						<th class="px-4 py-2">Saved to Pi as</th>
						<th class="px-4 py-2">Last edit</th>
						<th class="w-10 px-4 py-2"><span class="sr-only">Remove</span></th>
					</tr>
				</thead>
				<tbody style="color: var(--color-tron-text)">
					{#each data.cleanups as c (c._id)}
						<tr class="border-b border-[var(--color-tron-border)]/50 last:border-b-0">
							<td class="px-4 py-2">
								<a href={`${BASE}/${c._id}`} class="font-medium hover:underline" style="color: var(--color-tron-cyan)">
									{c.title || c.sourceName}
								</a>
							</td>
							<td class="px-4 py-2 font-mono" style="color: var(--color-tron-text-secondary)">{c.sourceName}</td>
							<td class="px-4 py-2">{c.stepCount}</td>
							<td class="px-4 py-2 font-mono" style="color: var(--color-tron-text-secondary)">
								{#if c.savedAs.length}
									{c.savedAs[c.savedAs.length - 1].name}
									{#if c.savedAs.length > 1}<span class="opacity-60"> (+{c.savedAs.length - 1})</span>{/if}
								{:else}
									—
								{/if}
							</td>
							<td class="px-4 py-2" style="color: var(--color-tron-text-secondary)">
								{fmtDate(c.updatedAt)}{#if c.updatedBy} · {c.updatedBy.username}{/if}
							</td>
							<td class="px-4 py-1 text-right">
								<form
									method="POST"
									action="?/archive"
									use:enhance
									onsubmit={(e) => {
										if (!confirm(`Remove the clean-up "${c.title || c.sourceName}" from this list? Recordings on the Pi are not affected.`)) e.preventDefault();
									}}
								>
									<input type="hidden" name="id" value={c._id} />
									<button
										type="submit"
										aria-label="Remove {c.title || c.sourceName}"
										title="Remove from list"
										class="inline-flex h-8 w-8 items-center justify-center rounded transition-colors hover:bg-red-500/15"
										style="color: #ef4444"
									>
										<svg viewBox="0 0 24 24" class="h-4 w-4" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
											<path d="M3 6h18" />
											<path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
											<path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6" />
										</svg>
									</button>
								</form>
							</td>
						</tr>
					{/each}
				</tbody>
			</table>
		{/if}
	</section>
</div>
