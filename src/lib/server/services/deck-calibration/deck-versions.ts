/**
 * Deck version control — publish, list, roll back.
 *
 * `labware_definitions` holds the LIVE working geometry that the Deck
 * Calibration Studio edits hole by hole. `deck_versions` holds frozen snapshots
 * of that geometry at the moments someone decided it was good enough to run.
 *
 * The two are joined by the Opentrons identity triple. Publishing BUMPS
 * `version`, so every published calibration gets its own
 * namespace/loadName/version URI. That is not bookkeeping — Opentrons keys
 * definition identity (and any registered copy on the robot) to that triple.
 * Editing geometry while leaving the version fixed is what lets a robot keep
 * serving pre-edit coordinates while the UI shows the new ones.
 *
 * Rollback never rewrites history: it copies an old snapshot FORWARD as a new,
 * higher version. A version number, once published, always means exactly one
 * geometry.
 */
import {
	connectDB,
	LabwareDefinition,
	DeckVersion,
	DeckCalibrationEdit,
	AuditLog,
	generateId
} from '$lib/server/db';
import { resolveLabwareDefinition, isDeckLoadName } from './resolve';
import { definitionHash } from './definition-hash';

export { definitionHash };

export interface PublishInput {
	deckLoadName: string;
	user: { _id?: string; username?: string };
	note?: string;
	/** Publish even when the geometry is byte-identical to the last version. */
	force?: boolean;
}

export interface PublishResult {
	published: boolean;
	version: number;
	previousVersion: number | null;
	definitionHash: string;
	wellCount: number;
	detail: string;
}

/**
 * Freeze the deck's current geometry as a new immutable version.
 *
 * Idempotent by content: if nothing changed since the last publish this is a
 * no-op and returns the existing version, so a double-click on Sync cannot
 * inflate the history with identical snapshots.
 */
export async function publishDeckVersion(input: PublishInput): Promise<PublishResult> {
	await connectDB();
	const { deckLoadName } = input;
	const { doc } = await resolveLabwareDefinition(deckLoadName, { strict: true });

	const currentHash = definitionHash(doc.definition);
	const latest = (await DeckVersion.findOne({ deckLoadName })
		.sort({ version: -1 })
		.lean()) as any;

	if (latest && latest.definitionHash === currentHash && !input.force) {
		return {
			published: false,
			version: latest.version,
			previousVersion: latest.version,
			definitionHash: currentHash,
			wellCount: Object.keys(doc.definition?.wells ?? {}).length,
			detail: 'already published as v' + latest.version + ' — geometry unchanged'
		};
	}

	// Never reuse a number: go past both the frozen history and the live doc.
	const nextVersion = Math.max(Number(latest?.version ?? 0), Number(doc.version ?? 0)) + 1;

	// The version lives in two places that must agree — the Mongo column and the
	// labware JSON's own `version` field, which is what the robot reads.
	const definition = { ...doc.definition, version: nextVersion };
	const wellCount = Object.keys(definition?.wells ?? {}).length;
	const dims = definition?.dimensions ?? {};
	const frozenHash = definitionHash(definition);

	const editsSince = latest?.publishedAt
		? await DeckCalibrationEdit.countDocuments({
				deckLoadName,
				createdAt: { $gt: latest.publishedAt }
			})
		: await DeckCalibrationEdit.countDocuments({ deckLoadName });

	// Freeze FIRST. If the live-doc update below fails the snapshot still exists
	// and is recoverable; the reverse ordering could lose it.
	await DeckVersion.create({
		_id: generateId(),
		deckLoadName,
		namespace: doc.namespace,
		version: nextVersion,
		definition,
		definitionHash: frozenHash,
		wellCount,
		dimensions: {
			x: Number(dims.xDimension) || undefined,
			y: Number(dims.yDimension) || undefined,
			z: Number(dims.zDimension) || undefined
		},
		publishedAt: new Date(),
		publishedBy: input.user?.username,
		note: input.note,
		rolledBackFrom: null,
		editsSincePrevious: editsSince,
		publishedToRobots: []
	});

	await LabwareDefinition.updateOne(
		{ _id: doc._id },
		{
			$set: {
				version: nextVersion,
				'definition.version': nextVersion,
				lastPublishedVersion: nextVersion,
				hasUnpublishedEdits: false
			}
		}
	);

	await AuditLog.create({
		_id: generateId(),
		tableName: 'deck_versions',
		recordId: deckLoadName,
		action: 'deck_version_publish',
		newData: {
			deckLoadName,
			version: nextVersion,
			previousVersion: latest?.version ?? null,
			definitionHash: frozenHash,
			wellCount,
			editsSincePrevious: editsSince,
			note: input.note ?? null
		},
		changedAt: new Date(),
		changedBy: input.user?.username
	});

	return {
		published: true,
		version: nextVersion,
		previousVersion: latest?.version ?? null,
		definitionHash: frozenHash,
		wellCount,
		detail:
			'published v' + nextVersion + ' (' + wellCount + ' wells, ' + editsSince + ' edits since previous)'
	};
}

export interface RollbackInput {
	deckLoadName: string;
	/** The historical version whose geometry should become live again. */
	toVersion: number;
	user: { _id?: string; username?: string };
	note?: string;
}

/**
 * Restore an earlier snapshot by republishing it as a NEW higher version.
 *
 * This is the "it worked on Monday, get it back" path. The old row is never
 * touched, and the restored geometry gets a fresh identity so the robot cannot
 * confuse it with any copy it already holds.
 */
export async function rollbackDeckVersion(input: RollbackInput): Promise<PublishResult> {
	await connectDB();
	const { deckLoadName, toVersion } = input;

	const source = (await DeckVersion.findOne({ deckLoadName, version: toVersion }).lean()) as any;
	if (!source) {
		throw new Error('Deck "' + deckLoadName + '" has no published version ' + toVersion + '.');
	}

	const { doc } = await resolveLabwareDefinition(deckLoadName, { strict: true });
	const latest = (await DeckVersion.findOne({ deckLoadName }).sort({ version: -1 }).lean()) as any;
	const nextVersion = Math.max(Number(latest?.version ?? 0), Number(doc.version ?? 0)) + 1;

	const definition = { ...source.definition, version: nextVersion };
	const wellCount = Object.keys(definition?.wells ?? {}).length;
	const frozenHash = definitionHash(definition);

	await DeckVersion.create({
		_id: generateId(),
		deckLoadName,
		namespace: source.namespace,
		version: nextVersion,
		definition,
		definitionHash: frozenHash,
		wellCount,
		dimensions: source.dimensions,
		publishedAt: new Date(),
		publishedBy: input.user?.username,
		note: input.note ?? 'rollback to v' + toVersion,
		rolledBackFrom: toVersion,
		editsSincePrevious: 0,
		publishedToRobots: []
	});

	await LabwareDefinition.updateOne(
		{ _id: doc._id },
		{
			$set: {
				version: nextVersion,
				definition,
				lastPublishedVersion: nextVersion,
				hasUnpublishedEdits: false
			}
		}
	);

	await AuditLog.create({
		_id: generateId(),
		tableName: 'deck_versions',
		recordId: deckLoadName,
		action: 'deck_version_rollback',
		oldData: { version: doc.version, definitionHash: definitionHash(doc.definition) },
		newData: {
			deckLoadName,
			version: nextVersion,
			rolledBackFrom: toVersion,
			definitionHash: frozenHash,
			wellCount,
			note: input.note ?? null
		},
		changedAt: new Date(),
		changedBy: input.user?.username
	});

	return {
		published: true,
		version: nextVersion,
		previousVersion: latest?.version ?? null,
		definitionHash: frozenHash,
		wellCount,
		detail: 'rolled back to v' + toVersion + ', republished as v' + nextVersion
	};
}

/** Version history for one deck, newest first. Blobs excluded — they are large. */
export async function listDeckVersions(deckLoadName: string, limit = 50) {
	await connectDB();
	return (await DeckVersion.find({ deckLoadName })
		.select(
			'deckLoadName namespace version definitionHash wellCount dimensions publishedAt publishedBy note rolledBackFrom editsSincePrevious publishedToRobots'
		)
		.sort({ version: -1 })
		.limit(limit)
		.lean()) as any[];
}

/**
 * Mark the live definition dirty. Called by the edit engine after a nudge.
 *
 * Only decks are versioned, so this is a no-op for tip racks and tube racks —
 * they are calibrated through the same Studio, and flagging them would leave a
 * permanently-true dirty bit that no publish would ever clear.
 */
export async function markUnpublished(loadName: string): Promise<void> {
	if (!isDeckLoadName(loadName)) return;
	await connectDB();
	await LabwareDefinition.updateOne({ loadName }, { $set: { hasUnpublishedEdits: true } });
}
