<script lang="ts">
	import InstructionRow from './InstructionRow.svelte';
	import BcodePreview from './BcodePreview.svelte';

	interface Instruction {
		type: string;
		params?: number[];
		code?: Instruction[];
	}

	interface Props {
		initialInstructions?: Instruction[];
		oncompile: (instructions: Instruction[], bcodeString: string) => void;
	}

	let { initialInstructions, oncompile }: Props = $props();

	const OPCODES: Record<string, { code: number; params: string[] }> = {
		START_TEST: { code: 0, params: [] },
		DELAY: { code: 1, params: ['milliseconds'] },
		MOVE_MICRONS: { code: 2, params: ['microns', 'step_delay_us'] },
		OSCILLATE: { code: 3, params: ['microns', 'step_delay_us', 'cycles'] },
		SET_SENSOR_PARAMS: { code: 10, params: ['gain', 'step', 'integration'] },
		BASELINE_SCANS: { code: 11, params: ['num_scans'] },
		TEST_SCANS: { code: 14, params: ['num_scans'] },
		SENSOR_READING: { code: 15, params: ['channel', 'gain', 'step', 'integration'] },
		CONTINUOUS_SCANS: { code: 16, params: ['num_readings', 'delay_ms'] },
		REPEAT_BEGIN: { code: 20, params: ['count'] },
		REPEAT_END: { code: 21, params: [] },
		END_TEST: { code: 99, params: [] }
	};

	const ADDABLE_TYPES = [
		'DELAY',
		'MOVE_MICRONS',
		'OSCILLATE',
		'SET_SENSOR_PARAMS',
		'BASELINE_SCANS',
		'TEST_SCANS',
		'SENSOR_READING',
		'CONTINUOUS_SCANS',
		'REPEAT_BEGIN'
	];

	const TYPE_LABELS: Record<string, string> = {
		DELAY: 'Delay',
		MOVE_MICRONS: 'Move Stage',
		OSCILLATE: 'Oscillate Stage',
		SET_SENSOR_PARAMS: 'Set Sensor Params',
		BASELINE_SCANS: 'Baseline Scans',
		TEST_SCANS: 'Test Scans',
		SENSOR_READING: 'Sensor Reading',
		CONTINUOUS_SCANS: 'Continuous Scans',
		REPEAT_BEGIN: 'Repeat Block'
	};

	const DEFAULT_PARAMS: Record<string, number[]> = {
		DELAY: [1000],
		MOVE_MICRONS: [1000, 350],
		OSCILLATE: [1000, 350, 10],
		SET_SENSOR_PARAMS: [1, 1, 100],
		BASELINE_SCANS: [3],
		TEST_SCANS: [3],
		SENSOR_READING: [0, 1, 1, 100],
		CONTINUOUS_SCANS: [10, 1000],
		REPEAT_BEGIN: [10]
	};

	// Ensure START_TEST and END_TEST bookends
	function ensureBookends(list: Instruction[]): Instruction[] {
		const result = [...list];
		if (result.length === 0 || result[0].type !== 'START_TEST') {
			result.unshift({ type: 'START_TEST' });
		}
		if (result.length === 0 || result[result.length - 1].type !== 'END_TEST') {
			result.push({ type: 'END_TEST' });
		}
		return result;
	}

	let instructions = $state<Instruction[]>(ensureBookends(initialInstructions ?? []));
	let selectedType = $state('DELAY');
	let compileError = $state<string | null>(null);

	// Compile instructions to BCODE string (client-side preview)
	function compileInstructions(list: Instruction[]): string[] {
		const parts: string[] = [];
		for (const instr of list) {
			const opDef = OPCODES[instr.type];
			if (!opDef) continue;

			if (instr.type === 'REPEAT_BEGIN') {
				const count = instr.params?.[0] ?? 1;
				parts.push(`${opDef.code}:${count}`);
				if (instr.code && instr.code.length > 0) {
					parts.push(...compileInstructions(instr.code));
				}
				parts.push(`${OPCODES.REPEAT_END.code}:`);
			} else if (instr.type === 'REPEAT_END') {
				parts.push(`${opDef.code}:`);
			} else {
				const params = instr.params ?? [];
				parts.push(params.length > 0 ? `${opDef.code}:${params.join(',')}` : `${opDef.code}:`);
			}
		}
		return parts;
	}

	function calcDuration(list: Instruction[]): number {
		let ms = 0;
		for (const instr of list) {
			if (instr.type === 'DELAY') ms += instr.params?.[0] ?? 0;
			else if (instr.type === 'REPEAT_BEGIN') {
				const count = instr.params?.[0] ?? 1;
				ms += calcDuration(instr.code ?? []) * count;
			} else if (instr.type === 'BASELINE_SCANS' || instr.type === 'TEST_SCANS') {
				ms += (instr.params?.[0] ?? 1) * 500;
			} else if (instr.type === 'CONTINUOUS_SCANS') {
				ms += (instr.params?.[0] ?? 1) * (instr.params?.[1] ?? 0) + 100;
			}
		}
		return ms;
	}

	let bcodeString = $derived.by(() => {
		try {
			const parts = compileInstructions(instructions);
			const result = parts.join('|');
			compileError = null;
			return result;
		} catch (e) {
			compileError = e instanceof Error ? e.message : 'Compilation error';
			return '';
		}
	});

	let bcodeLength = $derived(new TextEncoder().encode(bcodeString).length);
	let estimatedDuration = $derived(calcDuration(instructions));

	// Notify parent on change — use explicit dependency on instructions array length + bcodeString
	$effect(() => {
		const _len = instructions.length;
		const _bcode = bcodeString;
		if (_bcode !== undefined && !compileError) {
			oncompile(instructions, _bcode);
		}
	});

	function addInstruction() {
		const newInstr: Instruction = {
			type: selectedType,
			params: DEFAULT_PARAMS[selectedType] ? [...DEFAULT_PARAMS[selectedType]] : undefined
		};
		if (selectedType === 'REPEAT_BEGIN') {
			newInstr.code = [];
		}
		// Insert before END_TEST
		const endIndex = instructions.findIndex((i) => i.type === 'END_TEST');
		const insertAt = endIndex >= 0 ? endIndex : instructions.length;
		const updated = [...instructions];
		updated.splice(insertAt, 0, newInstr);
		instructions = updated;
	}

	function removeInstruction(idx: number) {
		instructions = instructions.filter((_, i) => i !== idx);
	}

	function updateInstruction(idx: number, updated: Instruction) {
		const list = [...instructions];
		list[idx] = updated;
		instructions = list;
	}

	function moveUp(idx: number) {
		if (idx <= 1) return; // Don't move past START_TEST
		const list = [...instructions];
		[list[idx - 1], list[idx]] = [list[idx], list[idx - 1]];
		instructions = list;
	}

	function moveDown(idx: number) {
		if (idx >= instructions.length - 2) return; // Don't move past END_TEST
		const list = [...instructions];
		[list[idx], list[idx + 1]] = [list[idx + 1], list[idx]];
		instructions = list;
	}
</script>

<div class="grid gap-4 lg:grid-cols-3">
	<!-- Instruction List -->
	<div class="space-y-3 lg:col-span-2">
		<div class="flex items-center justify-between">
			<h3 class="text-sm font-bold" style="color: var(--color-tron-cyan, #00ffff)">
				Instructions ({instructions.length})
			</h3>
		</div>

		<div class="space-y-2">
			{#each instructions as instr, i (i)}
				<InstructionRow
					instruction={instr}
					index={i}
					onremove={removeInstruction}
					onupdate={updateInstruction}
					onmoveup={moveUp}
					onmovedown={moveDown}
					isFirst={i === 0}
					isLast={i === instructions.length - 1}
				/>
			{/each}
		</div>

		<!-- Add instruction -->
		<div class="flex gap-2">
			<select
				class="tron-input flex-1 px-3 py-2 text-sm"
				style="min-height: 44px"
				bind:value={selectedType}
			>
				{#each ADDABLE_TYPES as t}
					<option value={t}>{TYPE_LABELS[t] ?? t}</option>
				{/each}
			</select>
			<button
				type="button"
				class="tron-button px-4 text-sm"
				style="min-height: 44px; background: var(--color-tron-cyan, #00ffff); color: #000"
				onclick={addInstruction}
			>
				+ Add
			</button>
		</div>

		{#if compileError}
			<p class="text-sm" style="color: #ef4444">{compileError}</p>
		{/if}
	</div>

	<!-- Preview Panel -->
	<div>
		<BcodePreview {bcodeString} {bcodeLength} {estimatedDuration} />
	</div>
</div>
