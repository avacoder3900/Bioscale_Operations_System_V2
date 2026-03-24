<script lang="ts">
	import BcodeDiff from './BcodeDiff.svelte';

	interface VersionEntry {
		id: string;
		assayId: string;
		versionNumber: number;
		previousName: string;
		previousDescription: string | null;
		previousBcode: unknown;
		previousBcodeLength: number | null;
		previousChecksum: number | null;
		previousDuration: number | null;
		changedBy: string | null;
		changedAt: Date | string;
		changeNotes: string | null;
		changedByUsername: string | null;
	}

	interface DiffEntry {
		type: 'added' | 'removed' | 'unchanged' | 'modified';
		oldInstruction?: string;
		newInstruction?: string;
		index: number;
	}

	interface Props {
		versions: VersionEntry[];
		currentBcode?: string | null;
		canRestore?: boolean;
		onrestore?: (versionNumber: number) => void;
	}

	let { versions, currentBcode = null, canRestore = false, onrestore }: Props = $props();

	let expandedVersion = $state<number | null>(null);
	let showAll = $state(versions.length <= 5);
	let restoring = $state(false);

	let visibleVersions = $derived(showAll ? versions : versions.slice(0, 5));
	let hiddenCount = $derived(versions.length - 5);

	function formatDate(date: Date | string): string {
		const d = typeof date === 'string' ? new Date(date) : date;
		return d.toLocaleDateString('en-US', {
			month: 'short',
			day: 'numeric',
			year: 'numeric',
			hour: '2-digit',
			minute: '2-digit'
		});
	}

	function toggleDiff(versionNumber: number) {
		expandedVersion = expandedVersion === versionNumber ? null : versionNumber;
	}

	function computeDiff(oldBcode: string | null, newBcode: string | null): DiffEntry[] {
		const oldInstructions = oldBcode ? oldBcode.split('|').filter(Boolean) : [];
		const newInstructions = newBcode ? newBcode.split('|').filter(Boolean) : [];
		const maxLen = Math.max(oldInstructions.length, newInstructions.length);
		const diff: DiffEntry[] = [];

		for (let i = 0; i < maxLen; i++) {
			const oldInst = i < oldInstructions.length ? oldInstructions[i] : undefined;
			const newInst = i < newInstructions.length ? newInstructions[i] : undefined;

			if (oldInst && newInst) {
				if (oldInst === newInst) {
					diff.push({ type: 'unchanged', oldInstruction: oldInst, newInstruction: newInst, index: i });
				} else {
					diff.push({ type: 'modified', oldInstruction: oldInst, newInstruction: newInst, index: i });
				}
			} else if (oldInst && !newInst) {
				diff.push({ type: 'removed', oldInstruction: oldInst, index: i });
			} else if (!oldInst && newInst) {
				diff.push({ type: 'added', newInstruction: newInst, index: i });
			}
		}

		return diff;
	}

	function getNextVersionBcode(versionIndex: number): string | null {
		if (versionIndex === 0) {
			return currentBcode;
		}
		const prev = versions[versionIndex - 1];
		if (!prev?.previousBcode) return null;
		return typeof prev.previousBcode === 'string'
			? prev.previousBcode
			: Buffer.from(prev.previousBcode as Buffer).toString('utf-8');
	}

	function getVersionBcodeString(version: VersionEntry): string | null {
		if (!version.previousBcode) return null;
		return typeof version.previousBcode === 'string'
			? version.previousBcode
			: Buffer.from(version.previousBcode as Buffer).toString('utf-8');
	}

	async function handleRestore(versionNumber: number) {
		if (!onrestore) return;
		restoring = true;
		try {
			onrestore(versionNumber);
		} finally {
			restoring = false;
		}
	}
</script>

<div class="version-history">
	{#if versions.length === 0}
		<div class="empty-state">
			<p>No version history yet</p>
			<p class="hint">Version history is recorded when assay definitions are edited.</p>
		</div>
	{:else}
		<div class="version-count">{versions.length} version{versions.length !== 1 ? 's' : ''}</div>

		<div class="timeline">
			{#each visibleVersions as version, index (version.id)}
				{@const isExpanded = expandedVersion === version.versionNumber}
				{@const versionBcode = getVersionBcodeString(version)}
				{@const nextBcode = getNextVersionBcode(index)}

				<div class="timeline-item">
					<div class="timeline-marker">
						<div class="marker-dot"></div>
					</div>
					{#if index < visibleVersions.length - 1 || (!showAll && hiddenCount > 0)}
						<div class="timeline-line"></div>
					{/if}

					<div class="timeline-content">
						<div class="version-header">
							<span class="version-badge">v{version.versionNumber}</span>
							<span class="version-name">{version.previousName}</span>
							{#if version.previousChecksum != null}
								<span class="checksum">CRC: {version.previousChecksum}</span>
							{/if}
						</div>

						<div class="version-meta">
							<span class="date">{formatDate(version.changedAt)}</span>
							{#if version.changedByUsername}
								<span class="separator">by</span>
								<span class="author">{version.changedByUsername}</span>
							{/if}
						</div>

						{#if version.changeNotes}
							<p class="change-notes">{version.changeNotes}</p>
						{/if}

						<div class="version-stats">
							{#if version.previousDuration != null}
								<span class="stat">{(version.previousDuration / 1000).toFixed(1)}s</span>
							{/if}
							{#if version.previousBcodeLength != null}
								<span class="stat">{version.previousBcodeLength} bytes</span>
							{/if}
						</div>

						<div class="version-actions">
							{#if versionBcode && nextBcode}
								<button
									class="tron-button small"
									onclick={() => toggleDiff(version.versionNumber)}
								>
									{isExpanded ? 'Hide Diff' : 'Show Diff'}
								</button>
							{/if}
							{#if canRestore}
								<button
									class="tron-button small restore"
									disabled={restoring}
									onclick={() => handleRestore(version.versionNumber)}
								>
									{restoring ? 'Restoring...' : 'Restore'}
								</button>
							{/if}
						</div>

						{#if isExpanded && versionBcode && nextBcode}
							<div class="diff-container">
								<BcodeDiff
									diff={computeDiff(versionBcode, nextBcode)}
									oldLabel="v{version.versionNumber}"
									newLabel={index === 0 ? 'Current' : `v${versions[index - 1].versionNumber}`}
								/>
							</div>
						{/if}
					</div>
				</div>
			{/each}

			{#if !showAll && hiddenCount > 0}
				<button class="show-more" onclick={() => (showAll = true)}>
					<div class="timeline-marker collapsed">
						<span class="count">+{hiddenCount}</span>
					</div>
					<span class="show-more-text">
						Show {hiddenCount} older version{hiddenCount > 1 ? 's' : ''}
					</span>
				</button>
			{/if}
		</div>
	{/if}
</div>

<style>
	.version-history {
		width: 100%;
	}

	.empty-state {
		text-align: center;
		padding: 2rem;
		color: var(--color-tron-text-secondary);
	}

	.empty-state .hint {
		font-size: 0.8125rem;
		opacity: 0.6;
		margin-top: 0.5rem;
	}

	.version-count {
		font-size: 0.75rem;
		color: var(--color-tron-text-secondary);
		text-transform: uppercase;
		letter-spacing: 0.05em;
		margin-bottom: 1rem;
	}

	.timeline {
		position: relative;
		padding-left: 1rem;
	}

	.timeline-item {
		position: relative;
		padding-bottom: 1.5rem;
		padding-left: 1.5rem;
	}

	.timeline-marker {
		position: absolute;
		left: 0;
		top: 0;
		width: 1rem;
		height: 1rem;
		border-radius: 50%;
		border: 2px solid var(--color-tron-cyan);
		background-color: var(--color-tron-bg-card);
		display: flex;
		align-items: center;
		justify-content: center;
	}

	.marker-dot {
		width: 0.375rem;
		height: 0.375rem;
		border-radius: 50%;
		background-color: var(--color-tron-cyan);
	}

	.timeline-line {
		position: absolute;
		left: 0.4375rem;
		top: 1rem;
		bottom: 0;
		width: 1px;
		background-color: var(--color-tron-border);
	}

	.timeline-content {
		min-height: 2rem;
	}

	.version-header {
		display: flex;
		align-items: center;
		gap: 0.5rem;
		flex-wrap: wrap;
	}

	.version-badge {
		display: inline-flex;
		align-items: center;
		padding: 0.125rem 0.5rem;
		border-radius: 0.25rem;
		background-color: rgba(0, 255, 255, 0.1);
		color: var(--color-tron-cyan);
		font-size: 0.75rem;
		font-weight: 600;
		font-family: monospace;
	}

	.version-name {
		font-weight: 600;
		color: var(--color-tron-text-primary);
		font-size: 0.9375rem;
	}

	.checksum {
		font-size: 0.6875rem;
		color: var(--color-tron-text-secondary);
		font-family: monospace;
		opacity: 0.6;
	}

	.version-meta {
		font-size: 0.8125rem;
		color: var(--color-tron-text-secondary);
		display: flex;
		align-items: center;
		gap: 0.25rem;
		margin-top: 0.25rem;
	}

	.separator {
		opacity: 0.6;
	}

	.author {
		color: var(--color-tron-text-primary);
	}

	.change-notes {
		margin-top: 0.5rem;
		font-size: 0.8125rem;
		color: var(--color-tron-text-secondary);
		line-height: 1.4;
		font-style: italic;
	}

	.version-stats {
		display: flex;
		gap: 0.75rem;
		margin-top: 0.375rem;
	}

	.stat {
		font-size: 0.75rem;
		color: var(--color-tron-text-secondary);
		font-family: monospace;
	}

	.version-actions {
		display: flex;
		gap: 0.5rem;
		margin-top: 0.5rem;
	}

	.tron-button.small {
		padding: 0.25rem 0.75rem;
		font-size: 0.75rem;
		min-height: 1.75rem;
		border: 1px solid var(--color-tron-border);
		background: transparent;
		color: var(--color-tron-cyan);
		border-radius: 0.25rem;
		cursor: pointer;
		transition: all 0.2s ease;
	}

	.tron-button.small:hover {
		background-color: rgba(0, 255, 255, 0.08);
		border-color: var(--color-tron-cyan);
	}

	.tron-button.small.restore {
		color: var(--color-tron-orange);
	}

	.tron-button.small.restore:hover {
		background-color: rgba(255, 165, 0, 0.08);
		border-color: var(--color-tron-orange);
	}

	.tron-button.small:disabled {
		opacity: 0.5;
		cursor: not-allowed;
	}

	.diff-container {
		margin-top: 0.75rem;
	}

	.show-more {
		display: flex;
		align-items: center;
		gap: 0.75rem;
		padding: 0;
		padding-left: 1.5rem;
		background: none;
		border: none;
		cursor: pointer;
		position: relative;
	}

	.show-more .timeline-marker {
		border-style: dashed;
		border-color: var(--color-tron-border);
		width: 1.25rem;
		height: 1.25rem;
		left: -0.125rem;
	}

	.show-more .count {
		font-size: 0.625rem;
		font-weight: 600;
		color: var(--color-tron-text-secondary);
	}

	.show-more-text {
		font-size: 0.8125rem;
		color: var(--color-tron-cyan);
		transition: color 0.2s ease;
	}

	.show-more:hover .show-more-text {
		color: var(--color-tron-text-primary);
	}
</style>
