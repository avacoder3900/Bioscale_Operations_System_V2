<script lang="ts">
	import PassFailInput from './PassFailInput.svelte';
	import YesNoInput from './YesNoInput.svelte';
	import DimensionInput from './DimensionInput.svelte';
	import VisualInspectionInput from './VisualInspectionInput.svelte';

	export interface FormStep {
		step_order: number;
		input_type: string;
		question_label: string;
		acceptable_answer?: string;
		nominal?: number;
		tolerance?: number;
		unit?: string;
		tool_id?: string;
		photo_url?: string;
	}

	export interface StepResponse {
		value: string;
		result: 'pass' | 'fail' | 'manual_review';
		notes?: string;
	}

	export type ResponseMap = Record<number, Record<number, StepResponse>>;

	export interface InspectionResult {
		result: 'accepted' | 'failed';
		passRate: number;
		percentRequired: number;
		responses: ResponseMap;
		steps: FormStep[];
	}

	interface Props {
		steps: FormStep[];
		sampleSize: number;
		percentAccepted: number;
		oncomplete?: (result: InspectionResult) => void;
	}

	let { steps, sampleSize, percentAccepted, oncomplete }: Props = $props();

	let currentSample = $state(1);
	let responses = $state<ResponseMap>({});
	let submittedCount = $state(0);

	const sampleResponses = $derived(responses[currentSample] ?? {});
	const completedSteps = $derived(Object.keys(sampleResponses).length);
	const allStepsComplete = $derived(completedSteps === steps.length);
	const allSamplesSubmitted = $derived(submittedCount === sampleSize);

	// Count passing samples: a sample passes if no step has result === 'fail'
	const passingSamples = $derived.by(() => {
		let count = 0;
		for (let s = 1; s <= submittedCount; s++) {
			const sr = responses[s];
			if (!sr) continue;
			const hasFail = Object.values(sr).some((r) => r.result === 'fail');
			if (!hasFail) count++;
		}
		return count;
	});

	const passRate = $derived(submittedCount > 0 ? (passingSamples / submittedCount) * 100 : 0);

	const finalResult = $derived.by((): 'accepted' | 'failed' | null => {
		if (!allSamplesSubmitted) return null;
		return passRate >= percentAccepted ? 'accepted' : 'failed';
	});

	function recordResponse(
		stepOrder: number,
		value: string,
		result: 'pass' | 'fail' | 'manual_review',
		notes?: string
	) {
		responses[currentSample] = {
			...responses[currentSample],
			[stepOrder]: { value, result, ...(notes !== undefined ? { notes } : {}) }
		};
	}

	function handlePassFail(stepOrder: number, value: 'pass' | 'fail') {
		recordResponse(stepOrder, value, value);
	}

	function handleYesNo(stepOrder: number, value: 'yes' | 'no', acceptableAnswer: string) {
		recordResponse(stepOrder, value, value === acceptableAnswer ? 'pass' : 'fail');
	}

	function handleDimension(
		stepOrder: number,
		value: string,
		result: 'pass' | 'fail' | 'manual_review'
	) {
		recordResponse(stepOrder, value, result);
	}

	function handleVisualInspection(stepOrder: number, value: 'pass' | 'fail', notes: string) {
		recordResponse(stepOrder, value, value, notes);
	}

	function submitSample() {
		submittedCount = currentSample;
		if (currentSample < sampleSize) {
			currentSample++;
		}
	}

	function handleAccept() {
		if (!finalResult) return;
		oncomplete?.({
			result: finalResult,
			passRate,
			percentRequired: percentAccepted,
			responses,
			steps
		});
	}
</script>

<div class="space-y-4">
	{#if !allSamplesSubmitted}
		<!-- Sample progress header -->
		<div class="flex items-center justify-between border-b border-[var(--color-tron-border)] pb-3">
			<h3 class="tron-text text-sm font-semibold">Sample {currentSample} of {sampleSize}</h3>
			<span class="text-xs text-[var(--color-tron-text-secondary)]">
				{completedSteps} of {steps.length} steps completed
			</span>
		</div>

		<!-- Running tally -->
		{#if submittedCount > 0}
			<div class="rounded bg-[var(--color-tron-surface)] px-3 py-2 text-xs">
				<span class="tron-text-muted">Progress:</span>
				<span class="tron-text ml-1 font-medium">
					{passingSamples} of {submittedCount} samples passing ({passRate.toFixed(0)}%)
				</span>
			</div>
		{/if}

		<!-- Steps -->
		{#each steps as step (step.step_order)}
			<div class="space-y-2">
				<div class="flex items-start justify-between">
					<span class="tron-text text-sm font-medium">
						<span class="tron-text-muted mr-2 text-xs">#{step.step_order}</span>
						{step.question_label}
					</span>
					{#if sampleResponses[step.step_order]}
						{@const r = sampleResponses[step.step_order]}
						<span
							class="text-xs {r.result === 'pass'
								? 'text-green-400'
								: r.result === 'manual_review'
									? 'text-yellow-400'
									: 'text-red-400'}"
						>
							{r.result === 'manual_review' ? 'REVIEW' : r.result.toUpperCase()}
						</span>
					{/if}
				</div>

				{#if step.input_type === 'pass_fail'}
					<PassFailInput
						value={sampleResponses[step.step_order]?.value ?? null}
						onchange={(v) => handlePassFail(step.step_order, v)}
					/>
				{:else if step.input_type === 'yes_no'}
					<YesNoInput
						value={sampleResponses[step.step_order]?.value ?? null}
						acceptableAnswer={step.acceptable_answer ?? 'yes'}
						onchange={(v) => handleYesNo(step.step_order, v, step.acceptable_answer ?? 'yes')}
					/>
				{:else if step.input_type === 'dimension'}
					<DimensionInput
						value={sampleResponses[step.step_order]?.value ?? null}
						nominal={step.nominal ?? null}
						tolerance={step.tolerance ?? null}
						unit={step.unit ?? null}
						toolId={step.tool_id ?? null}
						photoUrl={step.photo_url ?? null}
						onchange={(v, r) => handleDimension(step.step_order, v, r)}
					/>
				{:else if step.input_type === 'visual_inspection'}
					<VisualInspectionInput
						value={sampleResponses[step.step_order]?.value ?? null}
						notes={sampleResponses[step.step_order]?.notes ?? ''}
						onchange={(v, n) => handleVisualInspection(step.step_order, v, n)}
					/>
				{:else}
					<p class="tron-text-muted text-sm italic">
						{step.input_type} input — not yet implemented
					</p>
				{/if}
			</div>
		{/each}

		<!-- Submit Sample -->
		<div class="border-t border-[var(--color-tron-border)] pt-4">
			<button
				type="button"
				disabled={!allStepsComplete}
				onclick={submitSample}
				class="tron-button w-full px-4 py-3 text-sm font-medium disabled:opacity-50"
			>
				{currentSample < sampleSize
					? `Submit Sample ${currentSample} → Next`
					: `Submit Sample ${currentSample} — Finish`}
			</button>
		</div>
	{:else}
		<!-- Final Result -->
		<div
			class="rounded-lg border p-6 text-center {finalResult === 'accepted'
				? 'border-green-500/30 bg-green-500/10'
				: 'border-red-500/30 bg-red-500/10'}"
		>
			<div
				class="mb-2 text-3xl font-bold {finalResult === 'accepted'
					? 'text-green-400'
					: 'text-red-400'}"
			>
				{finalResult === 'accepted' ? 'ACCEPTED' : 'FAILED'}
			</div>
			<div class="tron-text text-sm">
				{passingSamples} of {sampleSize} samples passing
			</div>
			<div class="tron-text-muted mt-1 text-xs">
				Actual: {passRate.toFixed(1)}% — Required: {percentAccepted}%
			</div>
		</div>

		<!-- Running tally detail -->
		<div class="space-y-1 text-xs">
			{#each Array.from({ length: sampleSize }, (_, i) => i + 1) as s (s)}
				{@const sr = responses[s] ?? {}}
				{@const hasFail = Object.values(sr).some((r) => r.result === 'fail')}
				<div class="flex items-center gap-2 {hasFail ? 'text-red-400' : 'text-green-400'}">
					<span class="w-20">Sample {s}</span>
					<span>{hasFail ? 'FAIL' : 'PASS'}</span>
				</div>
			{/each}
		</div>

		<!-- Action button -->
		<button
			type="button"
			onclick={handleAccept}
			class="tron-button w-full px-4 py-3 text-sm font-medium"
		>
			{finalResult === 'accepted' ? 'Proceed to Lot Creation →' : 'View Options →'}
		</button>
	{/if}
</div>
