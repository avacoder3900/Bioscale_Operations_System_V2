<script lang="ts">
	/**
	 * ARM-05 — calibrate. With the arm parked at home: detect, register any
	 * tag the camera sees that is not in the registry yet (right here, by its
	 * ID), then save. Saving runs one fresh detection on the server and stores
	 * every registered tag's pose plus the arm's encoder steps.
	 */
	import { enhance } from '$app/forms';
	import VisionStage, { type StageTag } from './VisionStage.svelte';
	import { minTagSizeMm, sheetSizeMm, DEFAULT_TOLERANCES, type TagDetection } from '$lib/robot-arm/apriltags';
	import { fetchDetections, type LiveDetection } from '$lib/robot-arm/detect-client';
	import type { CalibrationSummary, TagSummary } from '$lib/server/robot-arm-vision';

	interface Props {
		camera: string;
		tags: TagSummary[];
		calibration: CalibrationSummary | null;
		blocked: boolean;
		blockReason: string;
	}

	let { camera, tags, calibration, blocked, blockReason }: Props = $props();

	let det = $state<LiveDetection | null>(null);
	let detecting = $state(false);
	let detectError = $state<string | null>(null);
	let saving = $state(false);
	let registering = $state<number | null>(null);

	const byTagId = $derived(new Map(tags.filter((t) => !t.archived).map((t) => [t.tagId, t])));
	const seenIds = $derived(new Set((det?.tags ?? []).map((t) => t.id)));
	const notSeen = $derived([...byTagId.values()].filter((t) => det && !seenIds.has(t.tagId)));
	const fx = $derived(det?.intrinsics?.fx ?? 615);

	const stageTags = $derived<StageTag[]>(
		(det?.tags ?? []).map((d) => {
			const reg = byTagId.get(d.id);
			return {
				key: String(d.id),
				label: reg ? `${reg.name} #${d.id}` : `#${d.id} (new)`,
				corners: d.corners,
				center: d.center,
				status: reg ? 'registered' : 'unregistered'
			};
		})
	);

	$effect(() => {
		void camera;
		det = null;
	});

	async function detect() {
		if (!camera) return;
		detecting = true;
		detectError = null;
		try {
			det = await fetchDetections(camera);
			if (!det.available) detectError = det.reason ?? 'The Pi could not detect tags.';
		} catch (e) {
			detectError = e instanceof Error ? e.message : 'Detection failed';
		} finally {
			detecting = false;
		}
	}

	/** Too small to decode reliably at this distance (≈3 px per cell)? */
	function tooSmall(d: TagDetection): boolean {
		const z = d.pose?.t[2];
		const size = byTagId.get(d.id)?.sizeMm ?? d.sizeMm;
		return !!z && !!size && size < minTagSizeMm(z, fx);
	}

	const input = 'mt-1 w-full rounded border bg-black/40 px-2 py-1 text-sm';
	const inputStyle = 'border-color: var(--color-tron-border); color: var(--color-tron-text)';
</script>

<section class="rounded border p-3 sm:p-4" style="border-color: var(--color-tron-border); background: var(--color-tron-surface);">
	<div class="flex flex-wrap items-start justify-between gap-3">
		<div>
			<h2 class="text-sm font-semibold tracking-wide" style="color: var(--color-tron-text)">CALIBRATE</h2>
			<p class="max-w-2xl text-xs" style="color: var(--color-tron-text-secondary)">
				Park the arm at home first. Detect, register any new tag the camera finds, then save — that frame becomes home.
				Recalibrate whenever a tag is moved or added. A bumped camera does not need a recalibration if fixed tags are in view.
			</p>
		</div>
		<button
			type="button"
			onclick={detect}
			disabled={!camera || detecting}
			class="min-h-[40px] rounded px-4 text-sm font-semibold disabled:cursor-not-allowed disabled:opacity-40"
			style="background: rgba(56,189,248,0.15); color: var(--color-tron-cyan); border: 1px solid var(--color-tron-cyan);"
		>
			{detecting ? 'Detecting…' : det ? 'Detect again' : 'Detect tags'}
		</button>
	</div>

	{#if detectError}<p class="mt-2 text-xs text-red-300">{detectError}</p>{/if}

	{#if det?.available}
		<div class="mt-3 grid gap-4 lg:grid-cols-[minmax(0,3fr)_minmax(0,2fr)]">
			<VisionStage src={det.frame} width={det.width} height={det.height} tags={stageTags} alt="Detected tags" />
			<div class="space-y-2 text-xs">
				<p style="color: var(--color-tron-text-secondary)">
					{det.tags.length} tag(s) in view · {det.width}×{det.height}
					· intrinsics: {det.intrinsics?.source ?? '—'}{det.intrinsics?.source === 'nominal' ? ' (approximate mm)' : ''}
					{#if det.detector}· {det.detector}{/if}
				</p>
				{#if !det.tags.length}
					<p style="color: #f59e0b">No tags found. Check the lighting, that tags face the camera, and that they are large enough for their distance.</p>
				{/if}
				<ul class="space-y-1">
					{#each det.tags as d (d.id)}
						{@const reg = byTagId.get(d.id)}
						<li class="rounded border px-2 py-1.5" style="border-color: var(--color-tron-border)">
							<div class="flex flex-wrap items-center gap-2">
								<span class="font-mono" style="color: var(--color-tron-text)">#{d.id}</span>
								{#if reg}
									<span style="color: var(--color-tron-cyan)">{reg.name}</span>
									<span class="text-[10px] uppercase" style="color: var(--color-tron-text-secondary)">{reg.role} · {reg.sizeMm} mm</span>
								{:else}
									<span style="color: #f59e0b">not registered</span>
								{/if}
								<span class="grow"></span>
								<span class="font-mono" style="color: var(--color-tron-text-secondary)">{d.pose ? `${Math.round(d.pose.t[2])} mm away` : 'no pose'}</span>
								{#if !reg}
									<button type="button" class="underline" style="color: var(--color-tron-cyan)" onclick={() => (registering = registering === d.id ? null : d.id)}>register</button>
								{/if}
							</div>
							{#if tooSmall(d)}
								<p class="mt-0.5" style="color: #f59e0b">Small for this distance — may drop out. Use a bigger tag here, or move it closer.</p>
							{/if}
							{#if registering === d.id && !reg}
								<form
									method="POST"
									action="?/createTag"
									use:enhance={() => async ({ update }) => {
										await update({ reset: false });
										registering = null;
									}}
									class="mt-2 grid gap-2 sm:grid-cols-2"
								>
									<input type="hidden" name="tagId" value={d.id} />
									<label class="block" style="color: var(--color-tron-text-secondary)">
										Name (where it is)
										<input name="name" required maxlength="60" placeholder="e.g. Wrist" class={input} style={inputStyle} />
									</label>
									<label class="block" style="color: var(--color-tron-text-secondary)">
										On
										<select name="role" required class={input} style={inputStyle}>
											<option value="arm">the arm</option>
											<option value="fixed">something fixed (deck, Opentron…)</option>
										</select>
									</label>
									<label class="block" style="color: var(--color-tron-text-secondary)">
										Size mm (black square)
										<input name="sizeMm" type="number" step="0.1" min="1" max="500" value={sheetSizeMm(d.id) ?? ''} required class={input} style={inputStyle} />
									</label>
									<label class="block" style="color: var(--color-tron-text-secondary)">
										Group (optional)
										<input name="group" list="arm-tag-groups" maxlength="40" class={input} style={inputStyle} />
									</label>
									<div class="sm:col-span-2">
										<button type="submit" class="min-h-[32px] rounded px-3 text-xs font-semibold" style="color: #4ade80; border: 1px solid #4ade80;">Register tag {d.id}</button>
									</div>
								</form>
							{/if}
						</li>
					{/each}
				</ul>
				{#if notSeen.length}
					<p style="color: #f59e0b">Registered but not in view: {notSeen.map((t) => `${t.name} #${t.tagId}`).join(', ')}.</p>
				{/if}
			</div>
		</div>
	{/if}

	<form
		method="POST"
		action="?/saveCalibration"
		use:enhance={() => {
			saving = true;
			return async ({ update }) => {
				await update({ reset: false });
				saving = false;
			};
		}}
		onsubmit={(e) => {
			if (calibration && !confirm('Replace the current calibration for this camera? Make sure the arm is parked at home.')) e.preventDefault();
		}}
		class="mt-4 flex flex-wrap items-end gap-3"
	>
		<input type="hidden" name="camera" value={camera} />
		<label class="block text-xs" style="color: var(--color-tron-text-secondary)">
			Position tolerance (mm)
			<input name="positionMm" type="number" step="0.5" min="0.5" max="100" value={calibration?.tolerances.positionMm ?? DEFAULT_TOLERANCES.positionMm} class="{input} w-28" style={inputStyle} />
		</label>
		<label class="block text-xs" style="color: var(--color-tron-text-secondary)">
			Angle tolerance (°, 0 = off)
			<input name="angleDeg" type="number" step="0.5" min="0" max="90" value={calibration?.tolerances.angleDeg ?? DEFAULT_TOLERANCES.angleDeg} class="{input} w-28" style={inputStyle} />
		</label>
		<label class="block min-w-[12rem] flex-1 text-xs" style="color: var(--color-tron-text-secondary)">
			Note (optional)
			<input name="note" maxlength="200" placeholder="what changed" class={input} style={inputStyle} />
		</label>
		<button
			type="submit"
			disabled={blocked || saving || !camera || !byTagId.size}
			class="min-h-[40px] rounded px-4 text-sm font-semibold disabled:cursor-not-allowed disabled:opacity-40"
			style="background: rgba(74,222,128,0.12); color: #4ade80; border: 1px solid #4ade80;"
			title={byTagId.size ? 'Detect once more on the server and save every registered tag in view as home' : 'Register tags first'}
		>
			{saving ? 'Saving…' : 'Save calibration (arm is at home)'}
		</button>
		{#if blocked}<span class="text-xs" style="color: #f59e0b">{blockReason}</span>{/if}
	</form>
</section>
