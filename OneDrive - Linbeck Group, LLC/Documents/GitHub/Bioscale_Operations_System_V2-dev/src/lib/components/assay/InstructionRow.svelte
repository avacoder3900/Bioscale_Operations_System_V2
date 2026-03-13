<script lang="ts">
	import Self from './InstructionRow.svelte';

	interface Instruction {
		type: string;
		params?: number[];
		code?: Instruction[];
	}

	interface Props {
		instruction: Instruction;
		index: number;
		depth?: number;
		onremove: (index: number) => void;
		onupdate: (index: number, instruction: Instruction) => void;
		onmoveup: (index: number) => void;
		onmovedown: (index: number) => void;
		isFirst?: boolean;
		isLast?: boolean;
	}

	let {
		instruction,
		index,
		depth = 0,
		onremove,
		onupdate,
		onmoveup,
		onmovedown,
		isFirst = false,
		isLast = false
	}: Props = $props();

	const COMMAND_PARAMS: Record<string, { label: string; params: { name: string; min: number; max: number; default: number }[] }> = {
		START_TEST: { label: 'Start Test', params: [] },
		DELAY: { label: 'Delay', params: [{ name: 'Milliseconds', min: 0, max: 300000, default: 1000 }] },
		MOVE_MICRONS: { label: 'Move Stage', params: [{ name: 'Microns', min: 0, max: 50000, default: 1000 }, { name: 'Step Delay (µs)', min: 100, max: 50000, default: 350 }] },
		OSCILLATE: { label: 'Oscillate Stage', params: [{ name: 'Microns', min: 0, max: 50000, default: 1000 }, { name: 'Step Delay (µs)', min: 100, max: 50000, default: 350 }, { name: 'Cycles', min: 1, max: 1000, default: 10 }] },
		SET_SENSOR_PARAMS: { label: 'Set Sensor Params', params: [{ name: 'Gain', min: 0, max: 10, default: 1 }, { name: 'Step', min: 0, max: 10, default: 1 }, { name: 'Integration', min: 0, max: 255, default: 100 }] },
		BASELINE_SCANS: { label: 'Baseline Scans', params: [{ name: 'Scans', min: 1, max: 100, default: 3 }] },
		TEST_SCANS: { label: 'Test Scans', params: [{ name: 'Scans', min: 1, max: 100, default: 3 }] },
		SENSOR_READING: { label: 'Sensor Reading', params: [{ name: 'Channel', min: 0, max: 3, default: 0 }, { name: 'Gain', min: 0, max: 10, default: 1 }, { name: 'Step', min: 0, max: 10, default: 1 }, { name: 'Integration', min: 0, max: 255, default: 100 }] },
		CONTINUOUS_SCANS: { label: 'Continuous Scans', params: [{ name: 'Readings', min: 1, max: 1000, default: 10 }, { name: 'Delay (ms)', min: 0, max: 60000, default: 1000 }] },
		REPEAT_BEGIN: { label: 'Repeat Block', params: [{ name: 'Count', min: 1, max: 1000, default: 10 }] },
		END_TEST: { label: 'End Test', params: [] }
	};

	const COLORS: Record<string, string> = {
		START_TEST: 'var(--color-tron-green, #39ff14)',
		END_TEST: '#ef4444',
		DELAY: 'var(--color-tron-orange, #f97316)',
		MOVE_MICRONS: 'var(--color-tron-cyan, #00ffff)',
		OSCILLATE: 'var(--color-tron-cyan, #00ffff)',
		BASELINE_SCANS: '#a78bfa',
		TEST_SCANS: '#a78bfa',
		REPEAT_BEGIN: '#fbbf24',
		SET_SENSOR_PARAMS: '#6b7280',
		SENSOR_READING: '#6b7280',
		CONTINUOUS_SCANS: '#a78bfa'
	};

	let commandDef = $derived(COMMAND_PARAMS[instruction.type]);
	let color = $derived(COLORS[instruction.type] ?? 'var(--color-tron-text-secondary)');

	function updateParam(paramIndex: number, value: number) {
		const newParams = [...(instruction.params ?? [])];
		newParams[paramIndex] = value;
		onupdate(index, { ...instruction, params: newParams });
	}

	function addInnerInstruction() {
		if (instruction.type !== 'REPEAT_BEGIN') return;
		const innerCode = [...(instruction.code ?? [])];
		innerCode.push({ type: 'DELAY', params: [1000] });
		onupdate(index, { ...instruction, code: innerCode });
	}

	function removeInnerInstruction(innerIndex: number) {
		if (!instruction.code) return;
		const innerCode = instruction.code.filter((_, i) => i !== innerIndex);
		onupdate(index, { ...instruction, code: innerCode });
	}

	function updateInnerInstruction(innerIndex: number, updated: Instruction) {
		if (!instruction.code) return;
		const innerCode = [...instruction.code];
		innerCode[innerIndex] = updated;
		onupdate(index, { ...instruction, code: innerCode });
	}

	function moveInnerUp(innerIndex: number) {
		if (!instruction.code || innerIndex === 0) return;
		const innerCode = [...instruction.code];
		[innerCode[innerIndex - 1], innerCode[innerIndex]] = [innerCode[innerIndex], innerCode[innerIndex - 1]];
		onupdate(index, { ...instruction, code: innerCode });
	}

	function moveInnerDown(innerIndex: number) {
		if (!instruction.code || innerIndex >= instruction.code.length - 1) return;
		const innerCode = [...instruction.code];
		[innerCode[innerIndex], innerCode[innerIndex + 1]] = [innerCode[innerIndex + 1], innerCode[innerIndex]];
		onupdate(index, { ...instruction, code: innerCode });
	}
</script>

<div
	class="rounded border p-3"
	style="border-color: {color}33; margin-left: {depth * 24}px"
>
	<div class="flex items-center gap-2">
		<!-- Drag handle / Label -->
		<span
			class="rounded px-2 py-1 text-xs font-bold"
			style="background: {color}22; color: {color}"
		>
			{commandDef?.label ?? instruction.type}
		</span>

		<!-- Parameters -->
		{#if commandDef}
			{#each commandDef.params as paramDef, pi}
				<div class="flex items-center gap-1">
					<span class="text-xs" style="color: var(--color-tron-text-secondary)">{paramDef.name}:</span>
					<input
						type="number"
						class="tron-input w-20 px-2 py-1 text-xs"
						style="min-height: 32px"
						min={paramDef.min}
						max={paramDef.max}
						value={instruction.params?.[pi] ?? paramDef.default}
						onchange={(e) => updateParam(pi, parseInt((e.target as HTMLInputElement).value) || paramDef.default)}
					/>
				</div>
			{/each}
		{/if}

		<!-- Spacer -->
		<div class="flex-1"></div>

		<!-- Move buttons -->
		<button
			type="button"
			class="tron-button px-2 py-1 text-xs"
			style="min-height: 32px"
			disabled={isFirst}
			onclick={() => onmoveup(index)}
			title="Move up"
		>&#9650;</button>
		<button
			type="button"
			class="tron-button px-2 py-1 text-xs"
			style="min-height: 32px"
			disabled={isLast}
			onclick={() => onmovedown(index)}
			title="Move down"
		>&#9660;</button>

		<!-- Remove button -->
		{#if instruction.type !== 'START_TEST' && instruction.type !== 'END_TEST'}
			<button
				type="button"
				class="tron-button px-2 py-1 text-xs"
				style="min-height: 32px; color: #ef4444; border-color: #ef4444"
				onclick={() => onremove(index)}
				title="Remove"
			>&#10005;</button>
		{/if}
	</div>

	<!-- Repeat block inner instructions -->
	{#if instruction.type === 'REPEAT_BEGIN'}
		<div class="mt-2 space-y-2 border-l-2 pl-3" style="border-color: #fbbf2466">
			{#if instruction.code && instruction.code.length > 0}
				{#each instruction.code as inner, i (i)}
					<Self
						instruction={inner}
						index={i}
						depth={depth + 1}
						onremove={removeInnerInstruction}
						onupdate={updateInnerInstruction}
						onmoveup={moveInnerUp}
						onmovedown={moveInnerDown}
						isFirst={i === 0}
						isLast={i === (instruction.code?.length ?? 0) - 1}
					/>
				{/each}
			{:else}
				<p class="text-xs italic" style="color: var(--color-tron-text-secondary)">No instructions in repeat block</p>
			{/if}
			<button
				type="button"
				class="tron-button w-full text-xs"
				style="min-height: 36px; border-style: dashed; color: #fbbf24; border-color: #fbbf2466"
				onclick={addInnerInstruction}
			>
				+ Add Inner Instruction
			</button>
		</div>
	{/if}
</div>
