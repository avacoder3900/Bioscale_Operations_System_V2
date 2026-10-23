<script lang="ts">
	/**
	 * D415 depth stream mode: 480p (848x480, the historical setting) or 720p
	 * (1280x720, the sensor's full depth resolution), switched at runtime on
	 * the Pi and remembered there.
	 *
	 * Since 2026-10-23 the depth reading IS each tag's distance in every check,
	 * so the depth resolution matters. This panel exists to compare the two
	 * modes on the live Pi: it shows the measured frame rate, the reader
	 * child's CPU and the Pi's temperature side by side so the cost of 720p
	 * can be weighed against steadier readings in Live Tags.
	 *
	 * The depth stream only runs while something samples it (Live Tags, a
	 * home check, a calibration) and stops after a minute idle, so start Live
	 * Tags to see live numbers here.
	 */
	import { onMount } from 'svelte';
	import type { ArmThermal, DepthConfig } from '$lib/server/robot-arm-client';

	interface Props {
		armReachable: boolean;
	}
	let { armReachable }: Props = $props();

	type Resp = (DepthConfig & { installed: true }) | { installed: false; reason: string };

	let cfg = $state<DepthConfig | null>(null);
	let installed = $state(true);
	let notInstalledReason = $state<string | null>(null);
	let error = $state<string | null>(null);
	let busy = $state(false);
	let persist = $state(true);
	let open = $state(false);
	let thermal = $state<ArmThermal | null>(null);

	const POLL_MS = 5000;

	async function load(): Promise<void> {
		try {
			const res = await fetch('/api/robot-arm/depth/config', { cache: 'no-store' });
			if (!res.ok) throw new Error(res.status === 502 ? 'The Pi did not answer for its depth stream.' : `HTTP ${res.status}`);
			const body = (await res.json()) as Resp;
			installed = body.installed;
			if (body.installed) {
				cfg = body;
				error = null;
			} else notInstalledReason = body.reason;
		} catch (e) {
			error = e instanceof Error ? e.message : 'Could not read the depth stream mode';
		}
	}

	async function loadThermal(): Promise<void> {
		try {
			const res = await fetch('/api/robot-arm/thermal', { cache: 'no-store' });
			if (!res.ok) return;
			const body = (await res.json()) as { thermal: ArmThermal | null };
			thermal = body.thermal;
		} catch {
			/* the chip on the camera card already reports failures */
		}
	}

	async function apply(change: { mode?: string; fps?: number }): Promise<void> {
		busy = true;
		error = null;
		try {
			const res = await fetch('/api/robot-arm/depth/config', {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({ ...change, persist })
			});
			const body = (await res.json().catch(() => null)) as (Resp & { message?: string }) | null;
			if (!res.ok) throw new Error(body?.message ?? `HTTP ${res.status}`);
			if (body?.installed) cfg = body;
		} catch (e) {
			error = e instanceof Error ? e.message : 'The Pi did not switch the depth stream';
		} finally {
			busy = false;
		}
	}

	onMount(() => {
		if (!armReachable) return;
		void load();
		const tick = () => {
			if (!open || document.visibilityState !== 'visible') return;
			void load();
			void loadThermal();
		};
		const id = setInterval(tick, POLL_MS);
		return () => clearInterval(id);
	});

	const st = $derived(cfg?.status ?? null);
	const kb = (n: number) => `${Math.round(n / 1024)} KB`;
	const modeLabel = (k: string, wh: [number, number]) => `${k} · ${wh[0]}×${wh[1]}`;
</script>

<section class="rounded border p-3 sm:p-4" style="border-color: var(--color-tron-border); background: var(--color-tron-surface);">
	<details bind:open>
		<summary class="flex cursor-pointer flex-wrap items-center justify-between gap-3">
			<div>
				<h2 class="text-sm font-semibold tracking-wide" style="color: var(--color-tron-text)">DEPTH STREAM</h2>
				<p class="text-xs" style="color: var(--color-tron-text-secondary)">
					D415 depth resolution for the tags' distance.
					{#if cfg}· {cfg.mode} ({cfg.width}×{cfg.height} @ {cfg.fps} fps){cfg.persisted ? ', remembered' : ''}{st?.running ? ` · streaming${st.measured_fps != null ? ` ${st.measured_fps} fps` : ''}` : ' · idle'}{/if}
				</p>
			</div>
			<span class="text-xs" style="color: var(--color-tron-text-secondary)">{open ? 'hide' : 'show'}</span>
		</summary>

		{#if !armReachable}
			<p class="mt-3 text-xs" style="color: var(--color-tron-text-secondary)">The arm Pi is unreachable.</p>
		{:else if !installed}
			<p class="mt-3 text-xs" style="color: #f59e0b">{notInstalledReason}</p>
		{:else if cfg}
			<div class="mt-3 flex flex-wrap items-end gap-4 text-xs">
				<fieldset class="flex items-center gap-3" disabled={busy}>
					<legend class="mb-1" style="color: var(--color-tron-text-secondary)">Resolution</legend>
					{#each Object.entries(cfg.modes) as [k, wh] (k)}
						<label class="flex items-center gap-1 font-mono" style="color: var(--color-tron-text)">
							<input type="radio" name="depth-mode" value={k} checked={cfg.mode === k} onchange={() => void apply({ mode: k })} class="accent-cyan-400" />
							{modeLabel(k, wh as [number, number])}
						</label>
					{/each}
				</fieldset>
				<label class="block" style="color: var(--color-tron-text-secondary)">
					Frame rate
					<select value={String(cfg.fps)} disabled={busy} onchange={(e) => void apply({ fps: Number((e.currentTarget as HTMLSelectElement).value) })} class="ml-1 rounded border bg-black/40 px-1 py-0.5" style="border-color: var(--color-tron-border); color: var(--color-tron-text)">
						{#each cfg.fps_choices as f (f)}<option value={String(f)}>{f} fps</option>{/each}
					</select>
				</label>
				<label class="flex items-center gap-1" style="color: var(--color-tron-text)" title="Save the mode on the Pi ({cfg.file}) so it survives a restart.">
					<input type="checkbox" bind:checked={persist} class="accent-cyan-400" />
					Remember on the Pi
				</label>
				{#if busy}<span style="color: var(--color-tron-text-secondary)">Switching…</span>{/if}
				{#if error}<span class="text-red-300">{error}</span>{/if}
			</div>

			<div class="mt-3 grid gap-x-6 gap-y-1 font-mono text-xs sm:grid-cols-2 lg:grid-cols-4" style="color: var(--color-tron-text)">
				<div><span style="color: var(--color-tron-text-secondary)">stream</span> {st?.running ? 'running' : 'idle'}{st?.device ? ` on ${st.device}` : ''}</div>
				<div><span style="color: var(--color-tron-text-secondary)">measured</span> {st?.measured_fps != null ? `${st.measured_fps} fps` : '—'} <span style="color: var(--color-tron-text-secondary)">of {cfg.fps}</span></div>
				<div><span style="color: var(--color-tron-text-secondary)">reader CPU</span> {st?.child_cpu_pct != null ? `${st.child_cpu_pct} %` : '—'}</div>
				<div><span style="color: var(--color-tron-text-secondary)">frame</span> {st ? kb(st.frame_bytes) : '—'}{st?.last_frame_age_s != null ? `, ${st.last_frame_age_s} s old` : ''}</div>
				<div><span style="color: var(--color-tron-text-secondary)">Pi</span> {thermal?.temp_c != null ? `${thermal.temp_c} °C` : '—'}{thermal?.now?.length ? ` (${thermal.now.join(', ')})` : ''}</div>
				<div><span style="color: var(--color-tron-text-secondary)">service CPU</span> {thermal?.service_cpu_pct != null ? `${thermal.service_cpu_pct} %` : '—'}</div>
				<div><span style="color: var(--color-tron-text-secondary)">frames</span> {st?.frames ?? '—'}</div>
				{#if st?.error}<div class="sm:col-span-2 lg:col-span-4" style="color: #f59e0b">{st.error}</div>{/if}
			</div>
			<p class="mt-2 text-[11px]" style="color: var(--color-tron-text-secondary)">
				The depth stream runs only while something samples it (Live Tags, a check, a calibration) and stops after a minute idle, so start Live Tags to compare modes.
				720p is the sensor's native depth; 480p is decimated from it. 720p costs more USB bandwidth and reader CPU (the numbers above), and should make the D415 distance and the Δdepth column steadier.
				Switching restarts the depth stream (about a second); colour video is unaffected. The colour→depth map was measured at 848x480 and is scaled per axis for 720p.
			</p>
		{:else if error}
			<p class="mt-3 text-xs text-red-300">{error}</p>
		{:else}
			<p class="mt-3 text-xs" style="color: var(--color-tron-text-secondary)">Reading the depth stream mode…</p>
		{/if}
	</details>
</section>
