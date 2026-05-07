import Anthropic from '@anthropic-ai/sdk';
import {
	connectDB, WaxBatch, WaxFillingRun, TemperatureAlert,
	PartDefinition, Equipment, CartridgeRecord, ReagentBatchRecord,
	ReceivingLot, CalibrationRecord, ServiceTicket, TemperatureReading,
	WorkInstruction, LotRecord, InventoryTransaction, AskBimsCostLog
} from './db';
import { getCheckedOutCartridgeIds } from './checkout-utils';
import { TIER_1_REFERENCE } from './ask-bims-tier1';
import { searchDocs } from './docs-search';
import { lookupEquipment } from './equipment-datasheets';

/**
 * Denied collections (principle #9 — never queryable through Ask BIMS):
 *   - User, Session, InviteToken (auth)
 *   - ElectronicSignature (legal artifact)
 *   - Integration, WebhookLog (credentials/tokens)
 *   - DeviceLog (may contain device tokens)
 * Enforcement is structural: no tool below queries these collections. Adding a
 * tool that touches them is a code-review block.
 */

/**
 * Tool kill-switch — env var ASK_BIMS_DISABLED_TOOLS is a comma-separated list
 * of tool names that will be filtered OUT before sending to Claude. Set this
 * via Vercel env to disable a buggy tool without a code deploy.
 * Example: ASK_BIMS_DISABLED_TOOLS=trace_cartridge,find_receiving_lot
 */
function getDisabledTools(): Set<string> {
	const raw = process.env.ASK_BIMS_DISABLED_TOOLS ?? '';
	return new Set(raw.split(',').map(s => s.trim()).filter(Boolean));
}

/**
 * Per-question cost cap, in USD. Defense in depth on top of MAX_ITERATIONS and
 * max_tokens. Opus 4.7 is the only model expensive enough to justify a cap on
 * realistic questions; Haiku/Sonnet floor at fractions of a cent.
 *
 * Override via env: ASK_BIMS_MAX_COST_OPUS (USD).
 */
const MAX_COST_OPUS_USD = Number(process.env.ASK_BIMS_MAX_COST_OPUS ?? 5);

/**
 * Per-user-per-day spend caps. When a user hits their cap on a model, new
 * requests on that model are rejected with a 429 until midnight (server local).
 * The workspace cap is the sum of ALL users' spend; if hit, NO requests on
 * any model proceed until midnight.
 *
 * Override via env:
 *   ASK_BIMS_DAILY_CAP_HAIKU_USD  (default 1)
 *   ASK_BIMS_DAILY_CAP_SONNET_USD (default 2)
 *   ASK_BIMS_DAILY_CAP_OPUS_USD   (default 5)
 *   ASK_BIMS_DAILY_CAP_WORKSPACE_USD (default 20)
 */
export const DAILY_CAPS = {
	'claude-haiku-4-5':   Number(process.env.ASK_BIMS_DAILY_CAP_HAIKU_USD ?? 1),
	'claude-sonnet-4-6':  Number(process.env.ASK_BIMS_DAILY_CAP_SONNET_USD ?? 2),
	'claude-opus-4-7':    Number(process.env.ASK_BIMS_DAILY_CAP_OPUS_USD ?? 5)
} as const;
export const WORKSPACE_DAILY_CAP_USD = Number(process.env.ASK_BIMS_DAILY_CAP_WORKSPACE_USD ?? 20);

function startOfTodayUtc(): Date {
	const d = new Date();
	d.setUTCHours(0, 0, 0, 0);
	return d;
}

/**
 * Check whether a user is allowed to make a request right now. Returns null
 * if allowed, or a {reason, capUsd, spentUsd} object if rejected.
 *
 * Should be called from the API endpoint BEFORE invoking askBims.
 */
export interface CapDenial {
	scope: 'user' | 'workspace';
	model?: AskBimsModel;
	capUsd: number;
	spentUsd: number;
	resetsAt: string;
}

export async function checkDailyCap(userId: string, model: AskBimsModel): Promise<CapDenial | null> {
	await connectDB();
	const since = startOfTodayUtc();
	const tomorrow = new Date(since.getTime() + 86400e3);

	const [userOnModel, workspace] = await Promise.all([
		AskBimsCostLog.aggregate([
			{ $match: { userId, model, timestamp: { $gte: since } } },
			{ $group: { _id: null, total: { $sum: '$costUsd' } } }
		]),
		AskBimsCostLog.aggregate([
			{ $match: { timestamp: { $gte: since } } },
			{ $group: { _id: null, total: { $sum: '$costUsd' } } }
		])
	]);

	const userSpent = userOnModel[0]?.total ?? 0;
	const userCap = DAILY_CAPS[model];
	if (userSpent >= userCap) {
		return { scope: 'user', model, capUsd: userCap, spentUsd: userSpent, resetsAt: tomorrow.toISOString() };
	}

	const workspaceSpent = workspace[0]?.total ?? 0;
	if (workspaceSpent >= WORKSPACE_DAILY_CAP_USD) {
		return { scope: 'workspace', capUsd: WORKSPACE_DAILY_CAP_USD, spentUsd: workspaceSpent, resetsAt: tomorrow.toISOString() };
	}

	return null;
}

async function logCostTelemetry(entry: {
	userId: string;
	username?: string;
	model: AskBimsModel;
	usage: { inputTokens: number; outputTokens: number; cacheReadTokens: number; cacheWriteTokens: number };
	costUsd: number;
	toolCallCount: number;
	uniqueToolCount: number;
	durationMs: number;
	errorClass?: string;
}): Promise<void> {
	try {
		await AskBimsCostLog.create({
			userId: entry.userId,
			username: entry.username,
			timestamp: new Date(),
			model: entry.model,
			inputTokens: entry.usage.inputTokens,
			outputTokens: entry.usage.outputTokens,
			cacheReadTokens: entry.usage.cacheReadTokens,
			cacheWriteTokens: entry.usage.cacheWriteTokens,
			costUsd: entry.costUsd,
			toolCallCount: entry.toolCallCount,
			uniqueToolCount: entry.uniqueToolCount,
			durationMs: entry.durationMs,
			errorClass: entry.errorClass
		});
	} catch (err) {
		console.error('[ASK-BIMS] cost log write failed (non-fatal):', err);
	}
}

/**
 * PII redaction — currently a no-op stub. The roadmap (Phase 6.1) calls for
 * NER-based redaction OR an allowlist-based approach; either needs design
 * work before being safe. Until then, conversation logging is OFF.
 *
 * When PII policy is decided, replace this function body and start logging
 * (see `AgentConversationLog` model — TBD per D7 schema-addition contract).
 */
export function redactPii(text: string): string {
	if (process.env.ASK_BIMS_PII_REDACTION_ENABLED === '1') {
		// TODO Phase 6.1 — implement NER or allowlist redaction.
		// For now, conservative passthrough rather than risk over-redacting
		// operationally meaningful terms ("Robot Two", "QC Pending", etc.)
		return text;
	}
	return text;
}

export type AskBimsModel = 'claude-haiku-4-5' | 'claude-sonnet-4-6' | 'claude-opus-4-7';

export const ALLOWED_MODELS: AskBimsModel[] = ['claude-haiku-4-5', 'claude-sonnet-4-6', 'claude-opus-4-7'];
// Default flipped from Sonnet to Haiku based on 13-prompt × 3-model comparison
// (2026-05-05): Haiku gave operationally-equivalent answers on 11/13 prompts
// at 3-5× lower cost. See tests/ask-bims/comprehensive-results.json for the
// raw evidence and scripts/comprehensive-compare.ts to reproduce.
export const DEFAULT_MODEL: AskBimsModel = 'claude-haiku-4-5';

// USD per million tokens (Anthropic 1P API rates as of 2026-05)
const PRICING: Record<AskBimsModel, { input: number; cacheWrite5m: number; cacheRead: number; output: number }> = {
	'claude-haiku-4-5':   { input: 1.0, cacheWrite5m: 1.25, cacheRead: 0.10, output: 5.0 },
	'claude-sonnet-4-6':  { input: 3.0, cacheWrite5m: 3.75, cacheRead: 0.30, output: 15.0 },
	'claude-opus-4-7':    { input: 5.0, cacheWrite5m: 6.25, cacheRead: 0.50, output: 25.0 }
};

let _client: Anthropic | null = null;
function getClient(): Anthropic | null {
	if (_client) return _client;
	const apiKey = process.env.ANTHROPIC_API_KEY;
	if (!apiKey) return null;
	_client = new Anthropic({ apiKey });
	return _client;
}

// Domain constants — keep in sync with manufacturing/wax-filling code paths
const WAX_TUBE_PART_NUMBER = 'PT-CT-114';
const FULL_TUBE_VOLUME_UL = 12000;

const TOOLS: Anthropic.Tool[] = [
	{
		name: 'get_wax_tube_inventory',
		description: `**Source of truth** for current 15ml wax tube inventory.
Queries: ReceivingLot where part.partNumber = ${WAX_TUBE_PART_NUMBER} and status in (accepted, in_progress). Computes per-lot remaining volume from quantity × ${FULL_TUBE_VOLUME_UL} μL minus consumedUl.

Use when: "how much wax do we have", "wax inventory", "wax runway", "will we run out of wax", "what wax is in stock".
Don't use for: in-house produced wax production records — those live in WaxBatch (see list_legacy_wax_batches).`,
		input_schema: {
			type: 'object',
			properties: {
				maxRemainingUl: { type: 'number', description: 'Only return lots with remainingVolumeUl <= this' },
				limit: { type: 'number', description: 'Max results (default 20, capped at 50)' }
			}
		}
	},
	{
		name: 'list_legacy_wax_batches',
		description: `**Legacy / non-authoritative** — in-house wax production records from the WaxBatch model. Most BIMS deployments have migrated to ReceivingLot-tracked tubes; these records are largely orphan or test data unless the operator explicitly mentions in-house wax production.

Use only when: user explicitly asks about in-house wax production OR about a specific WAX-... batch number.
Don't use for: general "how much wax do we have" — use get_wax_tube_inventory instead.`,
		input_schema: {
			type: 'object',
			properties: {
				maxRemainingUl: { type: 'number' },
				limit: { type: 'number' }
			}
		}
	},
	{
		name: 'get_temperature_alerts',
		description: `Temperature alerts (high_temp, low_temp, lost_connection) raised by Mocreo sensors and other temperature-monitored equipment.
Source: TemperatureAlert model.

Use when: "temperature alerts", "what's out of spec", "what alerted today", "unacknowledged alerts".`,
		input_schema: {
			type: 'object',
			properties: {
				sinceHours: { type: 'number', description: 'Only alerts from the last N hours (default 24)' },
				alertType: { type: 'string', description: 'One of: high_temp, low_temp, lost_connection' },
				onlyUnacknowledged: { type: 'boolean' },
				limit: { type: 'number' }
			}
		}
	},
	{
		name: 'get_current_temperatures',
		description: `Current temperature reading per fridge/oven.
Source: Equipment model — currentTemperatureC field, populated from Mocreo sync.

Use when: "what is the temperature of X right now", "current temps", "is fridge X at the right temp".
Caveat: lastTemperatureReadAt may be stale if a sensor lost connection — surface that in the answer.`,
		input_schema: {
			type: 'object',
			properties: {
				sensorName: { type: 'string', description: 'Optional partial name match (case-insensitive)' }
			}
		}
	},
	{
		name: 'list_recent_runs',
		description: `Recent manufacturing runs (wax filling and reagent filling).
Source: WaxFillingRun and ReagentBatchRecord models.

Use when: "recent runs", "what ran today", "show aborted runs", "what's running right now".

IMPORTANT: Default sinceHours is 168 (one week) — large enough that "most recent X" questions resolve in one call. If this returns no matching runs, ACCEPT the result and tell the user. Do NOT call this tool again with a wider window — that's an anti-redundancy violation.`,
		input_schema: {
			type: 'object',
			properties: {
				runType: { type: 'string', description: 'wax_filling | reagent_filling | any (default)' },
				status: { type: 'string', description: 'completed | aborted | running | etc' },
				sinceHours: { type: 'number', description: 'Default 168 (one week). Use 24 only when user explicitly asks about today.' },
				limit: { type: 'number' }
			}
		}
	},
	{
		name: 'list_low_inventory_parts',
		description: `Parts with inventory below their reorder threshold.
Source: PartDefinition.inventoryCount vs PartDefinition.minimumOrderQty.

Use when: "what do I need to reorder", "low inventory", "running low".
Caveat: PartDefinition.inventoryCount is a denormalized counter; the operational truth for any specific part is the sum of accepted ReceivingLots minus consumption.`,
		input_schema: {
			type: 'object',
			properties: {
				percentThreshold: { type: 'number', description: 'inventoryCount <= minimumOrderQty * (1 + pct/100). Default 20%.' }
			}
		}
	},
	{
		name: 'find_part',
		description: `Look up a PartDefinition (the part catalog: PT-CT-XXX) by partNumber, name, or barcode.
Source: PartDefinition model — items in the part catalog ONLY.

Use when: "tell me about PT-CT-104", "what's part X", "lookup barcode YYY" where YYY is a part barcode.
Don't use for: receiving-lot IDs (UUID-style like 74b942a2-...) or wax tube lots — those are NOT part definitions and won't be found here. Use find_receiving_lot for those.`,
		input_schema: {
			type: 'object',
			properties: {
				query: { type: 'string', description: 'partNumber (PT-CT-XXX), name fragment, or part barcode — NOT a UUID lot ID' }
			},
			required: ['query']
		}
	},
	{
		name: 'find_receiving_lot',
		description: `Look up a ReceivingLot by lotId (often UUID), bagBarcode, or lotNumber. Returns part info, quantity, consumption, status, supplier lot, receiving date.
Source: ReceivingLot model — physical received material lots, NOT the part catalog.

Use when: user mentions a UUID-style ID, a bag barcode, or asks "is lot X real / what's in lot X / who supplied lot X".
Don't use for: part catalog questions (use find_part for PT-CT-XXX entries).`,
		input_schema: {
			type: 'object',
			properties: {
				query: { type: 'string', description: 'lotId, bagBarcode, or lotNumber — case-sensitive' }
			},
			required: ['query']
		}
	},
	{
		name: 'find_cartridges',
		description: `Find cartridges by ID, status, or runId.
Source: CartridgeRecord model.

Use when: "find cart X", "show cartridges in status Y", "cartridges from run Z".`,
		input_schema: {
			type: 'object',
			properties: {
				cartridgeId: { type: 'string' },
				status: { type: 'string', description: 'backing | wax_filling | wax_stored | reagent_filled | etc.' },
				runId: { type: 'string', description: 'Filter to cartridges produced by a specific WaxFillingRun' },
				limit: { type: 'number' }
			}
		}
	},
	{
		name: 'list_equipment',
		description: `Equipment registry (fridges, ovens, decks, robots).
Source: Equipment model.

Use when: "list equipment", "what fridges do we have", "is robot X online".`,
		input_schema: {
			type: 'object',
			properties: {
				equipmentType: { type: 'string', description: 'fridge | oven | deck | robot | etc.' }
			}
		}
	},
	{
		name: 'get_run_yield',
		description: `Yield breakdown (accepted/scrapped/pending QC) for a wax filling run.
Source: WaxFillingRun + CartridgeRecord.waxQc.status for each cartridgeId in the run.

Use when: "yield on run X", "scrap rate for run Y", "QC results for run Z".`,
		input_schema: {
			type: 'object',
			properties: {
				runId: { type: 'string', description: 'WaxFillingRun _id' }
			},
			required: ['runId']
		}
	},
	{
		name: 'trace_cartridge',
		description: `Full lineage trace for a single cartridge — backing lot, wax run, wax source lot, QC outcome, storage location, reagent run if any.
Source: CartridgeRecord + joined data from WaxFillingRun, WaxBatch (legacy), ReceivingLot.

Use when: "trace cart X", "where did this cart come from", "what lots went into cart Y".
Caveat: waxFilling.waxSourceLot is optional in WaxFillingRun and may be null on older runs — flag this if encountered.`,
		input_schema: {
			type: 'object',
			properties: {
				cartridgeId: { type: 'string' }
			},
			required: ['cartridgeId']
		}
	},
	{
		name: 'count_cartridges_by_status',
		description: `Count cartridges grouped by status, optionally filtered to a recent time window.
Source: CartridgeRecord aggregation.

Use when: "how many cartridges did we make today", "current state of the floor", "cart counts".`,
		input_schema: {
			type: 'object',
			properties: {
				sinceHours: { type: 'number', description: 'Only count cartridges created in the last N hours (default: all-time)' }
			}
		}
	},
	{
		name: 'get_run_details',
		description: `Full record for one wax-filling or reagent-filling run by runId. Includes operator, robot, deck, cartridge IDs, status, abort reasons, notes, runStart/runEnd.
Source: WaxFillingRun OR ReagentBatchRecord (auto-detected by ID).

Use when: "tell me about run X", "what happened in run Y", "details for runId Z".
Don't use for: yield breakdown (use get_run_yield) or listing recent runs (use list_recent_runs).`,
		input_schema: {
			type: 'object',
			properties: { runId: { type: 'string' } },
			required: ['runId']
		}
	},
	{
		name: 'list_active_runs',
		description: `Runs currently in non-terminal status across wax filling, reagent filling, and WI-01 backing.
Source: WaxFillingRun + ReagentBatchRecord + LotRecord (statuses NOT in [completed, aborted, voided]).

Use when: "what's running now", "active runs", "what's on the floor right now".`,
		input_schema: { type: 'object', properties: {} }
	},
	{
		name: 'list_cartridges_in_storage',
		description: `Cartridges currently in wax_stored status, optionally filtered to a fridge.
Source: CartridgeRecord with status=wax_stored.

Use when: "what's in storage", "carts in the freezer", "stored carts in fridge X".`,
		input_schema: {
			type: 'object',
			properties: {
				fridgeId: { type: 'string', description: 'Equipment._id of the fridge (optional)' },
				limit: { type: 'number', description: 'Default 50, capped at 500' }
			}
		}
	},
	{
		name: 'list_calibrations_due',
		description: `Equipment with nextCalibrationDue within the window (default 30 days ahead).
Source: CalibrationRecord (most recent per equipment).

Use when: "what's due for calibration", "upcoming calibrations", "what needs recalibrating".`,
		input_schema: {
			type: 'object',
			properties: {
				daysAhead: { type: 'number', description: 'Window in days (default 30)' },
				equipmentType: { type: 'string', description: 'Filter by type — magnetometer, thermocouple, lux, spectrophotometer, etc.' }
			}
		}
	},
	{
		name: 'get_temperature_history',
		description: `Time-series temperature readings for one sensor, with min/max/avg summary and up to 50 sample points.
Source: TemperatureReading (joined to Equipment by name).

Use when: "temperature history of X", "show last 24h temps for fridge Y", "how stable was the temp".`,
		input_schema: {
			type: 'object',
			properties: {
				equipmentName: { type: 'string', description: 'Sensor or equipment name (case-insensitive partial match)' },
				sinceHours: { type: 'number', description: 'Window in hours (default 24, max 168)' }
			},
			required: ['equipmentName']
		}
	},
	{
		name: 'forward_genealogy',
		description: `Given a ReceivingLot, list every cartridge that consumed material from it (backing, wax, reagent paths).
Source: CartridgeRecord scanned across backing.lotId, waxFilling.runId→WaxFillingRun.waxSourceLot, reagentFilling.runId→ReagentBatchRecord.tubeRecords.

Use when: "if this lot was bad, what's downstream", "what carts used lot X", recall scenarios.
Cap: 50 cartridges per consumption path; truncated:true if exceeded.`,
		input_schema: {
			type: 'object',
			properties: { receivingLotId: { type: 'string', description: 'ReceivingLot.lotId, bagBarcode, or _id' } },
			required: ['receivingLotId']
		}
	},
	{
		name: 'backward_genealogy',
		description: `Full upstream lineage of one cartridge: backing lot, backing oven, wax run, wax source lot, wax QC, storage location, reagent run, reagent assay, reagent lots, shipment, customer.
Source: CartridgeRecord with multi-hop joins to BackingLot, WaxFillingRun, ReceivingLot, ReagentBatchRecord, ShippingLot.

Use when: deep traceability, "where did everything in this cart come from", regulatory audits.
For a quick trace (without shipment/customer details), use trace_cartridge instead.`,
		input_schema: {
			type: 'object',
			properties: { cartridgeId: { type: 'string' } },
			required: ['cartridgeId']
		}
	},
	{
		name: 'check_data_integrity',
		description: `Run a system-wide data-integrity scan. Counts known anomalies: runs with null waxSourceLot, over-consumed receiving lots (consumedUl > capacity), stale equipment temperature reads (>4h), cartridges stuck in non-terminal status (>7d).
Source: aggregated across CartridgeRecord, WaxFillingRun, ReceivingLot, Equipment.

Use when: data quality audit, "are there any data issues", before answering high-stakes questions to verify data is sane. Call this preemptively if you suspect data issues affect your answer.`,
		input_schema: {
			type: 'object',
			properties: {}
		}
	},
	{
		name: 'production_throughput',
		description: `Daily cartridge throughput — counts cartridges that entered each phase (backing, wax filling, QC accepted, reagent filled, shipped) per day over a window.
Source: CartridgeRecord aggregation by phase-transition timestamps.

Use when: "throughput trend", "how many carts per day this week", "are we keeping up".`,
		input_schema: {
			type: 'object',
			properties: {
				sinceDays: { type: 'number', description: 'Window in days (default 7, max 90)' }
			}
		}
	},
	{
		name: 'temperature_excursion_summary',
		description: `Time out-of-spec, # of alerts, and longest excursion for one piece of equipment over a window.
Source: TemperatureReading + Equipment.temperatureMin/Max + TemperatureAlert.

Use when: "how often was X out of spec", "temperature stability of Y", "excursions on Z this week".`,
		input_schema: {
			type: 'object',
			properties: {
				equipmentName: { type: 'string', description: 'Equipment name (case-insensitive partial match)' },
				sinceDays: { type: 'number', description: 'Window in days (default 7, max 30)' }
			},
			required: ['equipmentName']
		}
	},
	{
		name: 'inventory_burn_rate',
		description: `Consumption velocity (units/day) for one part over a window, with stdev and projected days-to-empty given current inventory.
Source: InventoryTransaction (consumption events) + PartDefinition.inventoryCount.

Use when: "how fast are we using X", "burn rate for Y", "when will we run out of Z".`,
		input_schema: {
			type: 'object',
			properties: {
				partNumber: { type: 'string', description: 'PT-CT-XXX style part number' },
				sinceDays: { type: 'number', description: 'Window in days (default 14, max 90)' }
			},
			required: ['partNumber']
		}
	},
	{
		name: 'runway',
		description: `Projected days-to-stockout for one part — combines current inventory (PartDefinition.inventoryCount or ReceivingLot sum) with inventory_burn_rate calculation.
Source: PartDefinition + InventoryTransaction.

Use when: "how long will X last", "runway for Y", "do we have enough Z for next month".`,
		input_schema: {
			type: 'object',
			properties: {
				partNumber: { type: 'string' },
				windowDays: { type: 'number', description: 'Days of history for burn-rate calc (default 14)' }
			},
			required: ['partNumber']
		}
	},
	{
		name: 'bulk_run_yields',
		description: `Yield breakdown across MANY wax filling runs in ONE call. Returns one row per run with operator, robot, runEndTime, cartridge counts (accepted/scrapped/pendingQc/total), and yieldPct.
Source: WaxFillingRun + CartridgeRecord aggregated server-side.

Use INSTEAD of calling get_run_yield in a loop. Saves 10-25× on questions like "yield by robot last week", "yield trend", "compare runs".
Use when: any multi-run yield question, trend analysis, robot/operator comparison.
Don't use for: single-run yield (use get_run_yield).`,
		input_schema: {
			type: 'object',
			properties: {
				sinceDays: { type: 'number', description: 'Window in days (default 14, max 90)' },
				robot: { type: 'string', description: 'Optional filter — robot name' },
				operator: { type: 'string', description: 'Optional filter — operator username' },
				status: { type: 'string', description: 'Optional filter — run status (default: completed)' },
				limit: { type: 'number', description: 'Max runs returned (default 100, max 500)' }
			}
		}
	},
	{
		name: 'whats_blocking_run',
		description: `Diagnostic — for one wax run currently in non-terminal status, identifies what's blocking forward progress: deck locked? cooling tray locked? wax source consumed? waiting on QC?
Source: WaxFillingRun + Equipment + ReceivingLot + CartridgeRecord.waxQc.

Use when: "why isn't run X moving", "what's blocking run Y", "stuck run".`,
		input_schema: {
			type: 'object',
			properties: { runId: { type: 'string' } },
			required: ['runId'],
			cache_control: { type: 'ephemeral' }
		}
	},
	{
		name: 'search_documentation',
		description: `Full-text search across BIMS engineering docs (design notes, audits, manufacturing-flow analyses, recent fixes).
Source: docs/ tree, markdown only — allowlist excludes session/handoff/transactional notes and PRDs (PRDs describe intended work, not necessarily shipped — high hallucination risk).

Use when: "why does X work this way", "what was the recent fix for Y", "where is Z documented", design-history questions, or when the user references a doc title.
Don't use for: live data queries (use the data tools); operator SOP step lookups (use search_work_instructions); inlined TIER 1 facts you can answer from the system reference directly (don't double-fetch).
Caps: 5 results max, 200 chars per snippet, 500ms timeout. If a cap fires, the result includes a dataIntegrityNotes hint — narrow the query.`,
		input_schema: {
			type: 'object',
			properties: {
				query: { type: 'string', description: 'Search phrase (min 3 chars). Substring match, case-insensitive — try a distinctive phrase from a doc title or the body' }
			},
			required: ['query']
		}
	},
	{
		name: 'search_work_instructions',
		description: `Search work instructions (manufacturing SOPs) by document number, title, step content, or required part.
Source: WorkInstruction model — versioned procedures with steps, part requirements, tool requirements, and capture fields.

Use when: "what does WI-08 step 4 require", "show me the backing procedure", "which WIs need part PT-CT-XYZ", any operator-SOP question.
Don't use for: controlled-doc design notes (use search_documentation); completed run details (use get_run_details); BCODE assay definitions (find_part / list_equipment for the catalog side).

Default status filter is 'active'. Pass status='all' to include drafts and retired versions.

When grounding an answer in a result, cite as: "Per WI-XX (v<N>, effective YYYY-MM-DD) step <Y>: ..." — surface document number, version, effective date, and step number.`,
		input_schema: {
			type: 'object',
			properties: {
				query: { type: 'string', description: 'WI document number (e.g. "WI-01"), title fragment, or step keyword' },
				partNumber: { type: 'string', description: 'Optional — filter to WIs whose current-version steps require this part (e.g. PT-CT-114)' },
				status: { type: 'string', description: 'one of: active | draft | retired | all (default: active)' },
				limit: { type: 'number', description: 'Max WIs returned (default 5, max 20)' }
			},
			required: ['query']
		}
	},
	{
		name: 'lookup_equipment_datasheet',
		description: `Look up equipment specs (size, power, location, manufacturer datasheet URL) from the BT and Fannin equipment lists.
Source: data/equipment-datasheets/*.csv (bundled at build time). Each row has Tag # (e.g. B-01, F-12, E-94), Equipment name, Bench/Floor, Location, dimensions (W/D/H), Power (V), Watts, Amps, Generator flag, Notes, Total Linch, Datasheet URL, and (Fannin only) Status / Confidence % / Claude Comments.

Use when: "what's the power draw for fridge X", "spec sheet for the Nuaire incubator", "where is equipment B-04 located", "is this on the generator", "which lab has the biosafety cabinet".
Don't use for: live equipment temperature/status (use get_current_temperatures or list_equipment); calibration history (use list_calibrations_due); generic equipment registry (use list_equipment).

PDFs are NOT bundled in this phase — manufacturer datasheets are linked via the Datasheet URL field on each row. Pass that URL through verbatim when citing.

Caps: 10 results, 500ms timeout. If the query is too broad and matches everything, narrow to a Tag # or a distinctive equipment-name word.`,
		input_schema: {
			type: 'object',
			properties: {
				equipmentName: { type: 'string', description: 'Equipment name fragment, Tag # (e.g. "B-01", "F-12"), or any cell value (case-insensitive substring across all columns)' }
			},
			required: ['equipmentName']
		}
	}
];

interface ToolResult {
	[key: string]: unknown;
	source?: string;
	sourceUrl?: string;
	dataIntegrityNotes?: string[];
}

async function runTool(name: string, input: any): Promise<ToolResult> {
	await connectDB();
	switch (name) {
		case 'get_wax_tube_inventory': {
			const filter: any = { 'part.partNumber': WAX_TUBE_PART_NUMBER, status: { $in: ['accepted', 'in_progress'] } };
			const limit = Math.min(input.limit ?? 20, 50);
			const lots = await ReceivingLot.find(filter)
				.select('lotId lotNumber bagBarcode quantity consumedUl status part createdAt')
				.sort({ createdAt: -1 })
				.limit(limit)
				.lean() as any[];

			let totalRemainingUl = 0;
			let totalTubesRemaining = 0;
			const items = lots.map(l => {
				const tubeCount = Number(l.quantity ?? 0);
				const consumedUl = Number(l.consumedUl ?? 0);
				const totalUl = tubeCount * FULL_TUBE_VOLUME_UL;
				const remainingUl = Math.max(0, totalUl - consumedUl);
				const tubesUsed = Math.floor(consumedUl / FULL_TUBE_VOLUME_UL);
				const tubesRemaining = Math.max(0, tubeCount - tubesUsed);
				totalRemainingUl += remainingUl;
				totalTubesRemaining += tubesRemaining;
				return {
					lotId: l.lotId,
					lotNumber: l.lotNumber,
					bagBarcode: l.bagBarcode,
					tubesOriginal: tubeCount,
					tubesRemaining,
					remainingVolumeUl: remainingUl,
					initialVolumeUl: totalUl,
					consumedUl,
					status: l.status,
					createdAt: l.createdAt
				};
			});

			const filtered = input.maxRemainingUl != null ? items.filter(i => i.remainingVolumeUl <= input.maxRemainingUl) : items;

			return {
				lots: filtered,
				summary: {
					lotCount: filtered.length,
					totalTubesRemaining,
					totalRemainingUl
				},
				source: `ReceivingLot where part.partNumber=${WAX_TUBE_PART_NUMBER}, status in (accepted, in_progress)`,
				sourceUrl: '/parts'
			};
		}
		case 'list_legacy_wax_batches': {
			const filter: any = {};
			if (input.maxRemainingUl != null) filter.remainingVolumeUl = { $lte: input.maxRemainingUl };
			const limit = Math.min(input.limit ?? 20, 50);
			const batches = await WaxBatch.find(filter).sort({ remainingVolumeUl: 1 }).limit(limit).lean() as any[];

			const notes: string[] = [];
			if (batches.length > 0) {
				notes.push('WaxBatch records are legacy / in-house production. They are NOT the source of truth for current operational wax inventory — that lives in ReceivingLot for PT-CT-114 tubes. Only treat these as authoritative if the user explicitly asked about in-house wax production.');
			}

			return {
				batches: batches.map(b => ({
					lotNumber: b.lotNumber,
					lotBarcode: b.lotBarcode,
					remainingVolumeUl: b.remainingVolumeUl,
					initialVolumeUl: b.initialVolumeUl,
					fullTubeCount: b.fullTubeCount,
					createdAt: b.createdAt,
					createdBy: b.createdBy?.username
				})),
				source: 'WaxBatch model — LEGACY in-house wax production records',
				sourceUrl: '/parts',
				dataIntegrityNotes: notes
			};
		}
		case 'get_temperature_alerts': {
			const filter: any = {};
			const sinceHours = input.sinceHours ?? 24;
			filter.timestamp = { $gte: new Date(Date.now() - sinceHours * 3600e3) };
			if (input.alertType) filter.alertType = input.alertType;
			if (input.onlyUnacknowledged) filter.acknowledged = false;
			const limit = Math.min(input.limit ?? 20, 100);
			const alerts = await TemperatureAlert.find(filter).sort({ timestamp: -1 }).limit(limit).lean() as any[];
			return {
				alerts: alerts.map(a => ({
					sensorName: a.sensorName, alertType: a.alertType,
					threshold: a.threshold, actualValue: a.actualValue,
					equipmentName: a.equipmentName,
					acknowledged: a.acknowledged, timestamp: a.timestamp
				})),
				source: 'TemperatureAlert model',
				sourceUrl: '/equipment/activity'
			};
		}
		case 'get_current_temperatures': {
			const eqFilter: any = { equipmentType: { $in: ['fridge', 'oven'] }, currentTemperatureC: { $exists: true } };
			if (input.sensorName) eqFilter.name = { $regex: input.sensorName, $options: 'i' };
			const eq = await Equipment.find(eqFilter).select('name currentTemperatureC lastTemperatureReadAt temperatureMinC temperatureMaxC').lean() as any[];

			const notes: string[] = [];
			const stale = eq.filter(e => {
				if (!e.lastTemperatureReadAt) return true;
				return Date.now() - new Date(e.lastTemperatureReadAt).getTime() > 60 * 60 * 1000; // > 1 hour
			});
			if (stale.length > 0) {
				notes.push(`${stale.length} equipment record(s) have lastTemperatureReadAt > 1 hour old — sensor may have lost connection. Names: ${stale.map(e => e.name).join(', ')}`);
			}

			return {
				equipment: eq.map(e => ({
					name: e.name,
					currentTemperatureC: e.currentTemperatureC,
					lastReadAt: e.lastTemperatureReadAt,
					targetRange: e.temperatureMinC != null ? `${e.temperatureMinC} to ${e.temperatureMaxC}°C` : null
				})),
				source: 'Equipment.currentTemperatureC (synced from Mocreo)',
				sourceUrl: '/equipment/activity',
				dataIntegrityNotes: notes
			};
		}
		case 'list_recent_runs': {
			const sinceHours = input.sinceHours ?? 168;
			const since = new Date(Date.now() - sinceHours * 3600e3);
			const limit = Math.min(input.limit ?? 20, 50);
			const filter: any = { createdAt: { $gte: since } };
			if (input.status) filter.status = input.status;

			const waxRuns = input.runType === 'reagent_filling' ? [] : await WaxFillingRun.find(filter).sort({ createdAt: -1 }).limit(limit).lean();
			const reagentRuns = input.runType === 'wax_filling' ? [] : await ReagentBatchRecord.find(filter).sort({ createdAt: -1 }).limit(limit).lean().catch(() => []);

			const wf = (waxRuns as any[]).map(r => ({
				runId: r._id, status: r.status, robot: r.robot?.name,
				operator: r.operator?.username, cartridgeCount: r.cartridgeIds?.length ?? 0,
				waxSourceLot: r.waxSourceLot ?? null,
				runStartTime: r.runStartTime, runEndTime: r.runEndTime
			}));
			const notes: string[] = [];
			const nullSource = wf.filter(r => r.status === 'completed' && !r.waxSourceLot);
			if (nullSource.length > 0) {
				notes.push(`${nullSource.length} completed wax run(s) have null waxSourceLot — wax-source traceability is incomplete for these. RunIds: ${nullSource.map(r => r.runId).slice(0, 5).join(', ')}${nullSource.length > 5 ? '…' : ''}`);
			}

			return {
				waxFilling: wf,
				reagentFilling: (reagentRuns as any[]).map(r => ({
					runId: r._id, status: r.status, robot: r.robot?.name,
					operator: r.operator?.username
				})),
				source: 'WaxFillingRun + ReagentBatchRecord',
				sourceUrl: '/manufacturing',
				dataIntegrityNotes: notes
			};
		}
		case 'list_low_inventory_parts': {
			const pct = input.percentThreshold ?? 20;
			const parts = await PartDefinition.find({
				$expr: {
					$and: [
						{ $gt: ['$minimumOrderQty', 0] },
						{ $lte: ['$inventoryCount', { $multiply: ['$minimumOrderQty', 1 + pct / 100] }] }
					]
				}
			}).select('partNumber name inventoryCount minimumOrderQty unitOfMeasure supplier').limit(50).lean() as any[];
			return {
				parts,
				source: 'PartDefinition.inventoryCount vs minimumOrderQty',
				sourceUrl: '/parts',
				dataIntegrityNotes: ['inventoryCount is a denormalized counter on PartDefinition. For high-stakes decisions, verify against ReceivingLot data on the linked /parts page.']
			};
		}
		case 'find_part': {
			const q = input.query;
			// Detect UUID-style queries — those are ReceivingLot IDs, not parts
			const looksLikeUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(q);
			if (looksLikeUuid) {
				return {
					parts: [],
					source: 'PartDefinition model — query rejected',
					sourceUrl: '/parts',
					dataIntegrityNotes: [`The query "${q}" looks like a ReceivingLot ID (UUID), not a part number. find_part queries the part catalog only. Use find_receiving_lot to look up this lot.`]
				};
			}
			const parts = await PartDefinition.find({
				$or: [
					{ partNumber: { $regex: q, $options: 'i' } },
					{ name: { $regex: q, $options: 'i' } },
					{ barcode: q }
				]
			}).limit(10).lean() as any[];
			const first = parts[0];
			return {
				parts: parts.map(p => ({
					partId: p._id,
					partNumber: p.partNumber, name: p.name, inventoryCount: p.inventoryCount,
					unitOfMeasure: p.unitOfMeasure, supplier: p.supplier, minimumOrderQty: p.minimumOrderQty,
					barcode: p.barcode
				})),
				source: 'PartDefinition model',
				sourceUrl: first ? `/parts/${first._id}` : '/parts'
			};
		}
		case 'find_receiving_lot': {
			const q = String(input.query ?? '').trim();
			if (!q) return { error: 'query required', source: 'ReceivingLot', sourceUrl: '/parts' };
			const lot = await ReceivingLot.findOne({
				$or: [
					{ lotId: q },
					{ bagBarcode: q },
					{ lotNumber: q }
				]
			})
				.select('_id lotId lotNumber bagBarcode quantity consumedUl status part createdAt')
				.lean() as any;
			if (!lot) {
				return {
					found: false,
					query: q,
					source: 'ReceivingLot model — searched lotId, bagBarcode, lotNumber',
					sourceUrl: '/parts',
					dataIntegrityNotes: [`No ReceivingLot matches "${q}". This could be a typo, a legacy/deleted lot, or a lot recorded in a manufacturing run that was never inducted via receiving.`]
				};
			}
			const tubeCount = Number(lot.quantity ?? 0);
			const consumedUl = Number(lot.consumedUl ?? 0);
			const isWaxTube = lot.part?.partNumber === WAX_TUBE_PART_NUMBER;
			return {
				found: true,
				lotId: lot.lotId,
				lotNumber: lot.lotNumber,
				bagBarcode: lot.bagBarcode,
				part: lot.part ? { partNumber: lot.part.partNumber, name: lot.part.name } : null,
				quantity: tubeCount,
				consumedUl,
				remainingVolumeUl: isWaxTube ? Math.max(0, tubeCount * FULL_TUBE_VOLUME_UL - consumedUl) : null,
				status: lot.status,
				createdAt: lot.createdAt,
				source: 'ReceivingLot model',
				sourceUrl: '/parts'
			};
		}
		case 'find_cartridges': {
			const filter: any = {};
			if (input.cartridgeId) filter._id = input.cartridgeId;
			if (input.status) filter.status = input.status;
			if (input.runId) filter['waxFilling.runId'] = input.runId;
			const limit = Math.min(input.limit ?? 20, 50);
			const carts = await CartridgeRecord.find(filter).sort({ createdAt: -1 }).limit(limit).lean() as any[];
			const single = carts.length === 1 ? carts[0] : null;
			return {
				cartridges: carts.map(c => ({
					cartridgeId: c._id, status: c.status,
					backingLot: c.backing?.lotId,
					waxRunId: c.waxFilling?.runId,
					qcStatus: c.waxQc?.status,
					storageLocation: c.waxStorage?.location,
					createdAt: c.createdAt
				})),
				source: 'CartridgeRecord model',
				sourceUrl: single ? `/cartridges/${single._id}` : '/cartridge-admin'
			};
		}
		case 'list_equipment': {
			const filter: any = {};
			if (input.equipmentType) filter.equipmentType = input.equipmentType;
			const eq = await Equipment.find(filter).select('name equipmentType status currentTemperatureC lastTemperatureReadAt').lean() as any[];
			return {
				equipment: eq.map(e => ({
					name: e.name, type: e.equipmentType, status: e.status,
					currentTemperatureC: e.currentTemperatureC,
					lastTemperatureReadAt: e.lastTemperatureReadAt
				})),
				source: 'Equipment model',
				sourceUrl: '/equipment/activity'
			};
		}
		case 'get_run_yield': {
			const run = await WaxFillingRun.findById(input.runId).lean() as any;
			if (!run) return { error: `Run not found: ${input.runId}`, source: 'WaxFillingRun', sourceUrl: '/manufacturing' };
			const cartridgeIds: string[] = run.cartridgeIds ?? [];
			const checkedOutIds = await getCheckedOutCartridgeIds();
			const carts = await CartridgeRecord.find({
				_id: { $in: cartridgeIds, $nin: checkedOutIds }
			}).select('_id status waxQc.status').lean() as any[];
			const counts: Record<string, number> = {};
			let accepted = 0, scrapped = 0, pendingQc = 0;
			for (const c of carts) {
				const s = c.status ?? 'unknown';
				counts[s] = (counts[s] ?? 0) + 1;
				// Schema enum is 'Accepted' | 'Rejected' | 'Pending' (capitalized).
				// Normalize so legacy lowercase data still buckets correctly.
				const qc = String(c.waxQc?.status ?? '').toLowerCase();
				if (qc === 'accepted') accepted++;
				else if (qc === 'rejected' || qc === 'scrapped') scrapped++;
				else pendingQc++;
			}
			const total = cartridgeIds.length;
			const notes: string[] = [];
			if (!run.waxSourceLot) {
				notes.push('This run has null waxSourceLot — wax-source traceability is incomplete.');
			}
			return {
				runId: run._id,
				runStatus: run.status,
				cartridgeCount: total,
				qc: {
					accepted,
					scrapped,
					pendingQc,
					yieldPct: total > 0 ? Math.round((accepted / total) * 1000) / 10 : null
				},
				cartridgeStatusCounts: counts,
				operator: run.operator?.username,
				robot: run.robot?.name,
				waxSourceLot: run.waxSourceLot ?? null,
				runStartTime: run.runStartTime,
				runEndTime: run.runEndTime,
				source: 'WaxFillingRun + CartridgeRecord.waxQc',
				sourceUrl: `/cartridge-admin?runId=${encodeURIComponent(String(run._id))}`,
				dataIntegrityNotes: notes
			};
		}
		case 'trace_cartridge': {
			const cart = await CartridgeRecord.findById(input.cartridgeId).lean() as any;
			if (!cart) return { error: `Cartridge not found: ${input.cartridgeId}`, source: 'CartridgeRecord', sourceUrl: '/cartridge-admin' };
			let waxRun: any = null;
			if (cart.waxFilling?.runId) {
				waxRun = await WaxFillingRun.findById(cart.waxFilling.runId)
					.select('_id status operator robot waxSourceLot waxBatchId runStartTime runEndTime').lean();
			}
			let waxLot: any = null;
			if (waxRun?.waxSourceLot) {
				waxLot = await ReceivingLot.findOne({
					$or: [
						{ lotId: waxRun.waxSourceLot },
						{ bagBarcode: waxRun.waxSourceLot },
						{ lotNumber: waxRun.waxSourceLot }
					]
				}).select('lotId lotNumber bagBarcode part createdAt').lean();
			}
			let legacyWaxBatch: any = null;
			if (waxRun?.waxBatchId) {
				legacyWaxBatch = await WaxBatch.findById(waxRun.waxBatchId)
					.select('lotNumber lotBarcode createdAt').lean();
			}
			const notes: string[] = [];
			if (waxRun && !waxRun.waxSourceLot) {
				notes.push('This cartridge\'s wax run has null waxSourceLot — wax provenance cannot be traced upstream.');
			}
			return {
				cartridgeId: cart._id,
				status: cart.status,
				createdAt: cart.createdAt,
				backing: {
					lotId: cart.backing?.lotId,
					inductedAt: cart.backing?.inductedAt,
					inductedBy: cart.backing?.inductedBy?.username
				},
				waxFilling: waxRun ? {
					runId: waxRun._id,
					runStatus: waxRun.status,
					operator: waxRun.operator?.username,
					robot: waxRun.robot?.name,
					runStartTime: waxRun.runStartTime,
					runEndTime: waxRun.runEndTime,
					waxSourceLot: waxRun.waxSourceLot ?? null,
					waxReceivingLot: waxLot ? { lotId: waxLot.lotId, lotNumber: waxLot.lotNumber, bagBarcode: waxLot.bagBarcode } : null,
					legacyWaxBatch: legacyWaxBatch ? { lotNumber: legacyWaxBatch.lotNumber, lotBarcode: legacyWaxBatch.lotBarcode } : null
				} : null,
				waxQc: cart.waxQc ? {
					status: cart.waxQc.status,
					inspector: cart.waxQc.inspector?.username,
					inspectedAt: cart.waxQc.inspectedAt,
					notes: cart.waxQc.notes
				} : null,
				waxStorage: cart.waxStorage ? {
					location: cart.waxStorage.location,
					storedAt: cart.waxStorage.storedAt
				} : null,
				reagentFilling: cart.reagentFilling ? {
					runId: cart.reagentFilling.runId,
					completedAt: cart.reagentFilling.completedAt
				} : null,
				source: 'CartridgeRecord joined to WaxFillingRun, ReceivingLot (wax tube), WaxBatch (legacy)',
				sourceUrl: `/cartridges/${cart._id}`,
				dataIntegrityNotes: notes
			};
		}
		case 'count_cartridges_by_status': {
			const filter: any = {};
			if (input.sinceHours) {
				filter.createdAt = { $gte: new Date(Date.now() - input.sinceHours * 3600e3) };
			}
			const checkedOutIds = await getCheckedOutCartridgeIds();
			filter._id = { $nin: checkedOutIds };
			const agg = await CartridgeRecord.aggregate([
				{ $match: filter },
				{ $group: { _id: '$status', count: { $sum: 1 } } },
				{ $sort: { count: -1 } }
			]);
			const total = agg.reduce((s: number, g: any) => s + g.count, 0);
			return {
				total,
				byStatus: agg.map((g: any) => ({ status: g._id ?? 'unknown', count: g.count })),
				windowHours: input.sinceHours ?? 'all-time',
				source: 'CartridgeRecord aggregation',
				sourceUrl: '/cartridge-admin'
			};
		}
		case 'get_run_details': {
			const runId = String(input.runId ?? '').trim();
			if (!runId) return { error: 'runId required', source: 'WaxFillingRun', sourceUrl: '/manufacturing' };
			let run: any = await WaxFillingRun.findById(runId).lean();
			let runType = 'wax_filling';
			if (!run) {
				run = await ReagentBatchRecord.findById(runId).lean();
				runType = 'reagent_filling';
			}
			if (!run) return { error: `Run not found: ${runId}`, source: 'WaxFillingRun + ReagentBatchRecord', sourceUrl: '/manufacturing' };
			const integrityNotes: string[] = [];
			if (runType === 'wax_filling' && !run.waxSourceLot) integrityNotes.push('waxSourceLot is null on this run — wax-source traceability incomplete.');
			return {
				runType,
				runId: run._id,
				status: run.status,
				operator: run.operator?.username,
				robot: run.robot?.name,
				deckId: run.deckId,
				cartridgeIds: (run.cartridgeIds ?? []).slice(0, 50),
				cartridgeCount: run.cartridgeIds?.length ?? 0,
				waxSourceLot: run.waxSourceLot ?? null,
				assayType: run.assayType?.name,
				notes: run.notes ?? [],
				runStartTime: run.runStartTime,
				runEndTime: run.runEndTime,
				createdAt: run.createdAt,
				source: runType === 'wax_filling' ? 'WaxFillingRun' : 'ReagentBatchRecord',
				sourceUrl: `/cartridge-admin?runId=${encodeURIComponent(runId)}`,
				dataIntegrityNotes: integrityNotes
			};
		}
		case 'list_active_runs': {
			const TERMINAL = ['completed', 'aborted', 'voided', 'archived'];
			const waxRuns = await WaxFillingRun.find({ status: { $nin: TERMINAL } })
				.select('_id status operator robot deckId waxSourceLot cartridgeIds runStartTime')
				.sort({ runStartTime: -1 }).limit(20).lean() as any[];
			const reagentRuns = await ReagentBatchRecord.find({ status: { $nin: TERMINAL } })
				.select('_id status operator robot cartridgesFilled assayType')
				.sort({ createdAt: -1 }).limit(20).lean().catch(() => []) as any[];
			const lotRuns = await LotRecord.find({ status: { $nin: TERMINAL } })
				.select('_id status processConfig outputLotNumber cartridgeIds')
				.sort({ createdAt: -1 }).limit(20).lean().catch(() => []) as any[];
			return {
				waxFilling: waxRuns.map(r => ({
					runId: r._id, status: r.status, robot: r.robot?.name,
					operator: r.operator?.username, cartridgeCount: r.cartridgeIds?.length ?? 0,
					runStartTime: r.runStartTime
				})),
				reagentFilling: reagentRuns.map(r => ({
					runId: r._id, status: r.status, robot: r.robot?.name,
					operator: r.operator?.username, assay: r.assayType?.name
				})),
				wi01Backing: lotRuns.map(r => ({
					lotRecordId: r._id, status: r.status, outputLot: r.outputLotNumber,
					cartridgeCount: r.cartridgeIds?.length ?? 0
				})),
				source: 'WaxFillingRun + ReagentBatchRecord + LotRecord (status not in completed/aborted/voided/archived)',
				sourceUrl: '/manufacturing'
			};
		}
		case 'list_cartridges_in_storage': {
			const filter: any = { status: 'wax_stored' };
			if (input.fridgeId) filter['waxStorage.locationId'] = input.fridgeId;
			const limit = Math.min(input.limit ?? 50, 500);
			const carts = await CartridgeRecord.find(filter)
				.select('_id status waxStorage waxQc.status waxFilling.runId createdAt')
				.sort({ 'waxStorage.storedAt': -1 })
				.limit(limit + 1).lean() as any[];
			const truncated = carts.length > limit;
			return {
				cartridges: carts.slice(0, limit).map(c => ({
					cartridgeId: c._id,
					qcStatus: c.waxQc?.status,
					waxRunId: c.waxFilling?.runId,
					storageLocation: c.waxStorage?.location,
					storageFridgeId: c.waxStorage?.locationId,
					storedAt: c.waxStorage?.storedAt
				})),
				totalReturned: Math.min(carts.length, limit),
				truncated,
				totalAvailable: truncated ? `>${limit}` : carts.length,
				source: 'CartridgeRecord where status=wax_stored',
				sourceUrl: '/cartridge-admin/storage'
			};
		}
		case 'list_calibrations_due': {
			const daysAhead = Math.min(Math.max(Number(input.daysAhead ?? 30), 1), 365);
			const cutoff = new Date(Date.now() + daysAhead * 86400e3);
			const filter: any = {
				nextCalibrationDue: { $lte: cutoff }
			};
			const records = await CalibrationRecord.find(filter)
				.select('_id equipmentId calibrationDate nextCalibrationDue status equipmentType')
				.sort({ nextCalibrationDue: 1 })
				.limit(100).lean() as any[];

			let filtered = records;
			if (input.equipmentType) {
				filtered = records.filter(r => r.equipmentType === input.equipmentType);
			}

			// Hydrate equipment names
			const equipmentIds = [...new Set(filtered.map(r => r.equipmentId).filter(Boolean))];
			const equipment = await Equipment.find({ _id: { $in: equipmentIds } })
				.select('_id name equipmentType').lean() as any[];
			const eqMap = new Map(equipment.map(e => [e._id, e]));

			return {
				items: filtered.map(r => ({
					equipmentId: r.equipmentId,
					equipmentName: eqMap.get(r.equipmentId)?.name ?? 'unknown',
					equipmentType: r.equipmentType ?? eqMap.get(r.equipmentId)?.equipmentType,
					lastCalibrated: r.calibrationDate,
					dueDate: r.nextCalibrationDue,
					daysUntilDue: Math.round((new Date(r.nextCalibrationDue).getTime() - Date.now()) / 86400e3),
					status: r.status
				})),
				windowDays: daysAhead,
				source: 'CalibrationRecord where nextCalibrationDue <= now + windowDays',
				sourceUrl: '/equipment/activity'
			};
		}
		case 'forward_genealogy': {
			const lotIdRaw = String(input.receivingLotId ?? '').trim();
			if (!lotIdRaw) return { error: 'receivingLotId required', source: 'CartridgeRecord', sourceUrl: '/cartridge-admin' };

			// Resolve to canonical lot identifiers (lotId is the operationally referenced one)
			const lot = await ReceivingLot.findOne({
				$or: [{ _id: lotIdRaw }, { lotId: lotIdRaw }, { bagBarcode: lotIdRaw }, { lotNumber: lotIdRaw }]
			}).select('_id lotId bagBarcode lotNumber part').lean() as any;
			if (!lot) return {
				error: `ReceivingLot not found: ${lotIdRaw}`,
				source: 'ReceivingLot + CartridgeRecord',
				sourceUrl: '/parts'
			};

			const lotKeys = [lot.lotId, lot.bagBarcode, lot.lotNumber, lot._id].filter(Boolean);
			const cap = 50;

			// Path 1: backing lot direct
			const backingMatches = await CartridgeRecord.find({
				'backing.lotId': { $in: lotKeys }
			}).select('_id status createdAt').limit(cap + 1).lean() as any[];

			// Path 2: wax — find runs that used this lot, then carts in those runs
			const waxRuns = await WaxFillingRun.find({
				waxSourceLot: { $in: lotKeys }
			}).select('_id cartridgeIds').limit(50).lean() as any[];
			const waxCartIds = waxRuns.flatMap(r => r.cartridgeIds ?? []).slice(0, cap + 1);
			const waxCarts = await CartridgeRecord.find({ _id: { $in: waxCartIds } })
				.select('_id status createdAt').limit(cap + 1).lean() as any[];

			// Path 3: reagent — find batches that referenced this lot in tubeRecords
			const reagentBatches = await ReagentBatchRecord.find({
				'tubeRecords.sourceLotId': { $in: lotKeys }
			}).select('_id cartridgesFilled').limit(50).lean().catch(() => []) as any[];
			const reagentCartIds = reagentBatches.flatMap(b =>
				(b.cartridgesFilled ?? []).map((c: any) => c.cartridgeId).filter(Boolean)
			).slice(0, cap + 1);
			const reagentCarts = reagentCartIds.length > 0
				? await CartridgeRecord.find({ _id: { $in: reagentCartIds } }).select('_id status').limit(cap + 1).lean() as any[]
				: [];

			const totalUnique = new Set([
				...backingMatches.map(c => c._id),
				...waxCarts.map(c => c._id),
				...reagentCarts.map(c => c._id)
			]).size;

			return {
				lotInfo: {
					lotId: lot.lotId,
					bagBarcode: lot.bagBarcode,
					partNumber: lot.part?.partNumber,
					partName: lot.part?.name
				},
				viaBackingLot: {
					count: backingMatches.length > cap ? `>${cap}` : backingMatches.length,
					truncated: backingMatches.length > cap,
					sample: backingMatches.slice(0, 10).map(c => ({ cartridgeId: c._id, status: c.status }))
				},
				viaWaxRun: {
					runCount: waxRuns.length,
					cartridgeCount: waxCarts.length > cap ? `>${cap}` : waxCarts.length,
					truncated: waxCarts.length > cap,
					sample: waxCarts.slice(0, 10).map(c => ({ cartridgeId: c._id, status: c.status }))
				},
				viaReagentRun: {
					batchCount: reagentBatches.length,
					cartridgeCount: reagentCarts.length > cap ? `>${cap}` : reagentCarts.length,
					truncated: reagentCarts.length > cap,
					sample: reagentCarts.slice(0, 10).map(c => ({ cartridgeId: c._id, status: c.status }))
				},
				totalUniqueCartridgesAffected: totalUnique,
				source: 'CartridgeRecord scanned across backing.lotId + WaxFillingRun.waxSourceLot + ReagentBatchRecord.tubeRecords.sourceLotId',
				sourceUrl: '/cartridge-admin'
			};
		}
		case 'backward_genealogy': {
			const cartridgeId = String(input.cartridgeId ?? '').trim();
			if (!cartridgeId) return { error: 'cartridgeId required', source: 'CartridgeRecord', sourceUrl: '/cartridge-admin' };

			const cart = await CartridgeRecord.findById(cartridgeId).lean() as any;
			if (!cart) return { error: `Cartridge not found: ${cartridgeId}`, source: 'CartridgeRecord', sourceUrl: '/cartridge-admin' };

			let waxRun: any = null;
			let waxSourceLot: any = null;
			if (cart.waxFilling?.runId) {
				waxRun = await WaxFillingRun.findById(cart.waxFilling.runId).lean();
				if (waxRun?.waxSourceLot) {
					waxSourceLot = await ReceivingLot.findOne({
						$or: [{ lotId: waxRun.waxSourceLot }, { bagBarcode: waxRun.waxSourceLot }, { _id: waxRun.waxSourceLot }]
					}).select('lotId lotNumber bagBarcode part createdAt status').lean();
				}
			}

			let reagentBatch: any = null;
			let reagentSourceLots: any[] = [];
			if (cart.reagentFilling?.runId) {
				reagentBatch = await ReagentBatchRecord.findById(cart.reagentFilling.runId).lean().catch(() => null);
				if (reagentBatch?.tubeRecords?.length) {
					const sourceIds = [...new Set(
						reagentBatch.tubeRecords.map((t: any) => t.sourceLotId).filter(Boolean)
					)] as string[];
					if (sourceIds.length > 0) {
						reagentSourceLots = await ReceivingLot.find({
							$or: [{ lotId: { $in: sourceIds } }, { _id: { $in: sourceIds } }]
						}).select('lotId lotNumber part').lean() as any[];
					}
				}
			}

			const integrityNotes: string[] = [];
			if (waxRun && !waxRun.waxSourceLot) integrityNotes.push('Wax run has null waxSourceLot — wax provenance untraceable.');
			if (waxRun?.waxSourceLot && !waxSourceLot) integrityNotes.push(`waxSourceLot "${waxRun.waxSourceLot}" did not match any ReceivingLot — possible orphan reference.`);

			return {
				cartridgeId: cart._id,
				status: cart.status,
				createdAt: cart.createdAt,
				backing: {
					lotId: cart.backing?.lotId,
					inductedAt: cart.backing?.inductedAt,
					inductedBy: cart.backing?.inductedBy?.username
				},
				waxFilling: waxRun ? {
					runId: waxRun._id,
					status: waxRun.status,
					operator: waxRun.operator?.username,
					robot: waxRun.robot?.name,
					runStartTime: waxRun.runStartTime,
					runEndTime: waxRun.runEndTime,
					waxSourceLotIdentifier: waxRun.waxSourceLot ?? null,
					waxSourceLotResolved: waxSourceLot ? {
						lotId: waxSourceLot.lotId,
						bagBarcode: waxSourceLot.bagBarcode,
						lotNumber: waxSourceLot.lotNumber,
						partNumber: waxSourceLot.part?.partNumber,
						partName: waxSourceLot.part?.name
					} : null
				} : null,
				waxQc: cart.waxQc ? {
					status: cart.waxQc.status,
					inspector: cart.waxQc.inspector?.username,
					inspectedAt: cart.waxQc.inspectedAt,
					notes: cart.waxQc.notes
				} : null,
				waxStorage: cart.waxStorage ? {
					location: cart.waxStorage.location,
					locationId: cart.waxStorage.locationId,
					storedAt: cart.waxStorage.storedAt
				} : null,
				reagentFilling: reagentBatch ? {
					runId: reagentBatch._id,
					status: reagentBatch.status,
					assay: reagentBatch.assayType?.name,
					operator: reagentBatch.operator?.username,
					robot: reagentBatch.robot?.name,
					sourceLots: reagentSourceLots.map(l => ({
						lotId: l.lotId, partNumber: l.part?.partNumber, partName: l.part?.name
					}))
				} : null,
				reagentInspection: cart.reagentInspection ? {
					status: cart.reagentInspection.status,
					inspector: cart.reagentInspection.inspector?.username,
					inspectedAt: cart.reagentInspection.inspectedAt
				} : null,
				storage: cart.storage ? {
					fridgeId: cart.storage.fridgeId,
					storedAt: cart.storage.storedAt
				} : null,
				shipping: cart.shipping ? {
					packageId: cart.shipping.packageId,
					shippingLotId: cart.shipping.shippingLotId,
					customer: cart.shipping.customer?.name,
					shippedAt: cart.shipping.shippedAt
				} : null,
				source: 'CartridgeRecord with multi-hop joins to BackingLot, WaxFillingRun, ReceivingLot (wax+reagent), ReagentBatchRecord, ShippingLot',
				sourceUrl: `/cartridges/${cart._id}`,
				dataIntegrityNotes: integrityNotes
			};
		}
		case 'check_data_integrity': {
			const FOUR_HOURS = 4 * 3600e3;
			const SEVEN_DAYS = 7 * 86400e3;

			const [
				nullWaxSource,
				nullWaxSourceSample,
				staleEquipment,
				stuckCartridges,
				stuckCartridgesSample
			] = await Promise.all([
				WaxFillingRun.countDocuments({ status: 'completed', waxSourceLot: { $in: [null, undefined, ''] } }),
				WaxFillingRun.find({ status: 'completed', waxSourceLot: { $in: [null, undefined, ''] } })
					.select('_id runStartTime').sort({ runStartTime: -1 }).limit(5).lean(),
				Equipment.find({
					equipmentType: { $in: ['fridge', 'oven'] },
					$or: [
						{ lastTemperatureReadAt: { $lt: new Date(Date.now() - FOUR_HOURS) } },
						{ lastTemperatureReadAt: { $exists: false } }
					]
				}).select('_id name lastTemperatureReadAt').limit(20).lean(),
				CartridgeRecord.countDocuments({
					status: { $nin: ['shipped', 'voided', 'archived', 'completed'] },
					createdAt: { $lt: new Date(Date.now() - SEVEN_DAYS) }
				}),
				CartridgeRecord.find({
					status: { $nin: ['shipped', 'voided', 'archived', 'completed'] },
					createdAt: { $lt: new Date(Date.now() - SEVEN_DAYS) }
				}).select('_id status createdAt').sort({ createdAt: 1 }).limit(5).lean()
			]);

			// Over-consumed lots (consumedUl > quantity * 12000) — only meaningful for wax tubes
			const overConsumedLots = await ReceivingLot.find({
				'part.partNumber': WAX_TUBE_PART_NUMBER,
				$expr: { $gt: ['$consumedUl', { $multiply: ['$quantity', FULL_TUBE_VOLUME_UL] }] }
			}).select('_id lotId quantity consumedUl').limit(10).lean() as any[];

			const issues: string[] = [];
			if (nullWaxSource > 0) issues.push(`${nullWaxSource} completed wax run(s) have null waxSourceLot.`);
			if ((staleEquipment as any[]).length > 0) issues.push(`${(staleEquipment as any[]).length} equipment record(s) have lastTemperatureReadAt > 4h old or missing.`);
			if (stuckCartridges > 0) issues.push(`${stuckCartridges} cartridge(s) have been in non-terminal status > 7 days.`);
			if (overConsumedLots.length > 0) issues.push(`${overConsumedLots.length} wax-tube lot(s) report consumedUl exceeding capacity (data corruption).`);

			return {
				summary: {
					totalIssueCount: issues.length,
					issues
				},
				details: {
					nullWaxSourceLot: {
						count: nullWaxSource,
						sample: (nullWaxSourceSample as any[]).map(r => ({ runId: r._id, runStartTime: r.runStartTime }))
					},
					staleEquipmentReads: {
						count: (staleEquipment as any[]).length,
						items: (staleEquipment as any[]).map(e => ({
							name: e.name, lastReadAt: e.lastTemperatureReadAt
						}))
					},
					stuckCartridges: {
						count: stuckCartridges,
						sample: (stuckCartridgesSample as any[]).map(c => ({
							cartridgeId: c._id, status: c.status, createdAt: c.createdAt
						}))
					},
					overConsumedLots: {
						count: overConsumedLots.length,
						items: overConsumedLots.map(l => ({
							lotId: l.lotId, quantity: l.quantity, consumedUl: l.consumedUl
						}))
					}
				},
				source: 'Aggregated across CartridgeRecord, WaxFillingRun, ReceivingLot, Equipment',
				sourceUrl: '/admin'
			};
		}
		case 'production_throughput': {
			const days = Math.min(Math.max(Number(input.sinceDays ?? 7), 1), 90);
			const since = new Date(Date.now() - days * 86400e3);

			const buildCount = (matchExpr: any) => CartridgeRecord.aggregate([
				{ $match: matchExpr },
				{
					$group: {
						_id: {
							$dateToString: { format: '%Y-%m-%d', date: matchExpr._dateField }
						},
						count: { $sum: 1 }
					}
				},
				{ $sort: { _id: 1 } }
			]);

			// Simpler: aggregate by createdAt for "carts created" — proxies for backing
			const created = await CartridgeRecord.aggregate([
				{ $match: { createdAt: { $gte: since } } },
				{
					$group: {
						_id: { $dateToString: { format: '%Y-%m-%d', date: '$createdAt' } },
						count: { $sum: 1 }
					}
				},
				{ $sort: { _id: 1 } }
			]);

			// Wax filled today: cart has waxFilling.recordedAt within window
			const waxed = await CartridgeRecord.aggregate([
				{ $match: { 'waxFilling.recordedAt': { $gte: since } } },
				{
					$group: {
						_id: { $dateToString: { format: '%Y-%m-%d', date: '$waxFilling.recordedAt' } },
						count: { $sum: 1 }
					}
				},
				{ $sort: { _id: 1 } }
			]);

			const accepted = await CartridgeRecord.aggregate([
				// Schema enum is capitalized 'Accepted'/'Rejected'/'Pending' but legacy
				// data may be lowercase — normalize via $toLower (mirrors get_run_yield fix).
				{ $match: { 'waxQc.recordedAt': { $gte: since } } },
				{ $match: { $expr: { $eq: [{ $toLower: '$waxQc.status' }, 'accepted'] } } },
				{
					$group: {
						_id: { $dateToString: { format: '%Y-%m-%d', date: '$waxQc.recordedAt' } },
						count: { $sum: 1 }
					}
				},
				{ $sort: { _id: 1 } }
			]);

			const totalCreated = created.reduce((s, d) => s + d.count, 0);
			const totalWaxed = waxed.reduce((s, d) => s + d.count, 0);
			const totalAccepted = accepted.reduce((s, d) => s + d.count, 0);

			return {
				windowDays: days,
				totals: {
					cartridgesCreated: totalCreated,
					cartridgesWaxed: totalWaxed,
					cartridgesAccepted: totalAccepted,
					yieldPct: totalWaxed > 0 ? Math.round((totalAccepted / totalWaxed) * 1000) / 10 : null
				},
				dailyCreated: created.map((d: any) => ({ date: d._id, count: d.count })),
				dailyWaxed: waxed.map((d: any) => ({ date: d._id, count: d.count })),
				dailyAccepted: accepted.map((d: any) => ({ date: d._id, count: d.count })),
				source: 'CartridgeRecord aggregation by createdAt + waxFilling.recordedAt + waxQc.recordedAt',
				sourceUrl: '/cartridge-admin'
			};
		}
		case 'temperature_excursion_summary': {
			const sensorName = String(input.equipmentName ?? '').trim();
			if (!sensorName) return { error: 'equipmentName required', source: 'TemperatureReading', sourceUrl: '/equipment/activity' };
			const days = Math.min(Math.max(Number(input.sinceDays ?? 7), 1), 30);
			const since = new Date(Date.now() - days * 86400e3);

			const eq = await Equipment.findOne({ name: { $regex: sensorName, $options: 'i' } })
				.select('_id name mocreoDeviceId temperatureMinC temperatureMaxC').lean() as any;
			if (!eq) return {
				error: `No equipment matching "${sensorName}"`,
				source: 'Equipment',
				sourceUrl: '/equipment/activity'
			};
			if (eq.temperatureMinC == null || eq.temperatureMaxC == null) {
				return {
					equipmentName: eq.name,
					error: 'No temperature thresholds configured for this equipment.',
					source: 'Equipment.temperatureMinC/MaxC',
					sourceUrl: '/equipment/activity'
				};
			}

			const readings = await TemperatureReading.find({
				$or: [{ equipmentId: eq._id }, { sensorId: eq.mocreoDeviceId }],
				timestamp: { $gte: since }
			}).select('temperature timestamp').sort({ timestamp: 1 }).lean() as any[];

			const alerts = await TemperatureAlert.countDocuments({
				$or: [{ equipmentId: eq._id }, { sensorId: eq.mocreoDeviceId }],
				timestamp: { $gte: since }
			});

			let outOfSpecMinutes = 0;
			let longestExcursionMin = 0;
			let currentExcursion = 0;
			let prevTime: Date | null = null;
			for (const r of readings) {
				const inSpec = r.temperature >= eq.temperatureMinC && r.temperature <= eq.temperatureMaxC;
				if (prevTime && !inSpec) {
					const gapMin = (new Date(r.timestamp).getTime() - prevTime.getTime()) / 60000;
					if (gapMin <= 30) {
						outOfSpecMinutes += gapMin;
						currentExcursion += gapMin;
						if (currentExcursion > longestExcursionMin) longestExcursionMin = currentExcursion;
					}
				} else {
					currentExcursion = 0;
				}
				prevTime = new Date(r.timestamp);
			}

			return {
				equipmentName: eq.name,
				windowDays: days,
				targetRange: `${eq.temperatureMinC} to ${eq.temperatureMaxC}°C`,
				readingCount: readings.length,
				alertCount: alerts,
				outOfSpecMinutes: Math.round(outOfSpecMinutes),
				longestExcursionMinutes: Math.round(longestExcursionMin),
				inSpecPct: readings.length > 0
					? Math.round((readings.filter(r => r.temperature >= eq.temperatureMinC && r.temperature <= eq.temperatureMaxC).length / readings.length) * 1000) / 10
					: null,
				source: 'TemperatureReading + TemperatureAlert + Equipment thresholds',
				sourceUrl: '/equipment/activity'
			};
		}
		case 'inventory_burn_rate': {
			const partNumber = String(input.partNumber ?? '').trim();
			if (!partNumber) return { error: 'partNumber required', source: 'InventoryTransaction', sourceUrl: '/parts' };
			const days = Math.min(Math.max(Number(input.sinceDays ?? 14), 1), 90);
			const since = new Date(Date.now() - days * 86400e3);

			const part = await PartDefinition.findOne({ partNumber }).select('_id partNumber name inventoryCount').lean() as any;
			if (!part) return { error: `Part not found: ${partNumber}`, source: 'PartDefinition', sourceUrl: '/parts' };

			const txns = await InventoryTransaction.find({
				partDefinitionId: part._id,
				transactionType: 'consumption',
				createdAt: { $gte: since }
			}).select('quantity createdAt').lean() as any[];

			const totalConsumed = txns.reduce((s, t) => s + (Number(t.quantity) || 0), 0);
			const dailyRate = totalConsumed / days;

			// Daily counts for stdev
			const byDay: Map<string, number> = new Map();
			for (const t of txns) {
				const key = new Date(t.createdAt).toISOString().slice(0, 10);
				byDay.set(key, (byDay.get(key) ?? 0) + Number(t.quantity));
			}
			const counts = Array.from(byDay.values());
			const mean = counts.length ? counts.reduce((s, x) => s + x, 0) / counts.length : 0;
			const variance = counts.length ? counts.reduce((s, x) => s + (x - mean) ** 2, 0) / counts.length : 0;
			const stdev = Math.sqrt(variance);

			const projectedDays = dailyRate > 0 && part.inventoryCount > 0
				? Math.round(part.inventoryCount / dailyRate)
				: null;

			return {
				partNumber: part.partNumber,
				partName: part.name,
				windowDays: days,
				transactionCount: txns.length,
				totalConsumed,
				dailyRate: Math.round(dailyRate * 100) / 100,
				dailyStdev: Math.round(stdev * 100) / 100,
				currentInventoryCount: part.inventoryCount,
				projectedDaysToEmpty: projectedDays,
				source: 'InventoryTransaction (consumption events) + PartDefinition.inventoryCount',
				sourceUrl: `/parts/${part._id}`,
				dataIntegrityNotes: txns.length === 0
					? [`No consumption transactions for ${partNumber} in the last ${days} days. Either no usage or the transaction stream is broken.`]
					: []
			};
		}
		case 'runway': {
			const partNumber = String(input.partNumber ?? '').trim();
			if (!partNumber) return { error: 'partNumber required', source: 'PartDefinition + InventoryTransaction', sourceUrl: '/parts' };
			const windowDays = Math.min(Math.max(Number(input.windowDays ?? 14), 1), 60);
			const since = new Date(Date.now() - windowDays * 86400e3);

			const part = await PartDefinition.findOne({ partNumber }).select('_id partNumber name inventoryCount minimumOrderQty').lean() as any;
			if (!part) return { error: `Part not found: ${partNumber}`, source: 'PartDefinition', sourceUrl: '/parts' };

			const txns = await InventoryTransaction.find({
				partDefinitionId: part._id,
				transactionType: 'consumption',
				createdAt: { $gte: since }
			}).select('quantity').lean() as any[];

			const totalConsumed = txns.reduce((s, t) => s + (Number(t.quantity) || 0), 0);
			const dailyRate = totalConsumed / windowDays;

			// Cross-check with ReceivingLot accepted quantities
			const lots = await ReceivingLot.find({
				'part._id': part._id,
				status: { $in: ['accepted', 'in_progress'] }
			}).select('quantity consumedUl').lean() as any[];

			const lotInventory = lots.reduce((s, l) => s + (Number(l.quantity) || 0), 0);
			const projectedFromCounter = dailyRate > 0 && part.inventoryCount > 0
				? Math.round(part.inventoryCount / dailyRate)
				: null;
			const projectedFromLots = dailyRate > 0 && lotInventory > 0
				? Math.round(lotInventory / dailyRate)
				: null;

			const integrityNotes: string[] = [];
			if (part.inventoryCount !== lotInventory) {
				integrityNotes.push(`PartDefinition.inventoryCount (${part.inventoryCount}) does not match ReceivingLot accepted quantity sum (${lotInventory}). Counter may have drifted.`);
			}
			if (dailyRate === 0) {
				integrityNotes.push('No consumption recorded in the window — runway estimate not reliable.');
			}

			return {
				partNumber: part.partNumber,
				partName: part.name,
				windowDays,
				dailyConsumptionRate: Math.round(dailyRate * 100) / 100,
				inventory: {
					perCounter: part.inventoryCount,
					perReceivingLots: lotInventory
				},
				projectedDaysRemaining: {
					perCounter: projectedFromCounter,
					perReceivingLots: projectedFromLots
				},
				reorderThreshold: part.minimumOrderQty,
				belowReorderInDays: dailyRate > 0 && part.inventoryCount > part.minimumOrderQty
					? Math.round((part.inventoryCount - part.minimumOrderQty) / dailyRate)
					: 0,
				source: 'PartDefinition.inventoryCount + ReceivingLot accepted sum + InventoryTransaction window',
				sourceUrl: `/parts/${part._id}`,
				dataIntegrityNotes: integrityNotes
			};
		}
		case 'bulk_run_yields': {
			const days = Math.min(Math.max(Number(input.sinceDays ?? 14), 1), 90);
			const since = new Date(Date.now() - days * 86400e3);
			const limit = Math.min(Math.max(Number(input.limit ?? 100), 1), 500);

			const runFilter: any = {
				status: input.status ?? 'completed',
				createdAt: { $gte: since }
			};
			if (input.robot) runFilter['robot.name'] = input.robot;
			if (input.operator) runFilter['operator.username'] = input.operator;

			const runs = await WaxFillingRun.find(runFilter)
				.select('_id robot operator runStartTime runEndTime cartridgeIds waxSourceLot status')
				.sort({ runEndTime: -1, createdAt: -1 })
				.limit(limit + 1)
				.lean() as any[];
			const truncated = runs.length > limit;
			const trimmed = runs.slice(0, limit);

			// Aggregate cartridge QC counts in one query for ALL runs.
			// Filter out checked-out cartridges (matches dev's pattern in
			// get_run_yield and count_cartridges_by_status — see commit 03f5535).
			const allCartIds = trimmed.flatMap(r => r.cartridgeIds ?? []);
			const checkedOutIdsBulk = await getCheckedOutCartridgeIds();
			const cartAgg = allCartIds.length > 0
				? await CartridgeRecord.aggregate([
					{ $match: { _id: { $in: allCartIds, $nin: checkedOutIdsBulk } } },
					{
						$group: {
							_id: '$waxFilling.runId',
							total: { $sum: 1 },
							// Schema enum is capitalized ('Accepted'/'Rejected'/'Pending') but
							// legacy data may be lowercase. Normalize via $toLower so casing
							// drift can't reintroduce the get_run_yield bug here too.
							accepted: { $sum: { $cond: [
								{ $eq: [{ $toLower: { $ifNull: ['$waxQc.status', ''] } }, 'accepted'] },
								1, 0
							] } },
							scrapped: { $sum: { $cond: [
								{ $in: [
									{ $toLower: { $ifNull: ['$waxQc.status', ''] } },
									['scrapped', 'rejected']
								] },
								1, 0
							] } },
							pendingQc: { $sum: { $cond: [
								{ $or: [
									{ $eq: [{ $ifNull: ['$waxQc.status', ''] }, ''] },
									{ $eq: [{ $toLower: { $ifNull: ['$waxQc.status', ''] } }, 'pending'] }
								] },
								1, 0
							] } }
						}
					}
				])
				: [];
			const aggMap = new Map(cartAgg.map((g: any) => [g._id, g]));

			const integrityNotes: string[] = [];
			let nullSourceCount = 0;
			let zeroQcCount = 0;

			const items = trimmed.map(r => {
				const agg = aggMap.get(r._id) ?? { total: 0, accepted: 0, scrapped: 0, pendingQc: 0 };
				const total = (r.cartridgeIds ?? []).length;
				const yieldPct = (agg.accepted + agg.scrapped) > 0
					? Math.round((agg.accepted / (agg.accepted + agg.scrapped)) * 1000) / 10
					: null;
				if (!r.waxSourceLot) nullSourceCount++;
				if (agg.accepted === 0 && agg.scrapped === 0 && total > 0) zeroQcCount++;
				return {
					runId: r._id,
					robot: r.robot?.name,
					operator: r.operator?.username,
					runStartTime: r.runStartTime,
					runEndTime: r.runEndTime,
					cartridgeCount: total,
					accepted: agg.accepted,
					scrapped: agg.scrapped,
					pendingQc: agg.pendingQc,
					yieldPct,
					waxSourceLot: r.waxSourceLot ?? null
				};
			});

			if (nullSourceCount > 0) integrityNotes.push(`${nullSourceCount}/${trimmed.length} runs have null waxSourceLot — wax-source traceability incomplete for those.`);
			if (zeroQcCount > 0) integrityNotes.push(`${zeroQcCount}/${trimmed.length} runs have ZERO QC decisions recorded (accepted=0 AND scrapped=0). Yield % is null for these — QC may not be entered yet, or workflow may have skipped QC step.`);
			if (truncated) integrityNotes.push(`Result truncated at ${limit}. Pass a smaller window or stricter filter to narrow.`);

			// Aggregates by robot, since "yield by robot" is the most common downstream slice
			const byRobot: Record<string, { runs: number; carts: number; accepted: number; scrapped: number }> = {};
			for (const it of items) {
				const k = it.robot ?? 'unknown';
				const r = byRobot[k] ?? { runs: 0, carts: 0, accepted: 0, scrapped: 0 };
				r.runs++;
				r.carts += it.cartridgeCount;
				r.accepted += it.accepted;
				r.scrapped += it.scrapped;
				byRobot[k] = r;
			}
			const byRobotArr = Object.entries(byRobot).map(([robot, agg]) => ({
				robot,
				runs: agg.runs,
				cartridges: agg.carts,
				accepted: agg.accepted,
				scrapped: agg.scrapped,
				yieldPct: (agg.accepted + agg.scrapped) > 0
					? Math.round((agg.accepted / (agg.accepted + agg.scrapped)) * 1000) / 10
					: null
			}));

			return {
				windowDays: days,
				totalRuns: items.length,
				runs: items,
				byRobotSummary: byRobotArr,
				totals: {
					cartridges: items.reduce((s, i) => s + i.cartridgeCount, 0),
					accepted: items.reduce((s, i) => s + i.accepted, 0),
					scrapped: items.reduce((s, i) => s + i.scrapped, 0),
					pendingQc: items.reduce((s, i) => s + i.pendingQc, 0)
				},
				truncated,
				source: 'WaxFillingRun + single CartridgeRecord aggregation (replaces N×get_run_yield calls)',
				sourceUrl: '/cartridge-admin',
				dataIntegrityNotes: integrityNotes
			};
		}
		case 'whats_blocking_run': {
			const runId = String(input.runId ?? '').trim();
			if (!runId) return { error: 'runId required', source: 'WaxFillingRun', sourceUrl: '/manufacturing' };

			const run = await WaxFillingRun.findById(runId).lean() as any;
			if (!run) return { error: `Run not found: ${runId}`, source: 'WaxFillingRun', sourceUrl: '/manufacturing' };

			const TERMINAL = ['completed', 'aborted', 'voided', 'archived'];
			if (TERMINAL.includes((run.status ?? '').toLowerCase())) {
				return {
					runId: run._id,
					status: run.status,
					blocked: false,
					reason: `Run is in terminal status (${run.status}) — not blocked, just done.`,
					source: 'WaxFillingRun',
					sourceUrl: `/cartridge-admin?runId=${encodeURIComponent(runId)}`
				};
			}

			const blockers: string[] = [];

			// Check deck
			if (run.deckId) {
				const otherDeckRuns = await WaxFillingRun.findOne({
					_id: { $ne: run._id },
					deckId: run.deckId,
					status: { $nin: TERMINAL }
				}).select('_id status').lean() as any;
				if (otherDeckRuns) blockers.push(`Deck ${run.deckId} also held by run ${otherDeckRuns._id} (status=${otherDeckRuns.status}).`);
			}

			// Check wax source
			if (run.waxSourceLot) {
				const lot = await ReceivingLot.findOne({
					$or: [{ lotId: run.waxSourceLot }, { bagBarcode: run.waxSourceLot }]
				}).select('quantity consumedUl status').lean() as any;
				if (!lot) blockers.push(`waxSourceLot "${run.waxSourceLot}" does not match any ReceivingLot — wax source unidentified.`);
				else {
					const totalUl = (lot.quantity || 0) * FULL_TUBE_VOLUME_UL;
					const remaining = totalUl - (lot.consumedUl || 0);
					if (remaining <= 0) blockers.push(`waxSourceLot is depleted (consumedUl=${lot.consumedUl} >= total=${totalUl}).`);
				}
			} else {
				blockers.push('waxSourceLot is null — run cannot proceed without a recorded wax source.');
			}

			// Check QC pending
			const cartridgeIds = run.cartridgeIds ?? [];
			if (cartridgeIds.length > 0) {
				const pendingQc = await CartridgeRecord.countDocuments({
					_id: { $in: cartridgeIds },
					$or: [
						{ 'waxQc.status': { $in: [null, undefined, 'pending', 'Pending'] } },
						{ waxQc: { $exists: false } }
					]
				});
				if (pendingQc > 0 && (run.status ?? '').toLowerCase().includes('qc')) {
					blockers.push(`${pendingQc} of ${cartridgeIds.length} cartridges still pending QC.`);
				}
			}

			return {
				runId: run._id,
				status: run.status,
				blocked: blockers.length > 0,
				blockers,
				cartridgeCount: cartridgeIds.length,
				waxSourceLot: run.waxSourceLot ?? null,
				deckId: run.deckId ?? null,
				source: 'WaxFillingRun + Equipment (deck) + ReceivingLot (wax source) + CartridgeRecord (QC)',
				sourceUrl: `/cartridge-admin?runId=${encodeURIComponent(runId)}`
			};
		}
		case 'get_temperature_history': {
			const sensorName = String(input.equipmentName ?? '').trim();
			if (!sensorName) return { error: 'equipmentName required', source: 'TemperatureReading', sourceUrl: '/equipment/activity' };
			const sinceHours = Math.min(Math.max(Number(input.sinceHours ?? 24), 1), 168);

			// Resolve equipment by name
			const eq = await Equipment.findOne({ name: { $regex: sensorName, $options: 'i' } })
				.select('_id name mocreoDeviceId temperatureMinC temperatureMaxC').lean() as any;
			if (!eq) return {
				error: `No equipment matching "${sensorName}"`,
				source: 'Equipment + TemperatureReading',
				sourceUrl: '/equipment/activity'
			};

			const since = new Date(Date.now() - sinceHours * 3600e3);
			const readings = await TemperatureReading.find({
				$or: [{ equipmentId: eq._id }, { sensorId: eq.mocreoDeviceId }],
				timestamp: { $gte: since }
			})
				.select('temperature humidity timestamp')
				.sort({ timestamp: -1 })
				.limit(500).lean() as any[];

			if (readings.length === 0) {
				return {
					equipmentName: eq.name,
					windowHours: sinceHours,
					readingCount: 0,
					source: 'TemperatureReading',
					sourceUrl: '/equipment/activity',
					dataIntegrityNotes: [`No readings found for "${eq.name}" in the last ${sinceHours}h. Sensor may have lost connection or be misconfigured.`]
				};
			}

			const temps = readings.map(r => r.temperature).filter((t: any) => typeof t === 'number');
			const min = Math.min(...temps);
			const max = Math.max(...temps);
			const avg = temps.reduce((s, t) => s + t, 0) / temps.length;
			const inSpec = eq.temperatureMinC != null
				? temps.filter(t => t >= eq.temperatureMinC && t <= eq.temperatureMaxC).length
				: null;
			const samplePoints = readings.length > 50
				? readings.filter((_, i) => i % Math.ceil(readings.length / 50) === 0).slice(0, 50)
				: readings;

			return {
				equipmentName: eq.name,
				windowHours: sinceHours,
				readingCount: readings.length,
				summary: {
					minC: Math.round(min * 100) / 100,
					maxC: Math.round(max * 100) / 100,
					avgC: Math.round(avg * 100) / 100,
					inSpecCount: inSpec,
					inSpecPct: inSpec != null ? Math.round((inSpec / temps.length) * 1000) / 10 : null,
					targetRange: eq.temperatureMinC != null ? `${eq.temperatureMinC} to ${eq.temperatureMaxC}°C` : null
				},
				samplePoints: samplePoints.map(r => ({ timestamp: r.timestamp, temperature: r.temperature })),
				source: 'TemperatureReading',
				sourceUrl: '/equipment/activity'
			};
		}
		case 'search_documentation': {
			const q = String(input.query ?? '').trim();
			const result = searchDocs(q);
			const notes: string[] = [];
			if (result.queryLength < 3) notes.push('Query must be at least 3 characters.');
			if (result.timedOut) notes.push('Search timed out at 500ms. Try a more distinctive query.');
			if (result.truncated) notes.push('Result count capped at 5 — narrow the query for more.');
			if (result.matches.length === 0 && result.queryLength >= 3) {
				notes.push(`No matches across ${result.corpusFiles} allowlisted doc files. Try a different phrase, or verify the doc title.`);
			}
			return {
				matches: result.matches,
				totalReturned: result.matches.length,
				truncated: result.truncated,
				corpusFiles: result.corpusFiles,
				source: 'docs/ tree (markdown files; allowlist excludes session/handoff/PRDs)',
				dataIntegrityNotes: notes
			};
		}
		case 'lookup_equipment_datasheet': {
			const q = String(input.equipmentName ?? '').trim();
			if (!q) return { error: 'equipmentName required', source: 'data/equipment-datasheets/*.csv', sourceUrl: undefined };
			const result = lookupEquipment(q);
			const notes: string[] = [];
			if (result.queryNormalized.length < 2) notes.push('Query must be at least 2 characters.');
			if (result.timedOut) notes.push('Lookup timed out at 500ms. Try a more distinctive query.');
			if (result.truncated) notes.push(`${result.totalAvailable} matches but capped at ${result.totalReturned}. Add the Tag # or a distinctive word to narrow.`);
			if (result.matches.length === 0 && result.queryNormalized.length >= 2) {
				notes.push(`No equipment matched "${q}" across ${result.corpusFiles.join(', ')}. Try a Tag # (B-XX/E-XX/F-XX), a manufacturer name, or a distinctive keyword.`);
			}
			notes.push('PDF datasheets are not bundled in this phase. The Datasheet URL field on each row is the manufacturer-hosted spec sheet — surface it when citing.');
			return {
				equipment: result.matches,
				totalReturned: result.totalReturned,
				totalAvailable: result.totalAvailable,
				truncated: result.truncated,
				corpusFiles: result.corpusFiles,
				source: 'data/equipment-datasheets/*.csv (bundled BT + Fannin equipment lists)',
				sourceUrl: undefined,
				dataIntegrityNotes: notes
			};
		}
		case 'search_work_instructions': {
			const q = String(input.query ?? '').trim();
			if (!q) return { error: 'query required', source: 'WorkInstruction', sourceUrl: '/documents/instructions' };
			const partNumber = input.partNumber ? String(input.partNumber).trim() : null;
			const statusInput = input.status ? String(input.status).trim() : 'active';
			const status = statusInput === 'all' ? null : statusInput;
			const limit = Math.min(Math.max(Number(input.limit ?? 5), 1), 20);

			// Escape regex special chars before building the filter.
			const escaped = q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
			const re = { $regex: escaped, $options: 'i' };

			const filter: any = {
				$or: [
					{ documentNumber: re },
					{ title: re },
					{ 'versions.steps.title': re },
					{ 'versions.steps.content': re }
				]
			};
			if (status) filter.status = status;
			if (partNumber) filter['versions.steps.partRequirements.partNumber'] = partNumber;

			const wis = await WorkInstruction.find(filter)
				.select('_id documentNumber title status currentVersion effectiveDate category versions')
				.limit(limit + 1)
				.lean() as any[];
			const truncated = wis.length > limit;
			const trimmed = wis.slice(0, limit);

			const lower = q.toLowerCase();
			const items = trimmed.map((wi: any) => {
				const versions: any[] = wi.versions ?? [];
				const currentVer = versions.find(v => v.version === wi.currentVersion) ?? versions[versions.length - 1];
				const matchedSteps: any[] = [];
				if (currentVer?.steps) {
					for (const step of currentVer.steps) {
						const titleMatch = String(step.title ?? '').toLowerCase().includes(lower);
						const contentMatch = String(step.content ?? '').toLowerCase().includes(lower);
						const partMatch = !!partNumber && Array.isArray(step.partRequirements)
							&& step.partRequirements.some((p: any) => p.partNumber === partNumber);
						if (titleMatch || contentMatch || partMatch) {
							const contentStr = String(step.content ?? '');
							matchedSteps.push({
								stepNumber: step.stepNumber,
								title: step.title,
								contentSnippet: contentStr ? contentStr.slice(0, 200) + (contentStr.length > 200 ? '…' : '') : null,
								requiresScan: step.requiresScan ?? false,
								partRequirements: Array.isArray(step.partRequirements)
									? step.partRequirements.map((p: any) => ({ partNumber: p.partNumber, quantity: p.quantity }))
									: [],
								reason: titleMatch ? 'title match' : contentMatch ? 'content match' : 'part requirement match'
							});
						}
					}
				}
				return {
					documentNumber: wi.documentNumber,
					title: wi.title,
					status: wi.status,
					currentVersion: wi.currentVersion,
					effectiveDate: wi.effectiveDate,
					category: wi.category,
					matchedSteps,
					fullStepCount: currentVer?.steps?.length ?? 0,
					sourceUrl: `/documents/instructions/${wi._id}`
				};
			});

			const integrityNotes: string[] = [];
			if (items.length === 0) {
				integrityNotes.push(`No work instructions matched "${q}"${partNumber ? ` with partNumber=${partNumber}` : ''}${status ? ` and status=${status}` : ''}. Try a broader query, drop the partNumber filter, or use status='all' to include drafts and retired versions.`);
			}
			if (truncated) integrityNotes.push(`Result count capped at ${limit} — narrow the query for more.`);

			return {
				workInstructions: items,
				totalReturned: items.length,
				truncated,
				source: 'WorkInstruction model — searched documentNumber/title/step.title/step.content/step.partRequirements.partNumber',
				sourceUrl: '/documents/instructions',
				dataIntegrityNotes: integrityNotes
			};
		}
	}
	return { error: `Unknown tool: ${name}` };
}

const SYSTEM_PROMPT = `You are the Bioscale Internal Management System (BIMS) assistant. You answer questions about manufacturing operations at Bioscale — wax filling, reagent filling, temperature monitoring, inventory, and cartridge tracking.

You have tools to query the BIMS mongo database. Use them to ground every answer in real data — never make up numbers, lot IDs, or statuses. If data is missing, say so.

Be concise and direct. Use bullet points or short tables when listing multiple items. If the user asks a vague question, ask a short clarifying question instead of guessing. Always include relevant IDs (lot numbers, run IDs, barcodes) so the user can follow up.

Temperatures are in Celsius. Wax volumes are in microliters (μL). Currency is USD.

ACCURACY DISCIPLINE — read carefully:

1. **Pick the right tool.** Tool descriptions tell you WHAT each tool queries (model + filter) and WHEN to use it. They also tell you when NOT to use a tool. If two tools could answer a question, prefer the one that says "Source of truth" for that domain. Read the description; do not guess.

2. **Surface inconsistencies; do not paper over them.** When data appears suspicious, do not report one piece as fact while ignoring the contradiction. Examples: inventory records with no consumption history despite many active runs in the same period; runs with null source-tracking fields; equipment with stale temperature readings; two tools giving conflicting numbers. Frame answers as: "I found X, but Y is inconsistent with that — the operational truth is likely Z" rather than just "X."

3. **Honor dataIntegrityNotes.** Tool results may include a dataIntegrityNotes array. Surface them in your answer; do not bury them.

4. **Cite sources.** Every tool result includes a source field and a sourceUrl. Mention the source naturally and refer the user to the URL.

5. **Confidence calibration.** If your answer relies on optional or often-null fields, say so explicitly: "Based on the runs that recorded a source lot — N runs had this field empty and were excluded." Don't pretend partial data is complete.

6. **Don't trust counters; trust events.** Denormalized counters (PartDefinition.inventoryCount, dashboard summaries) drift. For high-stakes questions, prefer tools that aggregate from event tables.

7. **Cite the inline BIMS DATA REFERENCE when grounding.** A condensed reference doc is inlined above (53 BIMS collections + 11 research-only, tier rules, integrity gaps, lifecycle, permissions). When the answer specifically grounds in §1 (tier rules), §4 (known integrity gaps), or a non-obvious schema relationship from §2, cite it briefly: e.g., "Per DATA-REFERENCE §1, cartridge_records is sacred — corrections only via the corrections[] append-only array after finalize." If a §4 integrity gap plausibly affects the answer, surface it explicitly even if no tool result called it out — that's exactly what §4 is for. Do NOT cite §3 (lifecycle); phase ordering is general operational knowledge.

TOOL SELECTION HEURISTICS — use this to choose the right tool, the first time:

A. **Plan before you call.** Read the user's question. Decide: (1) does this need a tool, or is it a general concept question? (2) what's the SMALLEST set of tools that gives a complete answer? Each extra call adds cost, latency, and noise. Calling 5 tools when 1 works is a failure.

B. **One-question-one-tool when possible.** Most questions have one canonical tool:
- "Is the cartridge oven on?" / "What temp is X right now?" → get_current_temperatures (NOT list_equipment)
- "List our fridges" / "What robots do we have?" → list_equipment (NOT get_current_temperatures)
- "What alerted today?" → get_temperature_alerts (NOT get_current_temperatures)
- "How much wax do we have?" → get_wax_tube_inventory (NEVER list_legacy_wax_batches unless user explicitly asks about in-house production)
- "How many carts today?" → count_cartridges_by_status (NOT find_cartridges + manual count)
- "Show carts in storage" / "Carts from run X" → find_cartridges (NOT get_run_yield, NOT trace_cartridge)
- "Yield on run X" → get_run_yield (already has cart breakdown — don't add find_cartridges)
- "Trace cart X" / "Lineage of cart X" → trace_cartridge directly (don't pre-call find_cartridges)
- "Tell me about part X" → find_part (NOT list_low_inventory_parts unless asking about reorder)
- "What to reorder?" → list_low_inventory_parts (NOT find_part — broad scan)
- "Recent runs" → list_recent_runs

C. **Anti-overlap rules.** Specific traps that have caused over-tool-use:
- Don't pre-call find_cartridges before trace_cartridge — trace_cartridge takes the cartridgeId directly.
- Don't pre-call find_cartridges before get_run_yield — get_run_yield does its own cart aggregation.
- Don't combine count_cartridges_by_status with find_cartridges for the same time window — pick one.
- Don't call list_equipment to answer temperature questions; the equipment registry doesn't have current readings.

D. **Anti-guessing.** If the user asks about specific BIMS data, USE A TOOL. Never answer from prior knowledge or general assumptions. Examples of the failure mode: "Yes, ovens are typically on" (without checking), "Wax inventory is usually ~50,000 μL" (without checking), "Robot 2 generally runs faster than Robot 1" (without checking). If no tool can answer the question, say so directly: "I don't have a tool for that — you can check this on /equipment/activity."

E. **On broad questions** ("what's going on?", "how's the floor?"): pick 2-3 targeted tools (e.g., list_recent_runs + get_temperature_alerts + count_cartridges_by_status). Do not call 5+. If you find yourself wanting to call many tools, ask the user to narrow the question instead.

F. **When parameters matter.** Tools with optional parameters benefit from useful defaults: pass sinceHours when asked about "today" or "recent", pass status filters when the user mentions a stage, pass limits when they want "top N." Don't call a tool with no parameters and then re-call with parameters when you realize it returned too much.

G. **NEVER re-call the same tool in one turn.** Before calling a tool, check whether you've already called it in this conversation turn — even with slightly different parameters. If yes, USE THE PRIOR RESULT.

   Concrete example of the bug: you call list_recent_runs(sinceHours=24), get no matches, then call list_recent_runs(sinceHours=168) hoping for more. That's a violation — the second call burns tokens and is detected as anti-redundancy. INSTEAD: pass a generous window on your first call (the tool's default is one week), accept whatever comes back, and tell the user "no recent runs in the past week" if nothing matches. Two calls to the same tool in one turn is ALWAYS a bug.

H. **UUID-style IDs are ReceivingLot IDs, not parts.** A string like 74b942a2-16a5-4ae4-aa91-917d3ecc146a is a ReceivingLot._id (or a similar UUID-style barcode). Use find_receiving_lot, NOT find_part. find_part queries the PT-CT-XXX catalog and will return nothing for UUID lookups, which then leads to false-positive "lot not found" warnings. Recognize UUIDs by their shape (8-4-4-4-12 hex with dashes).`;

export interface AskBimsMessage {
	role: 'user' | 'assistant';
	content: string;
}

export interface AskBimsUsage {
	inputTokens: number;
	outputTokens: number;
	cacheReadTokens: number;
	cacheWriteTokens: number;
	estCostUsd: number;
}

export interface AskBimsResult {
	answer: string;
	toolCalls: Array<{ name: string; input: any; result: any }>;
	usage?: AskBimsUsage;
	model?: AskBimsModel;
	error?: string;
}

function calcCost(model: AskBimsModel, u: { inputTokens: number; outputTokens: number; cacheReadTokens: number; cacheWriteTokens: number }): number {
	const p = PRICING[model];
	return (
		u.inputTokens * p.input +
		u.cacheWriteTokens * p.cacheWrite5m +
		u.cacheReadTokens * p.cacheRead +
		u.outputTokens * p.output
	) / 1_000_000;
}

export interface AskBimsOpts {
	model?: AskBimsModel;
	userId?: string;
	username?: string;
}

/**
 * Agent loop using Anthropic tool-use. Accepts conversation history + an optional model override.
 */
export async function askBims(history: AskBimsMessage[], opts: AskBimsOpts = {}): Promise<AskBimsResult> {
	const t0 = Date.now();
	const result = await runAgentLoop(history, opts);

	// Log cost telemetry — fire-and-forget, never blocks response.
	if (opts.userId) {
		void logCostTelemetry({
			userId: opts.userId,
			username: opts.username,
			model: result.model ?? (opts.model ?? DEFAULT_MODEL),
			usage: {
				inputTokens: result.usage?.inputTokens ?? 0,
				outputTokens: result.usage?.outputTokens ?? 0,
				cacheReadTokens: result.usage?.cacheReadTokens ?? 0,
				cacheWriteTokens: result.usage?.cacheWriteTokens ?? 0
			},
			costUsd: result.usage?.estCostUsd ?? 0,
			toolCallCount: result.toolCalls.length,
			uniqueToolCount: new Set(result.toolCalls.map(tc => tc.name)).size,
			durationMs: Date.now() - t0,
			errorClass: result.error ? 'agent_error' : undefined
		});
	}

	return result;
}

async function runAgentLoop(history: AskBimsMessage[], opts: AskBimsOpts): Promise<AskBimsResult> {
	const client = getClient();
	if (!client) {
		return { answer: '', toolCalls: [], error: 'ANTHROPIC_API_KEY not configured on the server.' };
	}
	if (history.length === 0 || history[history.length - 1].role !== 'user') {
		return { answer: '', toolCalls: [], error: 'Last message must be from user.' };
	}

	const model: AskBimsModel = ALLOWED_MODELS.includes(opts.model as AskBimsModel)
		? (opts.model as AskBimsModel)
		: DEFAULT_MODEL;

	const messages: Anthropic.MessageParam[] = history.map(h => ({
		role: h.role,
		content: h.content
	}));

	// Filter out disabled tools (env-flag kill-switch — principle #11)
	const disabledTools = getDisabledTools();
	const activeTools = disabledTools.size > 0
		? TOOLS.filter(t => !disabledTools.has(t.name))
		: TOOLS;

	const toolCalls: AskBimsResult['toolCalls'] = [];
	const usage = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 };
	const MAX_ITERATIONS = 8;

	for (let i = 0; i < MAX_ITERATIONS; i++) {
		let response: Anthropic.Message;
		try {
			response = await client.messages.create({
				model,
				max_tokens: 4096,
				system: [
					{
						// Stable schema/lifecycle/integrity reference — cached first so
						// system-prompt edits don't invalidate it. Cite per rule 7.
						type: 'text',
						text: TIER_1_REFERENCE,
						cache_control: { type: 'ephemeral' }
					},
					{
						type: 'text',
						text: SYSTEM_PROMPT,
						cache_control: { type: 'ephemeral' }
					}
				],
				tools: activeTools,
				messages
			});
		} catch (err: any) {
			if (err instanceof Anthropic.RateLimitError) {
				return { answer: '', toolCalls, model, usage: { ...usage, estCostUsd: calcCost(model, usage) }, error: 'Anthropic rate limit hit. Please retry in a moment.' };
			}
			if (err instanceof Anthropic.AuthenticationError) {
				return { answer: '', toolCalls, model, error: 'ANTHROPIC_API_KEY is invalid.' };
			}
			throw err;
		}

		usage.inputTokens += response.usage.input_tokens ?? 0;
		usage.outputTokens += response.usage.output_tokens ?? 0;
		usage.cacheReadTokens += response.usage.cache_read_input_tokens ?? 0;
		usage.cacheWriteTokens += response.usage.cache_creation_input_tokens ?? 0;

		// Per-question cost cap (defense in depth on top of MAX_ITERATIONS).
		// Only Opus is expensive enough to plausibly hit this on a real question.
		if (model === 'claude-opus-4-7') {
			const costSoFar = calcCost(model, usage);
			if (costSoFar > MAX_COST_OPUS_USD) {
				return {
					answer: '',
					toolCalls,
					model,
					usage: { ...usage, estCostUsd: costSoFar },
					error: `Per-question cost cap of $${MAX_COST_OPUS_USD.toFixed(2)} exceeded on Opus. Consider rephrasing the question more narrowly or switching to Sonnet.`
				};
			}
		}

		const toolUseBlocks = response.content.filter((b): b is Anthropic.ToolUseBlock => b.type === 'tool_use');

		if (response.stop_reason === 'end_turn' || toolUseBlocks.length === 0) {
			const text = response.content
				.filter((b): b is Anthropic.TextBlock => b.type === 'text')
				.map(b => b.text)
				.join('\n\n')
				.trim();
			return {
				answer: text,
				toolCalls,
				model,
				usage: { ...usage, estCostUsd: calcCost(model, usage) }
			};
		}

		messages.push({ role: 'assistant', content: response.content });

		const toolResults: Anthropic.ToolResultBlockParam[] = [];
		for (const block of toolUseBlocks) {
			try {
				const out = await runTool(block.name, block.input ?? {});
				toolCalls.push({ name: block.name, input: block.input, result: out });
				toolResults.push({
					type: 'tool_result',
					tool_use_id: block.id,
					content: JSON.stringify(out)
				});
			} catch (err: any) {
				toolResults.push({
					type: 'tool_result',
					tool_use_id: block.id,
					content: `Error: ${err?.message ?? String(err)}`,
					is_error: true
				});
			}
		}

		messages.push({ role: 'user', content: toolResults });
	}

	return {
		answer: '',
		toolCalls,
		model,
		usage: { ...usage, estCostUsd: calcCost(model, usage) },
		error: 'Agent exceeded max iterations without a final answer.'
	};
}
