<script lang="ts">
	/**
	 * Arm camera settings: exposure, gain, white balance and the other UVC
	 * controls of the D415's colour sensor, set from BIMS.
	 *
	 * Every slider's limits, step and default come from the camera itself
	 * (v4l2-ctl on the Pi, through /api/robot-arm/cameras/{name}/controls);
	 * nothing here is a guess. A number box sits beside each slider so an
	 * exact value can be typed; a value the camera refuses (out of range, off
	 * its step, gated by an auto switch) comes back with the camera's reason
	 * under the control rather than being silently rounded.
	 *
	 * "Remember on the Pi" saves the applied values to
	 * calibrations/camera_controls.json on the Pi; cameras.py re-applies
	 * them every time it opens the device, so a replug or a service restart
	 * does not drop back to auto exposure.
	 *
	 * Why fixed settings: on auto, the sensor picks a long shutter under lab
	 * light (motion blur when the arm moves) and a high gain (noise on tag
	 * edges), and both drift frame to frame. Fixing them costs the Pi nothing.
	 *
	 * Presets (robot_arm_camera_presets): named sets of values with the
	 * lighting they were taken under, so a setting that worked under one light
	 * can be found and re-applied. The camera's own defaults are the first one.
	 */
	import type { CameraControl, CameraControlsResponse } from '$lib/server/robot-arm-client';
	import type { PresetSummary } from '$lib/server/robot-arm-camera-presets';

	interface Props {
		camera: string;
		armReachable: boolean;
	}
	let { camera, armReachable }: Props = $props();

	type Resp = CameraControlsResponse & { installed: boolean };

	let resp = $state<Resp | null>(null);
	let loading = $state(false);
	let error = $state<string | null>(null);
	let persist = $state(true);
	let busy = $state<string[]>([]);
	/** Slider/number values while being edited, before the camera confirms them. */
	let drafts = $state<Record<string, number>>({});
	/** The camera's answer per control after a write (a rejection reason, or '✓'). */
	let notes = $state<Record<string, string>>({});
	let open = $state(true);

	let presets = $state<PresetSummary[]>([]);
	let presetId = $state('');
	let presetBusy = $state(false);
	let presetError = $state<string | null>(null);
	let presetMsg = $state<string | null>(null);
	let showSave = $state(false);
	let newName = $state('');
	let newConditions = $state('');
	let newNotes = $state('');

	const GROUPS: { title: string; ids: string[] }[] = [
		{ title: 'Exposure', ids: ['auto_exposure', 'exposure_time_absolute', 'exposure_dynamic_framerate', 'gain'] },
		{ title: 'Colour', ids: ['white_balance_automatic', 'white_balance_temperature', 'saturation', 'hue'] },
		{ title: 'Image', ids: ['brightness', 'contrast', 'gamma', 'sharpness', 'backlight_compensation', 'power_line_frequency'] }
	];
	/** The auto switch that gates a manual control, and the value that frees it. */
	const GATE: Record<string, { by: string; manual: number; label: string }> = {
		exposure_time_absolute: { by: 'auto_exposure', manual: 1, label: 'auto exposure → Manual Mode' },
		white_balance_temperature: { by: 'white_balance_automatic', manual: 0, label: 'auto white balance → off' }
	};

	const controls = $derived(resp?.controls ?? []);
	const byId = $derived(new Map(controls.map((c) => [c.id, c])));
	const grouped = $derived.by(() => {
		const used = new Set<string>();
		const out = GROUPS.map((g) => ({
			title: g.title,
			items: g.ids
				.map((id) => byId.get(id))
				.filter((c): c is CameraControl => {
					if (!c) return false;
					used.add(c.id);
					return true;
				})
		})).filter((g) => g.items.length);
		const rest = controls.filter((c) => !used.has(c.id));
		if (rest.length) out.push({ title: 'Other', items: rest });
		return out;
	});
	const savedCount = $derived(Object.keys(resp?.saved ?? {}).length);
	const selectedPreset = $derived(presets.find((p) => p._id === presetId) ?? null);
	/** Presets whose every value equals the camera's current value. */
	const matchingPresetIds = $derived.by(() => {
		const cur = new Map(controls.map((c) => [c.id, c.value]));
		return new Set(presets.filter((p) => Object.entries(p.values).every(([k, v]) => cur.get(k) === v)).map((p) => p._id));
	});
	const presetLabel = (p: PresetSummary) => `${p.name}${p.conditions ? ` — ${p.conditions}` : ''}${p.kind === 'camera-default' ? ' (camera defaults)' : ''}`;
	const changedFromDefault = $derived(controls.filter((c) => c.value != null && c.default != null && c.value !== c.default).length);

	const url = () => `/api/robot-arm/cameras/${encodeURIComponent(camera)}/controls`;
	const presetsUrl = () => `/api/robot-arm/cameras/${encodeURIComponent(camera)}/presets`;

	async function loadPresets(): Promise<void> {
		if (!camera) return;
		try {
			const res = await fetch(presetsUrl(), { cache: 'no-store' });
			if (!res.ok) throw new Error(`HTTP ${res.status}`);
			presets = ((await res.json()) as { presets: PresetSummary[] }).presets;
			if (!presets.some((p) => p._id === presetId)) presetId = presets[0]?._id ?? '';
			presetError = null;
		} catch (e) {
			presetError = e instanceof Error ? e.message : 'Could not read the presets';
		}
	}

	async function presetPost(body: Record<string, unknown>): Promise<{ preset?: PresetSummary; result?: CameraControlsResponse } | null> {
		presetBusy = true;
		presetError = null;
		presetMsg = null;
		try {
			const res = await fetch(presetsUrl(), { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
			const data = (await res.json().catch(() => null)) as { preset?: PresetSummary; result?: CameraControlsResponse; message?: string } | null;
			if (!res.ok) throw new Error(data?.message ?? `HTTP ${res.status}`);
			return data;
		} catch (e) {
			presetError = e instanceof Error ? e.message : 'Preset action failed';
			return null;
		} finally {
			presetBusy = false;
		}
	}

	async function applyPreset(): Promise<void> {
		const p = selectedPreset;
		if (!p) return;
		const data = await presetPost({ apply: p._id });
		if (!data) return;
		const rejected = Object.entries(data.result?.rejected ?? {});
		presetMsg = rejected.length ? `Applied "${p.name}"; the camera refused ${rejected.map(([k, why]) => `${k} (${why})`).join(', ')}` : `Applied "${p.name}"`;
		await load();
		await loadPresets();
	}

	async function savePreset(): Promise<void> {
		const data = await presetPost({ save: { name: newName, conditions: newConditions || null, notes: newNotes || null } });
		if (!data?.preset) return;
		presetMsg = `Saved "${data.preset.name}" with the camera's current ${Object.keys(data.preset.values).length} values`;
		showSave = false;
		newName = '';
		newConditions = '';
		newNotes = '';
		await loadPresets();
		presetId = data.preset._id;
	}

	async function archivePreset(): Promise<void> {
		const p = selectedPreset;
		if (!p || !confirm(`Archive the preset "${p.name}"? It stays in the history and can be restored.`)) return;
		const data = await presetPost({ archive: p._id });
		if (data) {
			presetMsg = `Archived "${p.name}"`;
			await loadPresets();
		}
	}

	async function load(): Promise<void> {
		if (!camera) return;
		loading = true;
		error = null;
		try {
			const res = await fetch(url(), { cache: 'no-store' });
			if (!res.ok) throw new Error(res.status === 502 ? 'The Pi did not answer for its camera controls.' : `HTTP ${res.status}`);
			resp = (await res.json()) as Resp;
			drafts = {};
			if (resp.installed && !resp.available) error = resp.reason ?? 'The camera reported no controls.';
		} catch (e) {
			error = e instanceof Error ? e.message : 'Could not read the camera controls';
		} finally {
			loading = false;
		}
	}

	async function send(set: Record<string, number>): Promise<void> {
		const names = Object.keys(set);
		busy = [...busy, ...names];
		error = null;
		try {
			const res = await fetch(url(), {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({ set, persist })
			});
			const body = (await res.json().catch(() => null)) as (Resp & { message?: string }) | null;
			if (!res.ok) throw new Error(body?.message ?? `HTTP ${res.status}`);
			if (!body) throw new Error('Empty answer');
			resp = body;
			const next = { ...notes };
			for (const n of names) {
				delete drafts[n];
				if (body.rejected && n in body.rejected) next[n] = body.rejected[n];
				else if (body.applied?.includes(n)) next[n] = '✓';
				else delete next[n];
			}
			notes = next;
		} catch (e) {
			error = e instanceof Error ? e.message : 'The camera did not take the change';
		} finally {
			busy = busy.filter((n) => !names.includes(n));
		}
	}

	async function resetAll(): Promise<void> {
		if (!confirm('Put every camera control back to the camera\'s own default (auto exposure, auto white balance, …) and forget the saved set on the Pi?')) return;
		busy = controls.map((c) => c.id);
		error = null;
		try {
			const res = await fetch(url(), {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({ reset: true, persist })
			});
			const body = (await res.json().catch(() => null)) as (Resp & { message?: string }) | null;
			if (!res.ok) throw new Error(body?.message ?? `HTTP ${res.status}`);
			if (body) resp = body;
			drafts = {};
			notes = {};
		} catch (e) {
			error = e instanceof Error ? e.message : 'Reset failed';
		} finally {
			busy = [];
		}
	}

	const valueOf = (c: CameraControl): number => drafts[c.id] ?? c.value ?? c.default ?? c.min ?? 0;
	const inactive = (c: CameraControl): boolean => c.flags.includes('inactive');
	const isBusy = (c: CameraControl): boolean => busy.includes(c.id);
	const label = (c: CameraControl): string => c.id.replace(/_/g, ' ');
	/** The raw value in the unit a person thinks in. */
	function human(c: CameraControl, v: number): string {
		if (c.id === 'exposure_time_absolute') return `${(v / 10).toFixed(1)} ms` + (v > 0 ? ` (1/${Math.round(10000 / v)} s)` : '');
		if (c.id === 'gamma') return `γ ${(v / 100).toFixed(2)}`;
		if (c.unit === 'K') return `${v} K`;
		if (c.unit === 'deg') return `${v}°`;
		return c.unit ? `${v} ${c.unit}` : String(v);
	}
	function onRangeInput(c: CameraControl, e: Event) {
		drafts[c.id] = Number((e.currentTarget as HTMLInputElement).value);
	}
	function onNumberInput(c: CameraControl, e: Event) {
		const raw = (e.currentTarget as HTMLInputElement).value;
		if (raw.trim() === '') return;
		drafts[c.id] = Number(raw);
	}
	function commit(c: CameraControl) {
		const v = drafts[c.id];
		if (v == null || !Number.isFinite(v)) return;
		if (v === c.value) {
			delete drafts[c.id];
			return;
		}
		void send({ [c.id]: v });
	}
	function makeManual(c: CameraControl) {
		const g = GATE[c.id];
		if (!g) return;
		void send({ [g.by]: g.manual, [c.id]: valueOf(c) });
	}

	$effect(() => {
		void camera;
		resp = null;
		drafts = {};
		notes = {};
		if (armReachable && camera) void load();
		if (camera) void loadPresets();
	});
</script>

<section class="rounded border p-3 sm:p-4" style="border-color: var(--color-tron-border); background: var(--color-tron-surface);">
	<details bind:open>
		<summary class="flex cursor-pointer flex-wrap items-center justify-between gap-3">
			<div>
				<h2 class="text-sm font-semibold tracking-wide" style="color: var(--color-tron-text)">CAMERA SETTINGS</h2>
				<p class="text-xs" style="color: var(--color-tron-text-secondary)">
					Exposure, gain and white balance of the arm camera. Limits are the camera's own.
					{#if resp?.available}
						· {resp.device}{changedFromDefault ? ` · ${changedFromDefault} off default` : ' · all at default'}{savedCount ? ` · ${savedCount} remembered on the Pi` : ''}
					{/if}
				</p>
			</div>
			<span class="text-xs" style="color: var(--color-tron-text-secondary)">{open ? 'hide' : 'show'}</span>
		</summary>

		{#if !armReachable}
			<p class="mt-3 text-xs" style="color: var(--color-tron-text-secondary)">The arm Pi is unreachable; the camera settings cannot be read.</p>
		{:else if resp && !resp.installed}
			<p class="mt-3 text-xs" style="color: #f59e0b">{resp.reason}</p>
		{:else}
			<div class="mt-3 flex flex-wrap items-center gap-3 text-xs">
				<label class="flex items-center gap-1" style="color: var(--color-tron-text)" title="Save every applied value on the Pi (calibrations/camera_controls.json). cameras.py re-applies the set each time it opens the camera, so a replug or restart keeps your settings.">
					<input type="checkbox" bind:checked={persist} class="accent-cyan-400" />
					Remember on the Pi
				</label>
				<button type="button" onclick={() => void load()} disabled={loading} class="min-h-[34px] rounded px-3 font-semibold disabled:opacity-40" style="color: var(--color-tron-cyan); border: 1px solid var(--color-tron-cyan);">
					{loading ? 'Reading…' : 'Re-read from camera'}
				</button>
				<button type="button" onclick={() => void resetAll()} disabled={!resp?.available || busy.length > 0} class="min-h-[34px] rounded px-3 font-semibold disabled:opacity-40" style="color: #fca5a5; border: 1px solid #ef4444;" title="Every control back to the camera's default; the saved set on the Pi is cleared when Remember is on.">
					Reset all to camera defaults
				</button>
				{#if error}<span class="text-red-300">{error}</span>{/if}
			</div>

			<div class="mt-3 rounded border p-2 text-xs" style="border-color: var(--color-tron-border); background: rgba(0,0,0,0.15);">
				<div class="flex flex-wrap items-center gap-2">
					<span class="font-medium" style="color: var(--color-tron-text)">Presets</span>
					<select bind:value={presetId} disabled={presetBusy || !presets.length} class="min-w-[16rem] max-w-full rounded border bg-black/40 px-2 py-1 disabled:opacity-40" style="border-color: var(--color-tron-border); color: var(--color-tron-text)" aria-label="Camera preset">
						{#if !presets.length}<option value="">No presets saved yet</option>{/if}
						{#each presets as p (p._id)}
							<option value={p._id}>{presetLabel(p)}{matchingPresetIds.has(p._id) ? ' ✓' : ''}</option>
						{/each}
					</select>
					<button type="button" onclick={() => void applyPreset()} disabled={presetBusy || !selectedPreset || !resp?.available} class="min-h-[34px] rounded px-3 font-semibold disabled:opacity-40" style="color: var(--color-tron-cyan); border: 1px solid var(--color-tron-cyan);" title={selectedPreset ? `Write ${Object.keys(selectedPreset.values).length} values to the camera and remember them on the Pi` : ''}>
						Apply
					</button>
					<button type="button" onclick={() => (showSave = !showSave)} disabled={presetBusy || !resp?.available} class="min-h-[34px] rounded px-3 font-semibold disabled:opacity-40" style="color: var(--color-tron-text); border: 1px solid var(--color-tron-border);">
						{showSave ? 'Cancel' : 'Save current as…'}
					</button>
					{#if selectedPreset}
						<button type="button" onclick={() => void archivePreset()} disabled={presetBusy} class="min-h-[34px] rounded px-2 disabled:opacity-40" style="color: var(--color-tron-text-secondary); border: 1px solid var(--color-tron-border);" title="Archive this preset (kept in history)">Archive</button>
					{/if}
					{#if presetBusy}<span style="color: var(--color-tron-text-secondary)">Working…</span>{/if}
					{#if presetMsg}<span style="color: #4ade80">{presetMsg}</span>{/if}
					{#if presetError}<span class="text-red-300">{presetError}</span>{/if}
				</div>
				{#if selectedPreset}
					<p class="mt-1" style="color: var(--color-tron-text-secondary)">
						{#if matchingPresetIds.has(selectedPreset._id)}The camera is on these values now.{:else}Differs from the camera now: {Object.entries(selectedPreset.values).filter(([k, v]) => byId.get(k)?.value !== v).map(([k, v]) => `${k.replace(/_/g, ' ')} ${byId.get(k)?.value ?? '?'} → ${v}`).join(', ') || '—'}.{/if}
						{#if selectedPreset.notes} {selectedPreset.notes}{/if}
						Saved {selectedPreset.createdAt ? new Date(selectedPreset.createdAt).toLocaleDateString() : ''}{selectedPreset.createdBy?.username ? ` by ${selectedPreset.createdBy.username}` : ''}{selectedPreset.lastAppliedAt ? `; last applied ${new Date(selectedPreset.lastAppliedAt).toLocaleString()}` : ''}.
					</p>
				{/if}
				{#if showSave}
					<form class="mt-2 flex flex-wrap items-end gap-2" onsubmit={(e) => { e.preventDefault(); void savePreset(); }}>
						<label class="block" style="color: var(--color-tron-text-secondary)">
							Name
							<input bind:value={newName} required maxlength="120" placeholder="e.g. Blinds open, manual 8 ms" class="mt-1 block w-64 rounded border bg-black/40 px-2 py-1" style="border-color: var(--color-tron-border); color: var(--color-tron-text)" />
						</label>
						<label class="block" style="color: var(--color-tron-text-secondary)">
							Lighting / conditions
							<input bind:value={newConditions} maxlength="500" placeholder="e.g. Shared office, blinds open, afternoon" class="mt-1 block w-72 rounded border bg-black/40 px-2 py-1" style="border-color: var(--color-tron-border); color: var(--color-tron-text)" />
						</label>
						<label class="block" style="color: var(--color-tron-text-secondary)">
							Notes
							<input bind:value={newNotes} maxlength="500" class="mt-1 block w-56 rounded border bg-black/40 px-2 py-1" style="border-color: var(--color-tron-border); color: var(--color-tron-text)" />
						</label>
						<button type="submit" disabled={presetBusy || !newName.trim()} class="min-h-[34px] rounded px-3 font-semibold disabled:opacity-40" style="color: #4ade80; border: 1px solid #4ade80;">Save the camera's current values</button>
					</form>
				{/if}
			</div>

			{#if resp?.available}
				<div class="mt-3 grid gap-4 lg:grid-cols-2 xl:grid-cols-3">
					{#each grouped as g (g.title)}
						<div class="rounded border p-3" style="border-color: var(--color-tron-border); background: rgba(0,0,0,0.2);">
							<h3 class="mb-2 text-xs font-semibold uppercase tracking-wide" style="color: var(--color-tron-text-secondary)">{g.title}</h3>
							<div class="space-y-3">
								{#each g.items as c (c.id)}
									{@const off = inactive(c)}
									{@const gate = GATE[c.id]}
									{@const v = valueOf(c)}
									<div class="text-xs" title={c.hint}>
										<div class="flex items-center justify-between gap-2">
											<span class="font-medium" style="color: {off ? 'var(--color-tron-text-secondary)' : 'var(--color-tron-text)'}">
												{label(c)}
												{#if resp.saved && c.id in resp.saved}<span class="ml-1 text-[10px]" style="color: var(--color-tron-cyan)" title="Remembered on the Pi (value {resp.saved[c.id]})">saved</span>{/if}
											</span>
											<span class="flex items-center gap-2 font-mono" style="color: var(--color-tron-text-secondary)">
												{#if c.type === 'int'}{human(c, v)}{/if}
												{#if c.default != null && c.value !== c.default}
													<button type="button" onclick={() => void send({ [c.id]: c.default! })} disabled={off || isBusy(c)} class="rounded px-1 disabled:opacity-40" style="border: 1px solid var(--color-tron-border); color: var(--color-tron-text-secondary)" title="Back to the camera default ({c.default})">↺ {c.default}</button>
												{/if}
												{#if notes[c.id]}<span style="color: {notes[c.id] === '✓' ? '#4ade80' : '#f59e0b'}">{notes[c.id]}</span>{/if}
											</span>
										</div>

										{#if c.type === 'int'}
											<div class="mt-1 flex items-center gap-2">
												<input
													type="range"
													min={c.min ?? 0}
													max={c.max ?? 100}
													step={c.step ?? 1}
													value={v}
													disabled={off || isBusy(c)}
													oninput={(e) => onRangeInput(c, e)}
													onchange={() => commit(c)}
													class="w-full accent-cyan-400 disabled:opacity-40"
													aria-label={label(c)}
												/>
												<input
													type="number"
													min={c.min ?? undefined}
													max={c.max ?? undefined}
													step={c.step ?? 1}
													value={v}
													disabled={off || isBusy(c)}
													oninput={(e) => onNumberInput(c, e)}
													onchange={() => commit(c)}
													onkeydown={(e) => {
														if (e.key === 'Enter') (e.currentTarget as HTMLInputElement).blur();
													}}
													class="w-24 rounded border bg-black/40 px-2 py-1 text-right font-mono disabled:opacity-40"
													style="border-color: var(--color-tron-border); color: var(--color-tron-text)"
													aria-label="{label(c)} value"
												/>
											</div>
											<div class="mt-0.5 flex justify-between font-mono text-[10px]" style="color: var(--color-tron-text-secondary)">
												<span>{c.min}</span>
												<span>step {c.step ?? 1}{c.unit ? ` · ${c.unit}` : ''}</span>
												<span>{c.max}</span>
											</div>
										{:else if c.type === 'menu'}
											<select
												value={String(v)}
												disabled={off || isBusy(c)}
												onchange={(e) => void send({ [c.id]: Number((e.currentTarget as HTMLSelectElement).value) })}
												class="mt-1 w-full rounded border bg-black/40 px-2 py-1 disabled:opacity-40"
												style="border-color: var(--color-tron-border); color: var(--color-tron-text)"
												aria-label={label(c)}
											>
												{#each Object.entries(c.menu ?? {}) as [k, text] (k)}
													<option value={k}>{k}: {text}{c.default != null && Number(k) === c.default ? ' (default)' : ''}</option>
												{/each}
											</select>
										{:else}
											<label class="mt-1 flex items-center gap-2" style="color: var(--color-tron-text)">
												<input
													type="checkbox"
													checked={v === 1}
													disabled={off || isBusy(c)}
													onchange={(e) => void send({ [c.id]: (e.currentTarget as HTMLInputElement).checked ? 1 : 0 })}
													class="accent-cyan-400 disabled:opacity-40"
												/>
												{v === 1 ? 'on' : 'off'}{c.default != null ? ` (default ${c.default === 1 ? 'on' : 'off'})` : ''}
											</label>
										{/if}

										{#if off}
											<p class="mt-1 flex flex-wrap items-center gap-2" style="color: #f59e0b">
												<span>Inactive: the camera is setting this automatically.</span>
												{#if gate}
													<button type="button" onclick={() => makeManual(c)} disabled={isBusy(c)} class="rounded px-2 py-0.5 font-semibold disabled:opacity-40" style="border: 1px solid #f59e0b; color: #f59e0b">Take manual control ({gate.label})</button>
												{/if}
											</p>
										{/if}
									</div>
								{/each}
							</div>
						</div>
					{/each}
				</div>
				<p class="mt-3 text-[11px]" style="color: var(--color-tron-text-secondary)">
					Ranges, steps and defaults are read from the camera (v4l2) each time; a value the camera refuses shows its reason beside the control instead of being rounded.
					Exposure is in units of 100 µs (166 = 16.6 ms = 1/60 s). Sharpness above the default adds ringing that hurts sub-pixel tag corners.
					Detection reads only luma, so saturation and hue change the picture, not the measurement.
					{#if resp.saved_file}Saved set: <span class="font-mono">{resp.saved_file}</span> on the Pi.{/if}
				</p>
			{:else if loading}
				<p class="mt-3 text-xs" style="color: var(--color-tron-text-secondary)">Reading the camera's controls…</p>
			{/if}
		{/if}
	</details>
</section>
