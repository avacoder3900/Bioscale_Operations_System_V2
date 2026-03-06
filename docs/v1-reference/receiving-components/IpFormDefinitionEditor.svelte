<script lang="ts">
	import { TronCard } from '$lib/components/ui';
	import { enhance } from '$app/forms';

	interface Props {
		revisionId: string;
		formDefinition: unknown;
		formDefError?: string | null;
		formDefSuccess?: boolean;
	}

	let { revisionId, formDefinition, formDefError = null, formDefSuccess = false }: Props = $props();

	const TEMPLATE = {
		tools: [{ tool_id: 'TOOL-001', name: 'Digital Caliper' }],
		references: [{ ref_id: 'REF-001', title: 'Assembly Drawing Rev A' }],
		steps: [
			{
				step_order: 1,
				input_type: 'dimension',
				question_label: 'Measure overall length',
				nominal: 25.4,
				tolerance: 0.1,
				unit: 'mm',
				tool_id: 'TOOL-001'
			}
		]
	};

	let jsonText = $state('');
	let clientError = $state('');
	let saving = $state(false);

	// Sync jsonText when formDefinition prop changes (e.g. after save + page reload)
	let prevFormDef: unknown = undefined;
	$effect.pre(() => {
		if (formDefinition !== prevFormDef) {
			prevFormDef = formDefinition;
			jsonText = formDefinition ? JSON.stringify(formDefinition, null, 2) : '';
		}
	});

	function validateJson(text: string): string {
		if (!text.trim()) return 'Form definition is required.';

		let parsed: unknown;
		try {
			parsed = JSON.parse(text);
		} catch {
			return 'Invalid JSON syntax.';
		}

		if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
			return 'Must be a JSON object.';
		}

		const obj = parsed as Record<string, unknown>;
		const errors: string[] = [];

		if (!Array.isArray(obj.tools)) errors.push('"tools" must be an array.');
		if (!Array.isArray(obj.references)) errors.push('"references" must be an array.');

		const validTypes = ['pass_fail', 'yes_no', 'dimension', 'visual_inspection'];
		if (!Array.isArray(obj.steps)) {
			errors.push('"steps" must be an array.');
		} else {
			for (let i = 0; i < obj.steps.length; i++) {
				const s = obj.steps[i] as Record<string, unknown>;
				if (typeof s?.step_order !== 'number') errors.push(`steps[${i}]: needs "step_order".`);
				if (!validTypes.includes(s?.input_type as string))
					errors.push(`steps[${i}]: invalid "input_type".`);
				if (typeof s?.question_label !== 'string')
					errors.push(`steps[${i}]: needs "question_label".`);
			}
		}

		return errors.join(' ');
	}

	function formatJson() {
		try {
			const parsed = JSON.parse(jsonText);
			jsonText = JSON.stringify(parsed, null, 2);
			clientError = '';
		} catch {
			clientError = 'Cannot format: invalid JSON.';
		}
	}

	function insertTemplate() {
		jsonText = JSON.stringify(TEMPLATE, null, 2);
		clientError = '';
	}
</script>

<TronCard>
	<div class="mb-4 flex items-center justify-between">
		<div class="flex items-center gap-2">
			<h3 class="tron-text-primary text-lg font-semibold">IP Form Definition</h3>
			<span class="text-xs text-[var(--color-tron-text-secondary)]">Current Revision</span>
		</div>
		<div class="flex gap-2">
			<button
				type="button"
				onclick={insertTemplate}
				class="rounded border border-[var(--color-tron-border)] px-2.5 py-1 text-xs text-[var(--color-tron-text-secondary)] transition hover:border-[var(--color-tron-cyan)] hover:text-[var(--color-tron-cyan)]"
			>
				Insert Template
			</button>
			<button
				type="button"
				onclick={formatJson}
				class="rounded border border-[var(--color-tron-border)] px-2.5 py-1 text-xs text-[var(--color-tron-text-secondary)] transition hover:border-[var(--color-tron-cyan)] hover:text-[var(--color-tron-cyan)]"
			>
				Format JSON
			</button>
		</div>
	</div>

	{#if formDefSuccess}
		<div
			class="mb-4 rounded border border-[var(--color-tron-green)] bg-[color-mix(in_srgb,var(--color-tron-green)_10%,transparent)] px-4 py-2 text-sm text-[var(--color-tron-green)]"
		>
			Form definition saved successfully.
		</div>
	{/if}

	{#if formDefError || clientError}
		<div
			class="mb-4 rounded border border-[var(--color-tron-error)] bg-[color-mix(in_srgb,var(--color-tron-error)_10%,transparent)] px-4 py-2 text-sm text-[var(--color-tron-error)]"
		>
			{clientError || formDefError}
		</div>
	{/if}

	<form
		method="POST"
		action="?/saveFormDefinition"
		use:enhance={() => {
			const err = validateJson(jsonText);
			if (err) {
				clientError = err;
				return async () => {};
			}
			clientError = '';
			saving = true;
			return async ({ update }) => {
				saving = false;
				await update();
			};
		}}
	>
		<input type="hidden" name="revisionId" value={revisionId} />

		<div class="mb-3">
			<label
				for="form-def-editor"
				class="mb-1 block text-xs text-[var(--color-tron-text-secondary)]"
			>
				JSON: <code>{'{ tools[], references[], steps[] }'}</code>
			</label>
			<textarea
				id="form-def-editor"
				name="formDefinition"
				bind:value={jsonText}
				rows="16"
				spellcheck="false"
				placeholder={JSON.stringify(TEMPLATE, null, 2)}
				class="json-editor"
			></textarea>
		</div>

		<div
			class="mb-3 rounded border border-[var(--color-tron-border)] bg-[var(--color-tron-bg-secondary)] p-3"
		>
			<p class="mb-2 text-xs font-semibold text-[var(--color-tron-text-secondary)]">
				Expected Schema
			</p>
			<dl class="space-y-1 text-xs text-[var(--color-tron-text-secondary)]">
				<div>
					<dt class="inline font-mono text-[var(--color-tron-cyan)]">tools[]</dt>
					<dd class="inline">— <code>tool_id</code> (string), <code>name</code> (string)</dd>
				</div>
				<div>
					<dt class="inline font-mono text-[var(--color-tron-cyan)]">references[]</dt>
					<dd class="inline">
						— <code>ref_id</code> (string), <code>title</code> (string), <code>url</code> (optional)
					</dd>
				</div>
				<div>
					<dt class="inline font-mono text-[var(--color-tron-cyan)]">steps[]</dt>
					<dd class="inline">
						— <code>step_order</code> (number), <code>input_type</code> (pass_fail | yes_no |
						dimension | visual_inspection), <code>question_label</code> (string)
					</dd>
				</div>
				<div class="pt-1">
					<dt class="inline font-mono text-[var(--color-tron-text-secondary)]">
						dimension extras:
					</dt>
					<dd class="inline">
						<code>nominal</code>, <code>tolerance</code>, <code>unit</code>, <code>tool_id</code>,
						<code>photo_url</code>
					</dd>
				</div>
				<div>
					<dt class="inline font-mono text-[var(--color-tron-text-secondary)]">yes_no extras:</dt>
					<dd class="inline"><code>acceptable_answer</code> ("yes" | "no")</dd>
				</div>
			</dl>
		</div>

		<button
			type="submit"
			disabled={saving || !jsonText.trim()}
			class="rounded bg-[var(--color-tron-cyan)] px-4 py-1.5 text-sm font-semibold text-black transition disabled:opacity-50"
		>
			{saving ? 'Saving...' : 'Save Form Definition'}
		</button>
	</form>
</TronCard>

<style>
	.json-editor {
		width: 100%;
		font-family: ui-monospace, 'Cascadia Code', 'Source Code Pro', Menlo, Consolas, monospace;
		font-size: 0.8125rem;
		line-height: 1.5;
		tab-size: 2;
		padding: 0.75rem;
		border: 1px solid var(--color-tron-border);
		border-radius: 0.375rem;
		background-color: var(--color-tron-bg-tertiary);
		color: var(--color-tron-text);
		resize: vertical;
	}

	.json-editor:focus {
		outline: none;
		border-color: var(--color-tron-cyan);
		box-shadow: 0 0 0 1px var(--color-tron-cyan);
	}

	.json-editor::placeholder {
		color: var(--color-tron-text-secondary);
		opacity: 0.5;
	}
</style>
