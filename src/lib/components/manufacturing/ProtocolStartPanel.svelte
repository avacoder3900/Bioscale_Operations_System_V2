<!--
  Generic "Start Run" panel for OT-2-driven manufacturing flows.

  Shared by /manufacturing/wax-filling and /manufacturing/reagent-filling.
  Replaces a bare "Start Run" button with:
    - A protocol picker (filtered from the robot's uploaded protocols)
    - A dynamic parameter form, rendered from the selected protocol's
      parametersSchema (int / float / bool / str inputs)
    - A pipette tip-tracker readout, fed by the most recent BIMS run
      for this robot+protocol, with an inline "Reset (refilled rack)"
      checkbox that maps to the protocol's `tiprack_refilled` param.
    - A Start button that submits the parent's startRun form action.

  Inputs (props):
    robot:           { _id, name }                         // the run's robot
    protocols:       array of { opentronsProtocolId, protocolName,
                                protocolType, parametersSchema }
    contextValues:   record of overrides BIMS forces into the params
                     (e.g. { cartridges: 24 } from cartridgeIds.length)
    contextReadonly: keys whose value the operator can't change
                     (passed through into hidden inputs only)
    lastTipState:    { nextTipIndex, hostname, capturedAt } | null
    tipsPerRack:     number (default 96)
    submitting:      bool — disables Start while a parent submit is in flight
    formAction:      string — the parent page's form action path
                     (e.g. "?/startRunOnRobot")
    extraHidden:     record of extra hidden inputs to include in the POST
                     (e.g. { runId }, so the parent action knows which
                     wax/reagent run this is)
    onSubmitIntercept: optional. When provided, the form's native POST is
                     prevented and the serialized FormData (all hidden +
                     parameter fields it would have posted) is handed to
                     this callback instead — used by orchestrated flows
                     that must run robot scans before startRun. When
                     absent, behavior is identical to a plain form submit.
-->
<script lang="ts">
	interface ParamDef {
		variableName: string;
		displayName?: string;
		description?: string;
		type?: 'int' | 'float' | 'bool' | 'str';
		default?: number | string | boolean;
		min?: number;
		max?: number;
		unit?: string;
	}

	interface ProtocolDef {
		opentronsProtocolId: string;
		protocolName: string;
		protocolType?: string | null;
		// Loose: load functions return this as `unknown` (Mixed); we narrow
		// on read. Accepting unknown lets the caller pass server data without
		// a redundant cast.
		parametersSchema?: ParamDef[] | unknown | null;
	}

	interface TipState {
		nextTipIndex?: number | null;
		hostname?: string | null;
		capturedAt?: string | Date | null;
	}

	let {
		robot,
		protocols,
		contextValues = {},
		contextReadonly = [],
		lastTipState = null as TipState | null,
		tipsPerRack = 96,
		submitting = false,
		formAction,
		extraHidden = {} as Record<string, string>,
		onSubmitIntercept = undefined,
		autoStart = false,
		onAutoStarted = undefined,
		submitLabel = 'Start Run'
	} = $props<{
		robot: { _id: string; name: string };
		protocols: ProtocolDef[];
		contextValues?: Record<string, number | string | boolean>;
		contextReadonly?: string[];
		lastTipState?: TipState | null;
		tipsPerRack?: number;
		submitting?: boolean;
		formAction: string;
		extraHidden?: Record<string, string>;
		onSubmitIntercept?: (formData: FormData) => Promise<void> | void;
		submitLabel?: string;
		// When true, the panel submits itself once on mount (used to auto-start
		// the run straight after a clean barcode scan — no operator click).
		autoStart?: boolean;
		onAutoStarted?: () => void;
	}>();

	let formEl: HTMLFormElement | undefined = $state();
	let autoSubmitted = $state(false);
	$effect(() => {
		if (autoStart && !autoSubmitted && formEl && selectedProtocolId) {
			autoSubmitted = true;
			onAutoStarted?.();
			setTimeout(() => formEl?.requestSubmit(), 60);
		}
	});

	// Intercept the native submit when the parent wants to orchestrate
	// (e.g. robot scans before startRun). Fires only after the browser's
	// built-in validation passes, so required/min/max still apply. With no
	// interceptor the handler is a no-op and the form posts as before.
	function handleSubmit(e: SubmitEvent) {
		if (!onSubmitIntercept) return;
		e.preventDefault();
		void onSubmitIntercept(new FormData(e.currentTarget as HTMLFormElement));
	}

	// Pick the first protocol as a sensible default. Operator can change it
	// via the dropdown — most robots only have one wax + one reagent protocol
	// so this is usually a one-tap confirmation.
	let selectedProtocolId = $state(protocols[0]?.opentronsProtocolId ?? '');
	let selected = $derived(
		protocols.find((p: ProtocolDef) => p.opentronsProtocolId === selectedProtocolId) ?? null
	);

	// parametersSchema arrives as `unknown` (Mixed in Mongoose) — narrow at
	// the edge so the template below can iterate safely.
	let paramSchema = $derived.by((): ParamDef[] => {
		const s = selected?.parametersSchema;
		return Array.isArray(s) ? (s as ParamDef[]) : [];
	});

	// Map of variableName -> current value. Seeded from the protocol's defaults
	// when the selection changes; context overrides applied last.
	let paramValues = $state<Record<string, number | string | boolean>>({});

	$effect(() => {
		if (!paramSchema.length) return;
		const next: Record<string, number | string | boolean> = {};
		for (const p of paramSchema) {
			next[p.variableName] =
				contextValues[p.variableName] !== undefined
					? contextValues[p.variableName]
					: (p.default ?? '');
		}
		paramValues = next;
	});

	function setValue(name: string, value: number | string | boolean) {
		paramValues = { ...paramValues, [name]: value };
	}

	// Tips remaining. nextTipIndex is the next tip to use (0-based) so
	// tipsRemaining = tipsPerRack - nextTipIndex.
	let tipsRemaining = $derived(
		lastTipState?.nextTipIndex != null
			? Math.max(0, tipsPerRack - lastTipState.nextTipIndex)
			: null
	);
	let tipsLow = $derived(tipsRemaining !== null && tipsRemaining < 12);

	// A1..H12 well coordinate for the current next-tip index.
	// scservo / Opentrons walk wells column-by-column (A1 B1 C1 ... H12).
	function indexToWell(idx: number): string {
		const cols = Math.floor(idx / 8);
		const row = idx % 8;
		return `${String.fromCharCode('A'.charCodeAt(0) + row)}${cols + 1}`;
	}

	let nextTipWell = $derived(
		lastTipState?.nextTipIndex != null && lastTipState.nextTipIndex < tipsPerRack
			? indexToWell(lastTipState.nextTipIndex)
			: null
	);
</script>

<div class="space-y-4 rounded-xl border border-[var(--color-tron-border)] bg-[var(--color-tron-surface)] p-5">
	<div class="flex items-baseline justify-between">
		<h3 class="text-lg font-semibold text-[var(--color-tron-text)]">Start Run</h3>
		<span class="text-xs" style="color: var(--color-tron-text-secondary)">
			Robot: <span class="font-mono text-[var(--color-tron-cyan)]">{robot.name}</span>
		</span>
	</div>

	{#if protocols.length === 0}
		<div class="rounded border border-amber-500/40 bg-amber-900/10 p-3 text-sm text-amber-300">
			This robot has no uploaded protocols. Upload one via
			<a href="/opentrons/devices/{robot._id}" class="underline">the Opentrons devices page</a>,
			then come back.
		</div>
	{:else}
		<form bind:this={formEl} method="POST" action={formAction} onsubmit={handleSubmit} class="space-y-4">
			{#each Object.entries(extraHidden) as [k, v] (k)}
				<input type="hidden" name={k} value={v} />
			{/each}

			<button
					type="submit"
					disabled={submitting || !selectedProtocolId}
					class="w-full rounded-lg bg-[var(--color-tron-cyan)] px-6 py-3 text-base font-semibold text-white transition-colors hover:bg-[var(--color-tron-cyan)]/80 disabled:opacity-50"
				>
					{submitting ? 'Starting…' : submitLabel}
				</button>

				<!-- Protocol selector -->
			<label class="block">
				<span class="text-xs font-medium uppercase tracking-wider" style="color: var(--color-tron-text-secondary)">
					Protocol
				</span>
				<select
					name="opentronsProtocolId"
					bind:value={selectedProtocolId}
					required
					class="mt-1 w-full rounded border border-[var(--color-tron-border)] bg-black/40 px-3 py-2 text-sm"
					style="color: var(--color-tron-text)"
				>
					{#each protocols as p (p.opentronsProtocolId)}
						<option value={p.opentronsProtocolId}>
							{p.protocolName}{p.protocolType ? ` (${p.protocolType})` : ''}
						</option>
					{/each}
				</select>
			</label>

			<!-- Tip tracker -->
			<div
				class="rounded border bg-black/30 p-3 text-sm"
				class:border-amber-500={tipsLow}
				class:border-[var(--color-tron-border)]={!tipsLow}
			>
				<div class="flex items-center justify-between">
					<span class="font-medium" style="color: var(--color-tron-text)">Pipette tips</span>
					{#if tipsRemaining !== null}
						<span
							class="font-mono text-xs"
							class:text-amber-400={tipsLow}
							style={!tipsLow ? 'color: var(--color-tron-cyan)' : ''}
						>
							{tipsRemaining} / {tipsPerRack} remaining
							{#if nextTipWell}· next: {nextTipWell}{/if}
						</span>
					{:else}
						<span class="text-xs" style="color: var(--color-tron-text-secondary)">
							no prior state — protocol starts at A1
						</span>
					{/if}
				</div>
				<label class="mt-2 flex cursor-pointer items-center gap-2 text-xs">
					<input
						type="checkbox"
						checked={!!paramValues.tiprack_refilled}
						onchange={(e) =>
							setValue('tiprack_refilled', (e.currentTarget as HTMLInputElement).checked)}
						class="rounded border-[var(--color-tron-border)] bg-black/40"
					/>
					<span style="color: var(--color-tron-text-secondary)">
						I just refilled this tiprack — reset tracking to A1 on the robot.
					</span>
				</label>
			</div>

			<!-- Dynamic parameter form -->
			{#if paramSchema.length}
				<fieldset class="space-y-2">
					<legend class="text-xs font-medium uppercase tracking-wider" style="color: var(--color-tron-text-secondary)">
						Parameters
					</legend>
					{#each paramSchema as p (p.variableName)}
						{@const isReadonly = contextReadonly.includes(p.variableName)}
						{@const isTipReset = p.variableName === 'tiprack_refilled'}
						{#if isTipReset}
							<!-- Already rendered inside the tip-tracker block above; keep
							     a hidden input so the value still posts. -->
							<input
								type="hidden"
								name="param_{p.variableName}"
								value={paramValues[p.variableName] ? 'true' : 'false'}
							/>
						{:else if p.type === 'bool'}
							<!-- Hidden input ALWAYS posts the value. A bare checkbox submits
							     nothing when unchecked, so toggling a default-on param OFF would
							     be dropped and the server would fall back to the default. The
							     visible checkbox only drives paramValues; the hidden field posts. -->
							<input
								type="hidden"
								name="param_{p.variableName}"
								value={paramValues[p.variableName] ? 'true' : 'false'}
							/>
							<label class="flex cursor-pointer items-start gap-2 rounded border border-[var(--color-tron-border)] bg-black/30 p-2 text-sm">
								<input
									type="checkbox"
									checked={!!paramValues[p.variableName]}
									disabled={isReadonly}
									onchange={(e) =>
										setValue(p.variableName, (e.currentTarget as HTMLInputElement).checked)}
									class="mt-0.5"
								/>
								<span class="flex-1">
									<span class="font-medium" style="color: var(--color-tron-text)">
										{p.displayName ?? p.variableName}
									</span>
									{#if p.description}
										<span class="block text-xs" style="color: var(--color-tron-text-secondary)">
											{p.description}
										</span>
									{/if}
								</span>
							</label>
						{:else if p.type === 'int' || p.type === 'float'}
							<label class="block rounded border border-[var(--color-tron-border)] bg-black/30 p-2 text-sm">
								<span class="font-medium" style="color: var(--color-tron-text)">
									{p.displayName ?? p.variableName}
									{#if p.unit}<span class="ml-1 text-xs" style="color: var(--color-tron-text-secondary)">({p.unit})</span>{/if}
									{#if isReadonly}<span class="ml-2 text-[10px] uppercase tracking-wider text-amber-400">auto</span>{/if}
								</span>
								<input
									type="number"
									name="param_{p.variableName}"
									value={paramValues[p.variableName]}
									min={p.min}
									max={p.max}
									step={p.type === 'float' ? 'any' : 1}
									readonly={isReadonly}
									required
									oninput={(e) =>
										setValue(
											p.variableName,
											p.type === 'float'
												? parseFloat((e.currentTarget as HTMLInputElement).value)
												: parseInt((e.currentTarget as HTMLInputElement).value, 10)
										)}
									class="mt-1 w-full rounded border border-[var(--color-tron-border)] bg-black/40 px-2 py-1.5 font-mono text-sm"
									class:opacity-60={isReadonly}
									style="color: var(--color-tron-text)"
								/>
								{#if p.description}
									<span class="mt-1 block text-xs" style="color: var(--color-tron-text-secondary)">
										{p.description}
									</span>
								{/if}
							</label>
						{:else}
							<label class="block rounded border border-[var(--color-tron-border)] bg-black/30 p-2 text-sm">
								<span class="font-medium" style="color: var(--color-tron-text)">
									{p.displayName ?? p.variableName}
								</span>
								<input
									type="text"
									name="param_{p.variableName}"
									value={paramValues[p.variableName]}
									readonly={isReadonly}
									oninput={(e) =>
										setValue(p.variableName, (e.currentTarget as HTMLInputElement).value)}
									class="mt-1 w-full rounded border border-[var(--color-tron-border)] bg-black/40 px-2 py-1.5 font-mono text-sm"
									style="color: var(--color-tron-text)"
								/>
							</label>
						{/if}
					{/each}
				</fieldset>
			{:else}
				<div class="rounded border border-[var(--color-tron-border)] bg-black/30 p-3 text-xs" style="color: var(--color-tron-text-secondary)">
					This protocol has no run-time parameters. Analysis may still be pending — check on
					<a href="/opentrons/devices/{robot._id}" class="underline">the device page</a>.
				</div>
			{/if}
		</form>
	{/if}
</div>
