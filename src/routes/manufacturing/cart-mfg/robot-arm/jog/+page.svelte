<script lang="ts">
	import { enhance } from '$app/forms';
	import { invalidate } from '$app/navigation';

	// Must match ARM_POSE_DEP in ./+page.server.ts. Repeated as a literal
	// because a +page.server.ts module cannot be imported into client code.
	const ARM_POSE_DEP = 'arm:pose';

	let { data, form } = $props();

	// Step size the operator picks — applies to every directional button.
	let stepMm = $state(5);
	// Per-joint step delta cap for IK safety; rarely needs tweaking.
	let maxStepDelta = $state(80);
	// Step size for per-joint single-step jog. 1 step ≈ 0.088° ≈ 0.3 mm at the tip.
	let jointStep = $state(1);
	// Auto-refresh pose every 2 s so the operator sees live drift / movement.
	let polling = $state(true);
	let pollHandle: ReturnType<typeof setInterval> | null = null;

	$effect(() => {
		if (polling) {
			// Scoped, not invalidateAll(): this only re-runs the load that declared
			// ARM_POSE_DEP, so the pose refreshes without dragging the arm layout's
			// camera-list and preflight calls to the Pi along with it every 2s.
			pollHandle = setInterval(() => invalidate(ARM_POSE_DEP), 2000);
		} else if (pollHandle) {
			clearInterval(pollHandle);
			pollHandle = null;
		}
		return () => {
			if (pollHandle) clearInterval(pollHandle);
		};
	});

	const pose = $derived(data.pose);
	const sessionActive = $derived(!!data.active);

	function jogPayload(dx: number, dy: number, dz: number) {
		return {
			dx_mm: String(dx * stepMm),
			dy_mm: String(dy * stepMm),
			dz_mm: String(dz * stepMm),
			max_step_delta: String(maxStepDelta)
		};
	}
</script>

<div class="mx-auto max-w-3xl space-y-5 p-4">
	<div class="flex items-center justify-between">
		<h1 class="text-2xl font-bold" style="color: var(--color-tron-cyan)">
			Robot Arm — Cartesian Jog
		</h1>
		<a
			href="/manufacturing/cart-mfg/robot-arm/control"
			class="text-xs transition-colors hover:text-[var(--color-tron-cyan)]"
			style="color: var(--color-tron-text-secondary)"
		>
			← control
		</a>
	</div>

	{#if data.poseError}
		<div class="rounded border border-amber-500/40 bg-amber-900/10 p-3 text-sm">
			<p class="font-medium text-amber-400">Cartesian pose unavailable</p>
			<p class="mt-1 text-xs" style="color: var(--color-tron-text-secondary)">{data.poseError}</p>
			<p class="mt-1 text-xs" style="color: var(--color-tron-text-secondary)">
				The Cartesian pad above needs the IK stack (ikpy + URDF + jog calibration), which is not
				ported to the Pi server yet. <strong>Per-joint jog and torque below still work</strong> —
				use those for movement tests. If the arm server is simply down, check that the robot-arm
				service is running on arm-pi and that ROBOT_ARM_BASE_URL points at it.
			</p>
		</div>
	{:else if sessionActive}
		<div class="rounded border border-yellow-500/40 bg-yellow-900/10 p-3 text-sm">
			<p style="color: var(--color-tron-text)">
				<span class="font-medium text-yellow-400">{data.active?.kind}</span> session active —
				jog disabled until it stops. <a href="/manufacturing/cart-mfg/robot-arm/control" class="ml-2 underline" style="color: var(--color-tron-cyan)">go stop it →</a>
			</p>
		</div>
	{/if}

	<!-- Form result -->
	{#if form?.success}
		<div class="rounded border border-green-500/40 bg-green-900/10 p-3 text-sm text-green-300">
			{form.success}
		</div>
	{:else if form?.error}
		<div class="rounded border border-red-500/40 bg-red-900/10 p-3 text-sm text-red-300">
			{form.error}
		</div>
	{/if}

	<!-- Live pose -->
	{#if pose}
		<section
			class="rounded-lg border border-[var(--color-tron-border)] bg-[var(--color-tron-surface)] p-4"
		>
			<div class="mb-2 flex items-center justify-between">
				<h2 class="text-sm font-bold uppercase tracking-wider" style="color: var(--color-tron-text-secondary)">
					End-effector pose
				</h2>
				<label class="flex items-center gap-2 text-xs" style="color: var(--color-tron-text-secondary)">
					<input type="checkbox" bind:checked={polling} class="accent-cyan-400" />
					auto-refresh (2 s)
				</label>
			</div>
			<div class="grid grid-cols-3 gap-3 font-mono text-sm" style="color: var(--color-tron-text)">
				<div><span class="text-cyan-400">X</span> {pose.x_mm.toFixed(2)} mm</div>
				<div><span class="text-cyan-400">Y</span> {pose.y_mm.toFixed(2)} mm</div>
				<div><span class="text-cyan-400">Z</span> {pose.z_mm.toFixed(2)} mm</div>
			</div>
			<div class="mt-3 grid grid-cols-5 gap-2 text-xs" style="color: var(--color-tron-text-secondary)">
				{#each Object.entries(pose.joint_angles_deg) as [sid, deg] (sid)}
					<div class="rounded bg-black/30 px-2 py-1">
						<span class="text-cyan-400">J{sid}</span> {deg.toFixed(1)}°
						<span class="ml-1 text-[10px] opacity-60">({pose.joint_steps[sid]})</span>
					</div>
				{/each}
			</div>
			<p class="mt-2 text-[11px]" style="color: var(--color-tron-text-secondary)">
				calibration: {pose.calibration_source}
			</p>
		</section>
	{/if}

	<!-- Jog controls -->
	<section
		class="rounded-lg border border-[var(--color-tron-border)] bg-[var(--color-tron-surface)] p-4"
	>
		<h2 class="mb-3 text-sm font-bold uppercase tracking-wider" style="color: var(--color-tron-text-secondary)">
			Jog
		</h2>

		<div class="mb-3 grid grid-cols-2 gap-3 text-xs" style="color: var(--color-tron-text-secondary)">
			<label class="block">
				Step (mm)
				<input
					type="number"
					bind:value={stepMm}
					min="0.1"
					max="50"
					step="0.5"
					class="mt-1 w-full rounded border border-[var(--color-tron-border)] bg-black/40 px-2 py-1 text-sm"
					style="color: var(--color-tron-text)"
				/>
			</label>
			<label class="block">
				Max per-joint Δ (steps, IK safety)
				<input
					type="number"
					bind:value={maxStepDelta}
					min="1"
					max="500"
					class="mt-1 w-full rounded border border-[var(--color-tron-border)] bg-black/40 px-2 py-1 text-sm"
					style="color: var(--color-tron-text)"
				/>
			</label>
		</div>

		<div class="grid grid-cols-3 gap-2 text-sm">
			<!-- row 1: +Y forward / +Z up / +X right -->
			{#each [
				{ label: 'Y +', payload: jogPayload(0, 1, 0), help: 'forward' },
				{ label: 'Z +', payload: jogPayload(0, 0, 1), help: 'up' },
				{ label: 'X +', payload: jogPayload(1, 0, 0), help: 'right' },
				{ label: 'Y −', payload: jogPayload(0, -1, 0), help: 'back' },
				{ label: 'Z −', payload: jogPayload(0, 0, -1), help: 'down' },
				{ label: 'X −', payload: jogPayload(-1, 0, 0), help: 'left' }
			] as btn (btn.label)}
				<form method="POST" action="?/jog" use:enhance>
					<input type="hidden" name="dx_mm" value={btn.payload.dx_mm} />
					<input type="hidden" name="dy_mm" value={btn.payload.dy_mm} />
					<input type="hidden" name="dz_mm" value={btn.payload.dz_mm} />
					<input type="hidden" name="max_step_delta" value={btn.payload.max_step_delta} />
					<button
						type="submit"
						disabled={sessionActive || !pose}
						class="w-full rounded border border-[var(--color-tron-cyan)]/50 bg-[var(--color-tron-cyan)]/10 px-3 py-3 font-mono font-medium transition-colors hover:bg-[var(--color-tron-cyan)]/20 disabled:cursor-not-allowed disabled:opacity-40"
						style="color: var(--color-tron-cyan)"
					>
						{btn.label}
						<span class="ml-1 text-[10px]" style="color: var(--color-tron-text-secondary)">({btn.help})</span>
					</button>
				</form>
			{/each}
		</div>

		<p class="mt-3 text-[11px]" style="color: var(--color-tron-text-secondary)">
			Each click moves by ±{stepMm} mm in the chosen axis. Per-joint Δ is clamped to {maxStepDelta} steps
			(≈ {(maxStepDelta * 360 / 4096).toFixed(1)}°) per click. Click again to step further if a long jog clamped.
		</p>
	</section>

	<!-- Per-joint single-step jog (precision fallback for the last 0.3 mm) -->
	<section
		class="rounded-lg border border-[var(--color-tron-border)] bg-[var(--color-tron-surface)] p-4"
	>
		<div class="mb-3 flex items-center justify-between">
			<h2 class="text-sm font-bold uppercase tracking-wider" style="color: var(--color-tron-text-secondary)">
				Per-joint single-step
			</h2>
			<label class="flex items-center gap-2 text-xs" style="color: var(--color-tron-text-secondary)">
				step
				<input
					type="number"
					bind:value={jointStep}
					min="1"
					max="100"
					class="w-16 rounded border border-[var(--color-tron-border)] bg-black/40 px-2 py-1 text-sm"
					style="color: var(--color-tron-text)"
				/>
			</label>
		</div>
		<div class="grid grid-cols-5 gap-2">
			{#each [1, 2, 3, 4, 5] as sid (sid)}
				<div class="flex flex-col gap-1">
					<form method="POST" action="?/jogJoint" use:enhance>
						<input type="hidden" name="sid" value={sid} />
						<input type="hidden" name="delta_steps" value={jointStep} />
						<button
							type="submit"
							disabled={sessionActive}
							class="w-full rounded border border-[var(--color-tron-cyan)]/50 bg-[var(--color-tron-cyan)]/10 px-2 py-2 font-mono text-sm transition-colors hover:bg-[var(--color-tron-cyan)]/20 disabled:opacity-40"
							style="color: var(--color-tron-cyan)"
						>
							J{sid} +
						</button>
					</form>
					<form method="POST" action="?/jogJoint" use:enhance>
						<input type="hidden" name="sid" value={sid} />
						<input type="hidden" name="delta_steps" value={-jointStep} />
						<button
							type="submit"
							disabled={sessionActive}
							class="w-full rounded border border-[var(--color-tron-cyan)]/50 bg-[var(--color-tron-cyan)]/10 px-2 py-2 font-mono text-sm transition-colors hover:bg-[var(--color-tron-cyan)]/20 disabled:opacity-40"
							style="color: var(--color-tron-cyan)"
						>
							J{sid} −
						</button>
					</form>
				</div>
			{/each}
		</div>
		<p class="mt-3 text-[11px]" style="color: var(--color-tron-text-secondary)">
			±{jointStep} step ≈ {(jointStep * 360 / 4096).toFixed(2)}° at the joint, ~{(jointStep * 0.3).toFixed(2)} mm
			at the tip near full extension. Use this when Cartesian IK rounds your nudge to nothing.
		</p>
	</section>

	<!-- Torque + calibration controls -->
	<section class="grid grid-cols-2 gap-3 text-xs">
		<form method="POST" action="?/torqueOn" use:enhance>
			<button
				type="submit"
				disabled={sessionActive}
				class="w-full rounded border border-emerald-500/50 bg-emerald-900/10 px-3 py-2 font-medium text-emerald-300 transition-colors hover:bg-emerald-900/20 disabled:opacity-40"
			>
				torque on
			</button>
		</form>
		<form method="POST" action="?/torqueOff" use:enhance>
			<button
				type="submit"
				disabled={sessionActive}
				class="w-full rounded border border-red-500/50 bg-red-900/10 px-3 py-2 font-medium text-red-300 transition-colors hover:bg-red-900/20 disabled:opacity-40"
			>
				torque off
			</button>
		</form>
	</section>

	<div class="grid grid-cols-2 gap-3">
		<form method="POST" action="?/reloadCalibration" use:enhance>
			<button
				type="submit"
				class="w-full rounded border border-[var(--color-tron-border)] bg-black/30 px-3 py-2 text-xs transition-colors hover:bg-black/50"
				style="color: var(--color-tron-text-secondary)"
			>
				Reload calibration JSON
			</button>
		</form>
		<form method="POST" action="?/resetBacklash" use:enhance>
			<button
				type="submit"
				class="w-full rounded border border-[var(--color-tron-border)] bg-black/30 px-3 py-2 text-xs transition-colors hover:bg-black/50"
				style="color: var(--color-tron-text-secondary)"
			>
				Reset backlash state
			</button>
		</form>
	</div>
	<p class="text-[11px]" style="color: var(--color-tron-text-secondary)">
		Backlash compensation is on by default — when a joint reverses direction, the server
		automatically over-shoots by ~10 steps (per-joint override in jog-calibration.json under
		<code>backlash_steps</code>) so gear slack is consumed before the arm tip moves. Reset
		after manually hand-poseing with torque off so the next jog isn't treated as a reversal.
	</p>
</div>
