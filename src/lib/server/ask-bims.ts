import Anthropic from '@anthropic-ai/sdk';
import {
	connectDB, WaxBatch, WaxFillingRun, TemperatureAlert,
	PartDefinition, Equipment, CartridgeRecord, ReagentBatchRecord,
	ReceivingLot, CalibrationRecord, ServiceTicket, TemperatureReading,
	WorkInstruction, LotRecord, InventoryTransaction, AskBimsCostLog,
	Experiment, ReagentCatalog, ReagentInventory,
	ProtocolDefinition, ProtocolExecution,
	Sample, Analyte, AnalysisProfile, CalibratedAnalysis,
	WorkflowViolation, ValidationSession, ApprovalRequest,
	DeviceEvent, ScannerEvent, ShippingLot, ShippingPackage,
	User, Document, AssayDefinition,
	SpecLimit, FmeaRecord, BimsAnomaly, AskBimsConversationLog,
	generateId
} from './db';
import { loadUnifiedRuns } from './analytics/runs-feed';
import { capability, tTest, linearRegression } from './analytics/stats';
import { hasPermission } from './permissions';
import { getCheckedOutCartridgeIds } from './checkout-utils';
import { TIER_1_REFERENCE } from './ask-bims-tier1';
import { searchDocs } from './docs-search';
import { lookupEquipment } from './equipment-datasheets';
import { lookupChemical, checkCompatibility } from './chemical-inventory';
import { resolveLocation, getTagMapSize } from './floor-plan';
import { summarizeFromAnomalies, computeSummary } from './integrity-scan';

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

/**
 * Compress a tool's input/result into short previews safe for storage in the
 * conversation log. We DON'T want heavy result payloads (50KB JSON dumps) to
 * land in Mongo — just enough so the log is browseable.
 */
function previewToolPayload(payload: unknown, charCap = 240): string {
	if (payload == null) return '';
	try {
		const s = typeof payload === 'string' ? payload : JSON.stringify(payload);
		if (s.length <= charCap) return s;
		return s.slice(0, charCap) + '…';
	} catch {
		return '[unserializable]';
	}
}

/**
 * Conversation telemetry — captures the actual question + answer + tool trail.
 * Fire-and-forget like logCostTelemetry. Joined to AskBimsCostLog by
 * responseId so the admin history view can render cost + content together.
 *
 * PII redaction (redactPii) is currently a no-op pending policy. When the
 * policy lands, swap in NER/allowlist redaction; this site is the gate.
 */
async function logConversationTelemetry(entry: {
	responseId: string;
	userId: string;
	username?: string;
	model: AskBimsModel;
	question: string;
	answer: string;
	toolCalls: Array<{ name: string; input: unknown; result: unknown }>;
	costUsd: number;
	durationMs: number;
	errorClass?: string;
	confidence?: AskBimsConfidence;
	confidenceReasons?: string[];
}): Promise<void> {
	try {
		await AskBimsConversationLog.create({
			responseId: entry.responseId,
			userId: entry.userId,
			username: entry.username,
			timestamp: new Date(),
			model: entry.model,
			question: redactPii(entry.question),
			answer: redactPii(entry.answer),
			toolCalls: entry.toolCalls.map(tc => ({
				name: tc.name,
				inputPreview: previewToolPayload(tc.input, 160),
				resultPreview: previewToolPayload(tc.result, 320)
			})),
			toolCallCount: entry.toolCalls.length,
			uniqueToolCount: new Set(entry.toolCalls.map(tc => tc.name)).size,
			costUsd: entry.costUsd,
			durationMs: entry.durationMs,
			errorClass: entry.errorClass,
			confidence: entry.confidence ?? null,
			confidenceReasons: entry.confidenceReasons ?? []
		});
	} catch (err) {
		console.error('[ASK-BIMS] conversation log write failed (non-fatal):', err);
	}
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
		description: `**Source of truth** for current 15ml wax tube BULK MATERIAL inventory (the raw wax we use to fill cartridges — NOT the count of cartridges that have already been wax-filled).
Queries: ReceivingLot where part.partNumber = ${WAX_TUBE_PART_NUMBER} and status in (accepted, in_progress). Computes per-lot remaining volume from quantity × ${FULL_TUBE_VOLUME_UL} μL minus consumedUl.

Use when: "how much wax do we have" (bulk material), "wax inventory" (the tube stock), "wax runway", "will we run out of wax".
**Don't use for**: "how many cartridges are wax-filled", "how many wax-filled carts do I have", "carts in wax storage" — those are about PHYSICAL CARTRIDGES already wax-filled, use count_cartridges_by_status or list_cartridges_in_storage instead. Operator-speak warning: "how many cartridges can I fill" often means "how many wax-filled cartridges do I have stored" (asking about existing physical inventory), NOT "what's the wax-stock capacity." When unsure, ask one clarifying question rather than answering both interpretations.
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

Use when: "temperature alerts", "what's out of spec", "what alerted today", "unacknowledged alerts".
Don't use for: spot/current temperature reading (use get_current_temperatures); historical temperature trend or time-series (use get_temperature_history or temperature_excursion_summary); equipment reliability rollup (use equipment_uptime).`,
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
Don't use for: temperature ALERTS / events (use get_temperature_alerts); time-series history (use get_temperature_history); out-of-spec rollup (use temperature_excursion_summary); multi-equipment summary (use bulk_temperature_summary).
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
Don't use for: yield on a specific run (use get_run_yield); multi-run yield trend (use bulk_run_yields or yield_trends_by_robot); active runs in non-terminal status specifically (use list_active_runs — it filters terminal statuses); operator-filtered history (use find_runs_by_operator); single run's blocker diagnosis (use whats_blocking_run).

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

Use when: "what do I need to reorder", "low inventory", "running low" (about PT-CT-XXX parts in the BIMS part catalog).
Don't use for: a specific part by name/number (use find_part); chemical inventory (C-XXX / D-XXX codes — use lookup_chemical); research-side reagents (use list_reagent_inventory); single-lot consumption / runway forecast (use runway or inventory_burn_rate); count of cartridges ready for a phase transition (use count_cartridges_by_status — see rule 9).
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

Use when: "find cart X" (by barcode), "show cartridges in status Y", "cartridges from run Z".
Don't use for: counts/aggregates (use count_cartridges_by_status — it returns numbers, not lists); cartridges in storage specifically (use list_cartridges_in_storage); mfg lineage trace (use trace_cartridge or backward_genealogy); research-side fields like rawData/result (use find_research_cartridge); multi-barcode status snapshot (use bulk_cartridge_status); "how many can I [action]" upstream-queue questions (use count_cartridges_by_status per rule 9).`,
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

Use when: "list equipment", "what fridges do we have", "is robot X online" — the live equipment REGISTRY.
Don't use for: current temperature reading (use get_current_temperatures); spec sheet / datasheet URL / dimensions (use lookup_equipment_datasheet); physical floor location (use find_location); reliability/uptime rollup (use equipment_uptime); calibration history (use list_calibrations_due); open service tickets (use list_open_service_tickets).`,
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

Use when: "yield on run X" (single run), "scrap rate for run Y", "QC results for run Z" — when the user names ONE specific run.
Don't use for: yield across many runs / trend (use bulk_run_yields); yield per robot over time (use yield_trends_by_robot); scrap root-cause Pareto (use scrap_pareto); throughput in units/day (use production_throughput); cycle time analysis (use production_cycle_time).`,
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

Use when: "trace cart X" (quick mfg lineage — backing lot, wax run, wax source lot, QC, storage, reagent run if any).
Don't use for: deep traceability with shipment + customer (use backward_genealogy); reagent chain to stock chemicals (use trace_reagent_chain — research-side); given a LOT find downstream carts (use forward_genealogy); single cart's research-side test result / analysis / rawData (use find_research_cartridge); cartridge status lookup only (use find_cartridges or bulk_cartridge_status).
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

Use when: "how many cartridges did we make today", "current state of the floor", "cart counts", and per rule 9 **"how many cartridges can I [action] right now"** (count the upstream-queue status, e.g. status='backing' for "fill with wax", status='wax_stored' for "reagent-fill", status='released' for "ship").
Don't use for: a list of specific cartridges (use find_cartridges); cartridges in storage specifically (use list_cartridges_in_storage — pre-filtered to 'wax_stored'); multi-barcode lookup (use bulk_cartridge_status); WAX VOLUME / material inventory (use get_wax_tube_inventory — different concept, see rule 9).`,
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

Use when: "what's running now", "active runs", "what's on the floor right now" — runs in non-terminal status (excludes completed/aborted/voided/archived).
Don't use for: historical runs / "what ran today" (use list_recent_runs — wider window including terminal); single-run blocker diagnosis (use whats_blocking_run); yield on those runs (use get_run_yield single or bulk_run_yields multi); operator-filtered (use find_runs_by_operator).`,
		input_schema: { type: 'object', properties: {} }
	},
	{
		name: 'list_cartridges_in_storage',
		description: `Cartridges currently in wax_stored status, optionally filtered to a fridge.
Source: CartridgeRecord with status=wax_stored.

Use when: "what's in storage", "carts in the freezer", "stored carts in fridge X" — pre-filtered to CartridgeRecord.status='wax_stored'.
Don't use for: generic cartridge filter (use find_cartridges with status filter — supports any status); count-only (use count_cartridges_by_status); reagent/chemical inventory in a fridge (use list_reagent_inventory or lookup_chemical respectively); current fridge TEMP (use get_current_temperatures); equipment registry (use list_equipment).`,
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

Use when: "what's due for calibration", "upcoming calibrations", "what needs recalibrating" — equipment with nextCalibrationDue within the window.
Don't use for: calibration history (the most-recent record per equipment is implicit, but use find_validation_session for full session detail); equipment registry / online status (use list_equipment); SPU validation specifically (use list_validation_sessions); generic service requests (use list_open_service_tickets).`,
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

Use when: "temperature history of X", "show last 24h temps for fridge Y", "how stable was the temp" — time-series for ONE equipment.
Don't use for: current spot reading (use get_current_temperatures); alert events (use get_temperature_alerts); out-of-spec rollup summary (use temperature_excursion_summary); MULTI-equipment comparison (use bulk_temperature_summary); reliability/uptime percentage (use equipment_uptime).`,
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

Use when: "if this lot was bad, what's downstream", "what carts used lot X", recall scenarios — given a ReceivingLot, list every cart that consumed it.
Don't use for: backward direction (given a CART, find lots — use trace_cartridge or backward_genealogy); reagent chain to stock chemicals (use trace_reagent_chain); lot lookup itself (use find_receiving_lot); cross-referencing assay → shipments (use assay_lot_cross_reference).
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

Use when: deep traceability, "where did everything in this cart come from", regulatory audits — full upstream including shipment + customer.
Don't use for: lightweight trace (use trace_cartridge — faster, no shipment/customer joins); reagent chain to stock chemicals (use trace_reagent_chain); downstream impact from a lot (use forward_genealogy); single cart's research-side data only (use find_research_cartridge).
For a quick trace (without shipment/customer details), use trace_cartridge instead.`,
		input_schema: {
			type: 'object',
			properties: { cartridgeId: { type: 'string' } },
			required: ['cartridgeId']
		}
	},
	{
		name: 'check_data_integrity',
		description: `Surface the latest data-integrity findings. Reads from the bims_anomalies collection that the daily cron (07:00 UTC) writes — fast and consistent across the day. If the collection is empty (first run or cron hasn't ticked), falls back to a live recompute.
Covers seven checks: runs with null waxSourceLot, over-consumed receiving lots (consumedUl > capacity), stale equipment temperature reads (>4h), cartridges stuck in non-terminal status (>7d), orphan reagent-batch tube references, drift between PartDefinition.inventoryCount and accepted ReceivingLot totals, and legacy v1 cartridge status names that should have been migrated.

Use when: data quality audit, "are there any data issues", before answering high-stakes questions to verify data is sane. Call this preemptively if you suspect data issues affect your answer.
Don't use for: persistent anomaly history (use list_recent_anomalies — that surface is fed by the daily cron and tracks lifecycle); a specific workflow deviation (use list_workflow_violations); a single cart's integrity (use trace_cartridge or find_research_cartridge — those emit their own dataIntegrityNotes); FMEA risk ranking (use fmea_risk_query).`,
		input_schema: {
			type: 'object',
			properties: {}
		}
	},
	{
		name: 'production_throughput',
		description: `Daily cartridge throughput — counts cartridges that entered each phase (backing, wax filling, QC accepted, reagent filled, shipped) per day over a window.
Source: CartridgeRecord aggregation by phase-transition timestamps.

Use when: "throughput trend", "how many carts per day this week", "are we keeping up" — daily phase-entry counts (backing, wax filling, QC accepted, reagent filled, shipped).
Don't use for: cycle-time per process (use production_cycle_time); yield % over time (use yield_trends_by_robot or bulk_run_yields); single run's count (use get_run_details); count of cartridges in a CURRENT status (use count_cartridges_by_status).`,
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

Use when: "how often was X out of spec", "temperature stability of Y", "excursions on Z this week" — minutes-out-of-spec + longest excursion for ONE equipment.
Don't use for: current spot reading (use get_current_temperatures); alert events list (use get_temperature_alerts); full time-series sample points (use get_temperature_history); MULTI-equipment comparison (use bulk_temperature_summary); reliability percentage (use equipment_uptime).`,
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

Use when: "how fast are we using X", "burn rate for Y", "when will we run out of Z" — units-per-day consumption + stdev + projected days-to-empty for a PT-CT-XXX part.
Don't use for: chemical inventory (use chemical_burn_rate for C-XXX/D-XXX codes); current stock snapshot (use find_part); reorder list (use list_low_inventory_parts); finer runway with ReceivingLot cross-check (use runway).`,
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

Use when: "how long will X last", "runway for Y", "do we have enough Z for next month" — projected days-to-stockout with ReceivingLot cross-check.
Don't use for: chemical runway (use chemical_burn_rate); raw burn rate without inventory cross-check (use inventory_burn_rate); reorder threshold list (use list_low_inventory_parts); WAX-specific runway (use get_wax_tube_inventory — it has wax-tube semantics).`,
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

Use when: "why isn't run X moving", "what's blocking run Y", "stuck run" — single non-terminal wax run, diagnoses deck/cooling-tray/wax-source/QC blockers.
Don't use for: completed runs (use get_run_details); finding which runs are running (use list_active_runs); broad health audit (use check_data_integrity); reagent-fill blockers (this tool is wax-specific).`,
		input_schema: {
			type: 'object',
			properties: { runId: { type: 'string' } },
			required: ['runId']
		},
		// Cache breakpoint at the end of the original BIMS tool core (principle #10
		// — cache-aware partitioning). Phase B+ tools land after this in the
		// "evolving" tier — description changes there don't invalidate this prefix.
		// Per Anthropic SDK, cache_control belongs on the Tool object, not inside
		// input_schema (the prior placement was silently a no-op).
		cache_control: { type: 'ephemeral' }
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
	},
	{
		name: 'find_location',
		description: `Resolve an equipment tag, zone name, or "where is X" question into a spatial description of the new shared Houston lab.
Source: data/equipment-datasheets/ (tag→zone via the Location column) + the codified floor plan inside src/lib/server/floor-plan.ts.

Use when: "where is fridge 3", "what's near the cartridge oven", "show me everything in tissue culture", "which side of the lab is the OT-2 on", "where do I find B-01".

Returns the zone (Tissue Culture, Open Lab, Manufacturing, R&D, Prototyping, Inventory, or Office), a plain-English position description (north wall, lower-left, etc.), the owning org (Brevitest or Fannin), and a list of other equipment that lives in the same zone.

Don't use for: live equipment status (use list_equipment); manufacturer datasheets or power draw (use lookup_equipment_datasheet); generic internet questions about lab layout.`,
		input_schema: {
			type: 'object',
			properties: {
				query: { type: 'string', description: 'Equipment tag (B-NN, F-NN, E-NN), zone name (Tissue Culture, Open Lab, Manufacturing, R&D, Prototyping), or an equipment-name fragment.' }
			},
			required: ['query']
		}
	},
	{
		name: 'lookup_chemical',
		description: `Search the shared-lab chemical inventory by name, CAS number, or tag (C-XXX for Brevitest, D-XXX for Fannin).
Source: data/chemical-inventory/brevitest.csv (149 rows) + fannin.csv (55 rows). Each row has Inventory Code, Item, Current On Hand, CAS #, IFC Hazard Class, Physical State, HMIS Qty/Units, NFPA codes, Primary Chemical Name, Storage Code, Classification Notes, Inventory Link.

Use when: "where's the methanol", "how much sodium azide do we have", "what's chemical C-042", "find any chemicals with CAS 67-56-1", "list HTX chemicals".

Returns up to 10 matching chemicals with name, CAS, hazard class, quantity on hand, storage code, and owning org (Brevitest or Fannin).

When the same chemical is stocked by BOTH orgs (about a dozen — DMSO, IPA, ethanol, PBS, NaOH, BSA, glycerol, agarose, DTT, TCEP, NaCl, sucrose) the result surfaces a dual-stocking note in dataIntegrityNotes so the operator knows to confirm which bottle they want — the two bottles may have different lot numbers, opening dates, or storage locations.

Don't use for: prepared reagents in the research catalog (use list_reagent_catalog/list_reagent_inventory); part-catalog items like PT-CT-114 (use find_part); equipment specs (use lookup_equipment_datasheet).`,
		input_schema: {
			type: 'object',
			properties: {
				query: { type: 'string', description: 'Chemical name fragment, CAS number, or inventory code (C-NNN / D-NNN). Case-insensitive substring or AND-of-words match.' },
				hazardClass: { type: 'string', description: 'Optional filter — IFC hazard code such as "HTX", "TOX", "FLAM", "OX", "COR".' },
				org: { type: 'string', enum: ['brevitest', 'fannin', 'all'], description: 'Default: all. Restrict to one org\'s stock.' },
				limit: { type: 'number', description: 'Max results (default 10, max 25).' }
			},
			required: ['query']
		}
	},
	{
		name: 'list_experiments',
		description: `List research experiments from the shared Mongo (research-v2 app's collection — read-only from BIMS).
Source: Experiment model (collection: experiments). Status enum: draft / underway / completed.

Use when: "what experiments are running", "recent research", "experiments in the Wellness program", broad research-side overview.
Don't use for: a specific experiment by name (use find_experiment); arm-level cartridges (use get_experiment_arm_cartridges); a single research cartridge's data (use find_research_cartridge).

Defaults: returns up to 20 most-recently-updated. No status/program filter applied unless specified.`,
		input_schema: {
			type: 'object',
			properties: {
				program: { type: 'string', description: 'Optional — filter by program name (e.g., "Wellness", "Fluorescence Platform")' },
				status: { type: 'string', description: 'Optional — one of: draft | underway | completed' },
				sinceDays: { type: 'number', description: 'Optional — only experiments updated within this window' },
				limit: { type: 'number', description: 'Max results (default 20, max 50)' }
			}
		}
	},
	{
		name: 'find_experiment',
		description: `Look up a single research experiment by _id (nanoid) or name fragment.
Source: Experiment model. Returns full experiment with arm summaries (name, assay, cartridge count per arm) but NOT individual arm cartridges — call get_experiment_arm_cartridges for that.

Use when: user mentions a specific experiment name or ID.
Don't use for: listing many experiments (use list_experiments); the cartridges in a specific arm (use get_experiment_arm_cartridges).`,
		input_schema: {
			type: 'object',
			properties: {
				query: { type: 'string', description: 'Experiment _id (nanoid) OR a name fragment (case-insensitive)' }
			},
			required: ['query']
		}
	},
	{
		name: 'get_experiment_arm_cartridges',
		description: `Given an experiment ID + arm index, list every cartridge in that arm joined with its CartridgeRecord status, raw-data presence, and result.
Source: Experiment.arms[armIndex].cartridges joined to CartridgeRecord by barcode.

Use when: "what carts are in arm 2 of experiment X", "which cartridges in this arm are completed", "show me the results so far on arm Y".
Don't use for: cartridges across many experiments (use find_cartridges with experiment filter); a single cartridge deep-dive (use find_research_cartridge).

Result includes a defensive note when any cartridge carries the legacy currentPhase field instead of status — the BIMS currentPhase→status migration is incomplete in 12 files.`,
		input_schema: {
			type: 'object',
			properties: {
				experimentId: { type: 'string', description: 'Experiment _id (nanoid)' },
				armIndex: { type: 'number', description: 'Arm index (0-based)' }
			},
			required: ['experimentId', 'armIndex']
		}
	},
	{
		name: 'list_reagent_catalog',
		description: `List entries from the research-v2 reagent type registry (catalog of stock + prepared reagents, with parent/variant tree).
Source: ReagentCatalog model. Each entry: name, parentId (variant tree), type ('stock' | 'prepared'), category, manufacturer, default concentration, variants[], protocolDefinitionId.

Use when: "what antibodies do we have", "list active beads variants", "stock chemicals in catalog", browsing the reagent type registry.
Don't use for: physical items in the lab (use list_reagent_inventory); a single catalog entry by ID (use find_reagent_catalog); how to MAKE a prepared reagent (use find_protocol).

Caps: 50 results. variants[].parameterValues are immutable per DOMAIN-26 — never edit; create a new variant.`,
		input_schema: {
			type: 'object',
			properties: {
				category: { type: 'string', description: 'Optional — antibody | bead | buffer | chemical | QD | linker | protein | etc.' },
				type: { type: 'string', description: 'Optional — stock | prepared' },
				hasVariants: { type: 'boolean', description: 'Optional — true to include only entries with at least one variant' },
				limit: { type: 'number', description: 'Max results (default 30, max 50)' }
			}
		}
	},
	{
		name: 'find_reagent_catalog',
		description: `Look up a reagent catalog entry by _id (nanoid) or name fragment. Returns full entry including variants.
Source: ReagentCatalog model.

Use when: user asks about a specific reagent type — "tell me about Active Beads — Cortisol", "what variants of BSA do we have".
Don't use for: a physical inventory item (use find_reagent_inventory); listing the whole catalog (use list_reagent_catalog).`,
		input_schema: {
			type: 'object',
			properties: {
				query: { type: 'string', description: 'Catalog _id (nanoid) OR name fragment (case-insensitive)' }
			},
			required: ['query']
		}
	},
	{
		name: 'list_reagent_inventory',
		description: `List physical reagent items (the lab's actual barcoded bottles/tubes/vials).
Source: ReagentInventory model. Each item: _id is the UUID barcode, catalogId→catalog entry, variantKey, type, status (active/depleted/expired/discarded), volume, location, expirationDate, preparedFromExecutionId.

Use when: "what's expiring in the next 30 days", "active items of catalog X", "what bead variants do we have on hand", physical-stock questions.
Don't use for: catalog entries (use list_reagent_catalog); a single item by barcode (use find_reagent_inventory); per-variant counts/rollups (use count_inventory_by_variant — required to avoid pooling different antibody clones).

Defaults: status='active'. Pass status='all' for everything. Caps: 50 results.

Variant rule: when filtering by catalogId, ALSO pass variantKey when the user mentions a specific variant — different variants are different reagents and should never be pooled.`,
		input_schema: {
			type: 'object',
			properties: {
				catalogId: { type: 'string', description: 'Optional — filter to one catalog entry' },
				variantKey: { type: 'string', description: 'Optional — filter to one variant within a catalog (use with catalogId)' },
				status: { type: 'string', description: 'active | depleted | expired | discarded | all (default: active)' },
				nearExpiryDays: { type: 'number', description: 'Optional — only items expiring within this many days (active only)' },
				limit: { type: 'number', description: 'Max results (default 30, max 50)' }
			}
		}
	},
	{
		name: 'find_reagent_inventory',
		description: `Look up a single physical reagent item by its UUID barcode. Resolves catalogName and variantLabel via a join to ReagentCatalog so the answer surfaces both the type and the specific variant.
Source: ReagentInventory + ReagentCatalog.

Use when: "what's in inventory item X", "scan barcode Y", any single-item lookup.
Don't use for: catalog entries (use find_reagent_catalog); listing many items (use list_reagent_inventory).`,
		input_schema: {
			type: 'object',
			properties: {
				barcode: { type: 'string', description: 'UUID barcode (the inventory item _id)' }
			},
			required: ['barcode']
		}
	},
	{
		name: 'count_inventory_by_variant',
		description: `Aggregate inventory counts for one catalog entry, GROUPED BY variantKey + status. The right tool for "how much of variant X do we have" — never use list_reagent_inventory + manual count for this, because rolling up by catalogId without variantKey would pool different variants together (per DOMAIN-26 immutability rule).
Source: ReagentInventory aggregate by (variantKey, status).

Use when: "inventory by variant for catalog X", "how many active items per variant", catalog-level rollups.
Don't use for: catalog metadata (use find_reagent_catalog); listing individual items (use list_reagent_inventory).`,
		input_schema: {
			type: 'object',
			properties: {
				catalogId: { type: 'string', description: 'ReagentCatalog _id to roll up' }
			},
			required: ['catalogId']
		}
	},
	{
		name: 'list_protocols',
		description: `List protocol definitions (the lab's versioned recipes — Excel-imported via the protocol parser).
Source: ProtocolDefinition model. Status enum: draft / active / archived.

Use when: "what active protocols do we have", "list conjugation protocols", "which protocols make X reagent", browsing the recipe library.
Don't use for: a specific protocol by name (use find_protocol); execution records (use list_protocol_executions).

Defaults: returns active protocols sorted by updatedAt desc. Pass status='all' for everything. Caps: 50 results.`,
		input_schema: {
			type: 'object',
			properties: {
				category: { type: 'string', description: 'Optional — conjugation | fill | QD-synthesis | quantification | etc.' },
				status: { type: 'string', description: 'draft | active | archived | all (default: active)' },
				outputCatalogId: { type: 'string', description: 'Optional — only protocols whose outputCatalogId matches' },
				limit: { type: 'number', description: 'Max results (default 30, max 50)' }
			}
		}
	},
	{
		name: 'find_protocol',
		description: `Look up a single protocol definition by _id (nanoid) or name fragment. Returns full structure: parameters, materials, steps, version history.
Source: ProtocolDefinition.

Critical caveat surfaced as dataIntegrityNotes: cellMap is currently EMPTY on every live protocol — protocols were extracted before the parser shipped. Editing input parameters does NOT cascade through formulas; reagent amounts stay at static-extracted values. Re-extraction is needed per protocol. Bug doc: docs/protocol-extraction-cellmap-bug.md.

Use when: "show me protocol X", "what's in Active Beads v2", "how to make {reagent}".
Don't use for: listing many protocols (use list_protocols); execution records (use list_protocol_executions or get_protocol_execution_details).`,
		input_schema: {
			type: 'object',
			properties: {
				query: { type: 'string', description: 'Protocol _id (nanoid) OR name fragment (case-insensitive)' }
			},
			required: ['query']
		}
	},
	{
		name: 'list_protocol_executions',
		description: `List records of protocol executions (lab notebook entries — every time a protocol was actually run).
Source: ProtocolExecution model. Status enum: in_progress / completed / aborted.

Use when: "recent executions of protocol X", "what was Jacob running today", "completed Active Beads runs this week", history queries.
Don't use for: protocol definitions (use list_protocols); a single execution's details (use get_protocol_execution_details); the resulting inventory items (use find_reagent_inventory on the output barcodes).

Filterable by definitionId (one protocol's runs), variantKey (one variant's runs), status, sinceDays window, executedBy (user _id). Caps: 50 results.`,
		input_schema: {
			type: 'object',
			properties: {
				definitionId: { type: 'string', description: 'Optional — only executions of this protocol' },
				variantKey: { type: 'string', description: 'Optional — only executions targeting this variant' },
				status: { type: 'string', description: 'Optional — in_progress | completed | aborted' },
				sinceDays: { type: 'number', description: 'Optional — only executions started within this window' },
				executedBy: { type: 'string', description: 'Optional — user _id (nanoid, exactly 21 url-safe chars) OR a name fragment (anything else; matched case-insensitive against executedByName)' },
				limit: { type: 'number', description: 'Max results (default 30, max 50)' }
			}
		}
	},
	{
		name: 'get_protocol_execution_details',
		description: `Full record for one protocol execution by _id. Includes parameter values used, materials scanned (with their inventory barcodes), step records, and output aliquots produced.
Source: ProtocolExecution + ProtocolDefinition (joined for definition name + version).

Use when: "what happened in execution X", "what materials went into Y", "show me the step record for Z".
Don't use for: listing many executions (use list_protocol_executions); the protocol's recipe (use find_protocol).`,
		input_schema: {
			type: 'object',
			properties: {
				executionId: { type: 'string', description: 'ProtocolExecution _id (nanoid)' }
			},
			required: ['executionId']
		}
	},
	{
		name: 'list_samples',
		description: `List experiment samples (research-v2). Each sample: experimentId, analyteId+name, sampleNumber, concentration, diluent, matrix, description.
Source: Sample model.

Use when: "samples in experiment X", "samples for analyte Y", "what's been collected", sample-registry questions.
Don't use for: cartridge sample fields (use find_research_cartridge — that returns the cart's sample sub-doc).`,
		input_schema: {
			type: 'object',
			properties: {
				experimentId: { type: 'string', description: 'Optional — filter to one experiment' },
				analyteId: { type: 'string', description: 'Optional — filter to one analyte' },
				limit: { type: 'number', description: 'Max results (default 50, max 200)' }
			}
		}
	},
	{
		name: 'list_analytes',
		description: `List the analytes registered in research-v2 (what the lab measures).
Source: Analyte model. Each: name, units, dynamicRange{low,high}, lod, loq, referenceRange{low,high}, description.

Use when: "what do we measure", "list analytes", "what's the LOD for X", reference-range questions.
Don't use for: sample concentrations (use list_samples); the assay BCODE catalog (use find_part for PT-CT-XXX).`,
		input_schema: { type: 'object', properties: {} }
	},
	{
		name: 'list_analysis_profiles',
		description: `List analysis profiles (raw-data processing configs).
Source: AnalysisProfile model. Each profile sets sumColumns (default f1..f8 + clear + nir), denominatorColumn (f3), ratioNumerators (f5,f7), output columns and channels.

Use when: "what analysis profiles exist", "how do we process spectro data", "configured ratios for X assay".
Don't use for: actual analysis runs on a cartridge (those live on the cart's analysis field — use find_research_cartridge); calibrated analyses (use list_calibrated_analyses).`,
		input_schema: { type: 'object', properties: {} }
	},
	{
		name: 'list_calibrated_analyses',
		description: `List calibrated analyses — calibration overlays on AnalysisProfile that apply per-cartridge channel exclusions and a correction exponent.
Source: CalibratedAnalysis model. Each: name, baseProfileId, cartridgeIds[], excludedChannels[], beadBarcode, tracerBarcode, correctionExponent, results, lastRunAt.

Use when: "what calibration runs do we have", "recent calibrated analyses", calibration-history questions.
Don't use for: a single calibration run by name (use find_calibrated_analysis); the underlying analysis profile (use list_analysis_profiles).`,
		input_schema: {
			type: 'object',
			properties: {
				name: { type: 'string', description: 'Optional — filter by name fragment (case-insensitive)' },
				sinceDays: { type: 'number', description: 'Optional — only runs with lastRunAt within this many days' },
				limit: { type: 'number', description: 'Max results (default 30, max 50)' }
			}
		}
	},
	{
		name: 'find_calibrated_analysis',
		description: `Look up a single calibrated analysis by _id (nanoid) or name fragment.
Source: CalibratedAnalysis model.

Use when: "show me calibrated analysis X", "what cartridges and channel exclusions are in calibration Y".
Don't use for: listing many (use list_calibrated_analyses); the base profile (use list_analysis_profiles).`,
		input_schema: {
			type: 'object',
			properties: {
				query: { type: 'string', description: 'CalibratedAnalysis _id (nanoid) OR name fragment (case-insensitive)' }
			},
			required: ['query']
		}
	},
	{
		name: 'get_capability_trend',
		description: `Rolling Cp/Cpk over time for a process+metric, with regression slope on the Cpk series. Bins by week (default) or day.
Source: loadUnifiedRuns() + SpecLimit + capability() per bin + linearRegression on Cpk.

Use when: "is our wax-yield Cpk improving", "capability trend for cycle time", "are we drifting on Cpk".
Don't use for: a single-point Cpk vs target (use cpk_vs_target); raw run lists (use list_recent_runs); per-segment yield (use yield_trends_by_robot or yield_breakdown if available).

Metric: cycleTime | yield | acceptedCount.`,
		input_schema: {
			type: 'object',
			properties: {
				processType: { type: 'string', description: 'wi-01 | wax | reagent | laser-cut | etc.' },
				metric: { type: 'string', description: 'cycleTime | yield | acceptedCount' },
				sinceDays: { type: 'number', description: 'Window in days (default 30, min 7, max 365)' },
				granularity: { type: 'string', description: 'week (default) | day' }
			},
			required: ['processType', 'metric']
		}
	},
	{
		name: 'cpk_vs_target',
		description: `Current Cp/Cpk for a process+metric versus a target Cpk, with a suggestion: shift the mean (off-center) or reduce variation (sigma).
Source: loadUnifiedRuns() over recent window + SpecLimit + capability().

Use when: "are we meeting Cpk target for X", "how far are we from 1.33 on cycle time", "what's the gap to target".
Don't use for: trend over time (use get_capability_trend); raw values (use list_recent_runs or temperature_excursion_summary).`,
		input_schema: {
			type: 'object',
			properties: {
				processType: { type: 'string' },
				metric: { type: 'string', description: 'cycleTime | yield | acceptedCount' },
				targetCpk: { type: 'number', description: 'Default 1.33 (industry-standard "process is capable" threshold)' },
				sinceDays: { type: 'number', description: 'Window for current Cpk (default 30, min 7, max 365)' }
			},
			required: ['processType', 'metric']
		}
	},
	{
		name: 'shift_correlation',
		description: `Two-sample t-test of a metric (cycleTime, yield) between day shifts (morning + afternoon) and night shifts. Returns t, p-value, group means, significance flag.
Source: loadUnifiedRuns() bucketed by inferShift(startTime); tTest from analytics/stats.

Use when: "do night shifts have higher cycle time", "is yield different at night", "is shift a driver".
Don't use for: arbitrary segment comparisons (no tool for that yet — surfacing two-shift correlation is the v1).`,
		input_schema: {
			type: 'object',
			properties: {
				metric: { type: 'string', description: 'cycleTime | yield (default cycleTime)' },
				sinceDays: { type: 'number', description: 'Default 30, min 7, max 365' },
				processType: { type: 'string', description: 'Optional — filter to one process' }
			}
		}
	},
	{
		name: 'fmea_risk_query',
		description: `List FMEA records sorted by RPN (Risk Priority Number, descending). Optionally filter by minimum RPN threshold or status.
Source: FmeaRecord model.

Use when: "what are our highest-risk failure modes", "list open FMEAs above RPN 100", "FMEA risk heatmap data".
Don't use for: SPC signal investigation (use check_data_integrity or anomaly tools); CAPA/NC lookups (those models aren't built yet).`,
		input_schema: {
			type: 'object',
			properties: {
				rpnThreshold: { type: 'number', description: 'Minimum RPN to include (default 0)' },
				statusFilter: { type: 'string', description: 'Optional — draft | active | retired | etc.' },
				limit: { type: 'number', description: 'Max records (default 20, max 100)' }
			}
		}
	},
	{
		name: 'forecast_capability_impact',
		description: `Sensitivity analysis on Cp/Cpk — "if sigma drops X%, what's the new Cpk?". Recomputes capability with scaled sigma and/or shifted mean on the current dataset.
Source: loadUnifiedRuns() over 30 days + SpecLimit + capability() recomputed with synthetic values.

Use when: "if we cut variation in half, what Cpk would we hit", "would centering the process meet target", what-if analysis.
Don't use for: actual current Cpk (use cpk_vs_target); historical trend (use get_capability_trend).`,
		input_schema: {
			type: 'object',
			properties: {
				processType: { type: 'string' },
				metric: { type: 'string', description: 'cycleTime | yield' },
				scenario: {
					type: 'object',
					description: '{sigmaReductionPct?: number (0-100), meanShift?: number (±)} — at least one required',
					properties: {
						sigmaReductionPct: { type: 'number' },
						meanShift: { type: 'number' }
					}
				}
			},
			required: ['processType', 'metric']
		}
	},
	{
		name: 'bulk_temperature_summary',
		description: `Temperature summary for MANY equipment names in one call. Returns per-equipment min/max/avg, in-spec count, alert count over the window. Replaces N×temperature_excursion_summary iteration.
Source: Equipment + TemperatureReading + TemperatureAlert (per name).

Use when: "summarize temps across all fridges", "compare freezer stability across units", any multi-equipment temp question.
Don't use for: a single equipment (use temperature_excursion_summary); current spot temperature (use get_current_temperatures); time-series detail (use get_temperature_history).

Caps: 20 equipment names per call. Window 1-30 days (default 7).`,
		input_schema: {
			type: 'object',
			properties: {
				equipmentNames: { type: 'array', items: { type: 'string' }, description: 'Array of equipment name fragments (case-insensitive partial match each)' },
				sinceDays: { type: 'number', description: 'Window in days (default 7, min 1, max 30)' }
			},
			required: ['equipmentNames']
		}
	},
	{
		name: 'bulk_cartridge_status',
		description: `Status snapshot for MANY cartridge barcodes in one call. Returns per-cart status (or currentPhase fallback), finalizedAt, result, QC sub-statuses, plus an aggregate statusCounts roll-up.
Source: CartridgeRecord projection by _id array.

Use when: "status of these 30 carts", "what's the QC outcome on this batch", multi-cart status checks.
Don't use for: a single cartridge deep-dive (use trace_cartridge / find_research_cartridge); cartridges-by-query (use find_cartridges with status filter).

Caps: 100 barcodes per call.`,
		input_schema: {
			type: 'object',
			properties: {
				barcodes: { type: 'array', items: { type: 'string' }, description: 'Array of cartridge barcodes (UUIDs)' }
			},
			required: ['barcodes']
		}
	},
	{
		name: 'find_runs_by_operator',
		description: `Recent runs filtered by operator name (case-insensitive substring across all process types). Closes the gap that previously made Opus refuse operator-history questions ("what carts did Nick make today?").
Source: loadUnifiedRuns() + post-filter on run.operator regex.

Use when: "what has {{operator}} run lately", "{{operator}}'s yield this week", any operator-history question.
Don't use for: a single run's detail (use get_run_details); recent runs across all operators (use list_recent_runs).`,
		input_schema: {
			type: 'object',
			properties: {
				operator: { type: 'string', description: 'Operator name or username fragment (case-insensitive)' },
				sinceDays: { type: 'number', description: 'Default 7, min 1, max 90' },
				processType: { type: 'string', description: 'Optional — wi-01 | wax | reagent | laser-cut | etc.' }
			},
			required: ['operator']
		}
	},
	{
		name: 'trace_reagent_chain',
		description: `**The grail tool.** Given a cartridge barcode, walks the full reagent provenance chain end-to-end: cartridge → reagentChain[] → ProtocolExecution → materialsUsed inventory items → recurse on prepared items → terminate at stock items (purchased reagents). Returns a tree with every protocol execution, every input barcode, and every stock manufacturer in the lineage.
Source: CartridgeRecord.reagentChain → ProtocolExecution → ReagentInventory (recursive on preparedFromExecutionId).

Use when: "what physical reagents went into cartridge X", "trace the provenance of cart Y", "list every stock chemical in cart Z's lineage", recall scenarios, regulatory traceability.
Don't use for: manufacturing lineage like backing/wax/reagent runs (use backward_genealogy or trace_cartridge); a single execution's details (use get_protocol_execution_details); a single inventory item (use find_reagent_inventory).

Caps: default depth 8 (max 12), 200 total nodes visited, cycle-protected. Surfaces dataIntegrityNotes when:
- reagentChain[] is empty on the cartridge (most carts today — per Jacob, the attach UI is deferred; no backfill)
- an executionId or inventoryId fails to resolve (orphan reference)
- the depth or node cap is hit

This is what makes Ask BIMS recall-grade for compliance: with one call you can answer "what stock products are downstream of supplier lot X if it's recalled?".`,
		input_schema: {
			type: 'object',
			properties: {
				cartridgeBarcode: { type: 'string', description: 'CartridgeRecord _id (UUID barcode)' },
				maxDepth: { type: 'number', description: 'Optional — recursion depth cap (default 8, max 12)' }
			},
			required: ['cartridgeBarcode']
		}
	},
	{
		name: 'find_research_cartridge',
		description: `Single-cartridge deep-dive on the research-side fields: rawData presence, readouts, result, analysis, reagentChain, testExecution, testResult, sample.
Source: CartridgeRecord projection (research fields only — does NOT return manufacturing sub-objects like backing/waxFilling/reagentFilling). For mfg lineage use trace_cartridge or backward_genealogy.

Use when: "what's the test result for cart X", "show me the rawData / analysis for cart Y", "which assay was loaded on Z", any research-side question about one cartridge.
Don't use for: manufacturing lineage (use trace_cartridge or backward_genealogy); a list of cartridges (use find_cartridges); arm membership (use get_experiment_arm_cartridges).

Defensive query: handles both 'status' and legacy 'currentPhase' fields. Surfaces dataIntegrityNotes when:
- the cartridge uses legacy currentPhase (migration incomplete)
- finalizedAt is unset on a 'completed' cartridge (FREEZE-02 pending — Lambda doesn't stamp finalizedAt yet)
- reagentChain[] is empty (per Jacob, the attach UI is deferred — no traceability for now)`,
		input_schema: {
			type: 'object',
			properties: {
				barcode: { type: 'string', description: 'CartridgeRecord _id (the UUID barcode)' }
			},
			required: ['barcode']
		}
	},
	// === Phase 6.1 — Operational coverage ===
	{
		name: 'list_workflow_violations',
		description: `Pulls the SOP-deviation log we keep on every run — anything an operator did out-of-order, anything that ran outside the documented procedure, anything that got flagged for follow-up.
Source: WorkflowViolation model.

Use when: "what runs deviated from the SOP this week", "show me open violations", "any high-severity workflow issues", deviation review prep.
Don't use for: cartridge scrap reasons (use scrap_pareto or find_cartridges); approval requests for change control (use list_open_approval_requests).

Defaults: last 7 days, all severities, all statuses. Newest first. Hard cap 50.`,
		input_schema: {
			type: 'object',
			properties: {
				sinceDays: { type: 'number', description: 'Window in days (default 7, max 90)' },
				severity: { type: 'string', description: 'Optional — low | medium | high' },
				status: { type: 'string', description: 'Optional — open | resolved (open = resolved=false)' },
				limit: { type: 'number', description: 'Max results (default 50, max 50)' }
			}
		}
	},
	{
		name: 'list_validation_sessions',
		description: `Equipment validation runs — thermocouple checks, magnetometer calibrations, spectrophotometer validations, etc. Each session has a pass/fail outcome and the criteria it was checked against.
Source: ValidationSession model.

Use when: "has SPU-42 been validated this quarter", "show me failed thermocouple validations", "recent magnetometer checks", validation history per SPU.
Don't use for: routine calibration schedules (use list_calibrations_due); manufacturing run QC (use get_run_yield).

Defaults: last 30 days, all SPUs, all validation types, all statuses. Newest first. Hard cap 50.`,
		input_schema: {
			type: 'object',
			properties: {
				spuId: { type: 'string', description: 'Optional — SPU _id to filter to one device' },
				type: { type: 'string', description: 'Optional — validation type (thermocouple, magnetometer, spectrophotometer, etc.)' },
				status: { type: 'string', description: 'Optional — pending | in_progress | running | completed | failed | timed_out' },
				sinceDays: { type: 'number', description: 'Window in days (default 30, max 365)' },
				limit: { type: 'number', description: 'Max results (default 50, max 50)' }
			}
		}
	},
	{
		name: 'list_open_approval_requests',
		description: `Change-control approvals waiting on review — scrap approvals, deviation sign-offs, config changes, anything routed through our approval workflow that hasn't been decided yet.
Source: ApprovalRequest model where status is pending or in_review.

Use when: "what approvals are pending my review", "show me open scrap approvals", "any urgent change requests".
Don't use for: workflow deviations themselves (use list_workflow_violations); calibration records (use list_calibrations_due).

Defaults: newest first. Hard cap 50.`,
		input_schema: {
			type: 'object',
			properties: {
				targetType: { type: 'string', description: 'Optional — changeType filter: code | configuration | infrastructure | process | documentation | database' },
				requestType: { type: 'string', description: 'Optional — same as targetType (alias)' },
				limit: { type: 'number', description: 'Max results (default 50, max 50)' }
			}
		}
	},
	{
		name: 'equipment_uptime',
		description: `How much of a window a fridge or oven actually stayed in spec — uptime percentage, in-range count, out-of-range count, and how many gaps in the data (no reading for over an hour).
Source: TemperatureReading joined to Equipment thresholds (temperatureMinC/MaxC).

Use when: "what percent of last 30 days was Fridge 3 in range", "uptime for the cartridge oven", "how reliable is this equipment".
Don't use for: current temperature (use get_current_temperatures); excursion duration totals (use temperature_excursion_summary); calibration status (use list_calibrations_due).

Defaults: last 30 days. If we haven't set a target temperature range for that fridge/oven, we surface that limit cleanly and just report reading count + gap count.`,
		input_schema: {
			type: 'object',
			properties: {
				equipmentName: { type: 'string', description: 'Equipment name fragment (case-insensitive)' },
				sinceDays: { type: 'number', description: 'Window in days (default 30, max 90)' }
			},
			required: ['equipmentName']
		}
	},
	{
		name: 'list_open_service_tickets',
		description: `Equipment that's currently broken or in service — open or in-progress service tickets, sorted newest first.
Source: ServiceTicket model where status not in [closed].

Use when: "what equipment is currently broken", "open service tickets", "any high-priority repairs pending".
Don't use for: calibration due dates (use list_calibrations_due); equipment that's just powered off (use list_equipment).

Defaults: newest first. Hard cap 50.`,
		input_schema: {
			type: 'object',
			properties: {
				equipmentType: { type: 'string', description: 'Optional — filter to tickets on a specific equipment type when the operator names one' },
				sinceDays: { type: 'number', description: 'Only tickets created within this window (default: all open regardless of age)' },
				limit: { type: 'number', description: 'Max results (default 50, max 50)' }
			}
		}
	},
	{
		name: 'recent_device_events',
		description: `Recent device events from SPUs and Particle devices — assay loads, validations, uploads, resets, errors. Events older than 30 days are auto-trimmed so this is short-term diagnostic data, not deep history.
Source: DeviceEvent model (TTL = 30 days).

Use when: "what did device X do recently", "show me recent device errors", "any error events in the last hour".
Don't use for: barcode scanner activity (use recent_scanner_events); equipment temperature alerts (use get_temperature_alerts).

Defaults: last 24 hours, all devices, all event types. Hard cap 100.`,
		input_schema: {
			type: 'object',
			properties: {
				deviceId: { type: 'string', description: 'Optional — filter to one device by _id or serial' },
				eventType: { type: 'string', description: 'Optional — validate | load_assay | upload | reset | error | etc.' },
				sinceHours: { type: 'number', description: 'Window in hours (default 24, max 720)' },
				limit: { type: 'number', description: 'Max results (default 100, max 100)' }
			}
		}
	},
	{
		name: 'recent_scanner_events',
		description: `Recent barcode-scanner activity — scans, heartbeats, errors, trigger consumption events. Helpful for "why did the scanner go quiet" diagnostics.
Source: ScannerEvent model.

Use when: "why did the scanner go quiet", "scanner heartbeats today", "recent scan errors", "what did the scanner pick up in the last hour".
Don't use for: device events from SPUs/Particle (use recent_device_events); the bridge daemon's internal state (it's not stored).

Defaults: last 60 minutes, all devices, all event types. Hard cap 100.`,
		input_schema: {
			type: 'object',
			properties: {
				deviceId: { type: 'string', description: 'Optional — filter to one scanner' },
				sinceMinutes: { type: 'number', description: 'Window in minutes (default 60, max 1440)' },
				limit: { type: 'number', description: 'Max results (default 100, max 100)' }
			}
		}
	},
	{
		name: 'list_open_shipping_lots',
		description: `Shipping lots that aren't out the door yet — open, testing, or released but not yet shipped. Tells you what we owe customers and what's gated on what.
Source: ShippingLot model where status in [open, testing, released].

Use when: "what lots are waiting to ship", "any shipping lots in testing", "show me released-but-unshipped lots".
Don't use for: tracking a specific package (use find_shipping_package); cartridges currently in a shipping lot (use find_cartridges with the lot ID).

Defaults: newest first.`,
		input_schema: {
			type: 'object',
			properties: {}
		}
	},
	{
		name: 'find_shipping_package',
		description: `Find a shipping package by tracking number, the package's own barcode, or by a cartridge barcode that's inside it.
Source: ShippingPackage model.

Use when: "where is package <tracking>", "find shipment for cart X", "what's in package Y".
Don't use for: the parent shipping lot's status (use list_open_shipping_lots); cartridge lineage (use trace_cartridge or backward_genealogy).

Hard cap 10.`,
		input_schema: {
			type: 'object',
			properties: {
				query: { type: 'string', description: 'Tracking number, package barcode, or a cartridge barcode inside the package' }
			},
			required: ['query']
		}
	},
	{
		name: 'get_user_training',
		description: `Training-record lookup for one user — every WI/document they've been trained on, who trained them, and when.
Source: User.trainingRecords[] subdoc array.

ADMIN-GATED. Requires admin:full permission on the caller. If the caller isn't admin, the tool returns a clean refusal — it does NOT leak training data.

Use when: "has Nick been trained on WI-01", "list training records for user X" — and only when the operator asking is an admin.
Don't use for: lookup by document (use list_recent_document_changes); WI content (use search_work_instructions).`,
		input_schema: {
			type: 'object',
			properties: {
				username: { type: 'string', description: 'Username to look up' }
			},
			required: ['username']
		}
	},
	{
		name: 'list_recent_document_changes',
		description: `Controlled documents that have had a new revision in the recent window — shows the doc and its newest revision metadata so you can spot what's moved.
Source: Document model with revisions[] filtered by recent createdAt timestamps.

Use when: "which controlled docs changed this week", "recent SOP updates", "any new revisions waiting for approval".
Don't use for: WI step content (use search_work_instructions); training-record questions (use get_user_training — admin only).

Defaults: last 7 days. Hard cap 30.`,
		input_schema: {
			type: 'object',
			properties: {
				sinceDays: { type: 'number', description: 'Window in days (default 7, max 90)' },
				status: { type: 'string', description: 'Optional — draft | in_review | approved (filters the document\'s overall status, not the revision)' },
				limit: { type: 'number', description: 'Max results (default 30, max 30)' }
			}
		}
	},
	// === Phase 6.2 — Chemical & floor-plan extensions ===
	{
		name: 'chemical_hazard_summary',
		description: `**The hazard tool.** Hazard rundown for one or several chemicals — pulls the IFC hazard class, NFPA codes, storage code, and (if you pass multiple chemicals) checks pairwise storage compatibility against the well-known chemistry rules (flammable + oxidizer, acid + base, oxidizer + organics, water-reactive isolation, HTX/azide full-isolation).
Source: shared-lab chemical inventory CSVs + a small built-in compatibility matrix.

Use ALWAYS when the operator asks about hazards, hazard class, storage compatibility, "can these share a shelf", "is X safe near Y", "what hazards apply to chemical X". Use this INSTEAD of lookup_chemical for hazard-flavored questions even when only one chemical is named — this tool surfaces the structured hazard profile (NFPA, classification notes, SDS URL) plus compatibility, which lookup_chemical does not.
Don't use for: where the chemical is right now without a hazard angle (use lookup_chemical); usage history (use chemical_burn_rate).

Pass a single name/code/CAS, OR a comma-separated list of names/codes/CAS numbers. If two or more chemicals come back, pairwise compatibility is computed and flagged.`,
		input_schema: {
			type: 'object',
			properties: {
				query: { type: 'string', description: 'Chemical name fragment, CAS number, inventory code (C-NNN / D-NNN), or comma-separated list of any of those.' }
			},
			required: ['query']
		}
	},
	{
		name: 'chemicals_in_protocol',
		description: `Materials list for a research protocol — what prepared reagents it consumes, and the raw chemicals behind those reagents WHEN that link exists.
Source: ProtocolDefinition.materials[] → ReagentCatalog → optional chemical-inventory link.

Use when: "what raw chemicals does the Active Beads v3 protocol consume", "what's in the materials list for protocol X", "trace a protocol back to chemicals".
Don't use for: protocol steps (use find_protocol); reagent inventory items (use list_reagent_inventory); cartridge-level provenance (use trace_reagent_chain).

LIMIT: protocols reference prepared reagents in the catalog, not raw chemicals directly. If a catalog entry doesn't carry a chemical-inventory link, we surface the prepared reagent plus a clear note that the chain to raw chemicals isn't recorded yet.

Hard cap 50 materials per protocol.`,
		input_schema: {
			type: 'object',
			properties: {
				protocolId: { type: 'string', description: 'ProtocolDefinition _id (nanoid) OR protocol name fragment' }
			},
			required: ['protocolId']
		}
	},
	{
		name: 'yield_trends_by_robot',
		description: `Yield trend grouped by robot, per day, over a recent window. Helpful for "is Robot 2 yielding worse than Robot 1 over the last month" or for spotting a robot that started drifting.
Source: WaxFillingRun + CartridgeRecord.waxQc aggregated server-side.

Use when: "yield trend by robot", "is one robot yielding worse than the others lately", "robot comparison this month", multi-robot trend analysis.
Don't use for: yield on a single run (use get_run_yield); a bulk dump of every run (use bulk_run_yields).

Defaults: last 30 days, all robots. Hard cap 90 days history.`,
		input_schema: {
			type: 'object',
			properties: {
				robotName: { type: 'string', description: 'Optional — narrow to one robot' },
				sinceDays: { type: 'number', description: 'Window in days (default 30, max 90)' }
			}
		}
	},
	{
		name: 'scrap_pareto',
		description: `Top scrap reasons over a recent window, ranked by cartridge count. Pulls reasons from every place we record them — wax-QC rejection notes, QA/QC scrap notes, and the cart-level void reason — and tags each row by source. Optionally slices by robot or operator instead of reason.
Source: CartridgeRecord where status in [scrapped, voided] within the window.

Use when: "rank scrap reasons for last 30 days", "biggest sources of scrap this month", "is one operator scrapping more than others", root-cause review prep.
Don't use for: a single run's yield (use get_run_yield); production volume trends (use production_throughput).

Defaults: last 30 days, byField=reason. Hard cap 20 rows.`,
		input_schema: {
			type: 'object',
			properties: {
				sinceDays: { type: 'number', description: 'Window in days (default 30, max 365)' },
				byField: { type: 'string', description: 'Group by: reason (default) | robot | operator' }
			}
		}
	},
	{
		name: 'assay_lot_cross_reference',
		description: `For one assay, walk the chain from reagent batches → cartridges filled with those batches → shipments those carts went into. Tells you which customers got which lot of which assay.
Source: AssayDefinition → ReagentBatchRecord.assayType → CartridgeRecord.reagentFilling.runId → ShippingLot/ShippingPackage.

Use when: "which shipments used reagent batches for Cortisol", "what customers got assay X last quarter", recall-impact analysis on an assay.
Don't use for: a single cartridge's lineage (use trace_cartridge); recall analysis on a raw input lot (use forward_genealogy).

Defaults: last 90 days. Hard cap 50 batches.`,
		input_schema: {
			type: 'object',
			properties: {
				assayName: { type: 'string', description: 'Assay name fragment (case-insensitive)' },
				sinceDays: { type: 'number', description: 'Window in days (default 90, max 365)' }
			},
			required: ['assayName']
		}
	},
	{
		name: 'production_cycle_time',
		description: `Cycle-time stats (p50, p90, max) by process type over a window — how long wax filling, reagent filling, and other LotRecord-tracked processes actually take.
Source: LotRecord.cycleTime aggregated by processConfig.processType.

Use when: "how long is wax filling actually taking these days", "p90 cycle time on reagent filling", "is anything trending slower this month".
Don't use for: a single run's start/end times (use get_run_details); recent runs list (use list_recent_runs).

Defaults: last 30 days, all process types. Hard cap 90 days history.`,
		input_schema: {
			type: 'object',
			properties: {
				processType: { type: 'string', description: 'Optional — filter to one process type' },
				sinceDays: { type: 'number', description: 'Window in days (default 30, max 90)' }
			}
		}
	},
	{
		name: 'chemical_burn_rate',
		description: `How fast we're going through a chemical — current stock, observed usage rate, and days of runway at that rate.
Source: chemical inventory + receiving/usage history. **Limitation:** raw-chemical consumption tracking isn't wired into BIMS yet (no transaction stream for C-NNN / D-NNN items). For chemicals without usage data, we surface current stock and a clear note that runway can't be projected until we add tracking.

Use when: "how fast are we burning through IPA", "when will we run out of methanol", "do we need to reorder DMSO this month".
Don't use for: part-catalog burn rate (use inventory_burn_rate); reagent inventory runway (no equivalent tool today).`,
		input_schema: {
			type: 'object',
			properties: {
				query: { type: 'string', description: 'Chemical name fragment, CAS, or inventory code (C-NNN / D-NNN)' },
				sinceDays: { type: 'number', description: 'Window for usage rate (default 30, max 365). Currently unused because consumption tracking isn\'t live; passed through to be ready when it is.' }
			},
			required: ['query']
		}
	},
	{
		name: 'shift_summary',
		description: `Operator shift-handover digest — one call that returns everything someone walking onto the floor (or wrapping up EOD) needs to know.

Source: aggregates ProductionRun, WaxFillingRun, BimsAnomaly, CalibrationRecord, ReceivingLot, ManualCartridgeRemoval over the shift window.

Use when: "shift summary", "shift handover", "end of day summary", "what happened today", "catch me up", "what changed on this shift", "give me the rundown".
Don't use for: a specific run's status (use whats_blocking_run / get_run_details); a specific cartridge (use find_cartridge / trace_cartridge); a specific anomaly (use find_bims_anomaly). This is the wide-angle digest, not the focused lookup.

Window convention (matches OPERATOR EXPERIENCE rule 3): default windowHours=8 = one shift. "today" = call with windowHours=8 from 06:00 site-local. Always state the window in the answer.`,
		input_schema: {
			type: 'object',
			properties: {
				windowHours: { type: 'number', description: 'How far back to look (default 8 = one shift; max 24)' },
				site: { type: 'string', description: 'Optional site filter: BT | Fannin | both (default both)' }
			}
		}
	}
];

interface ToolResult {
	[key: string]: unknown;
	source?: string;
	sourceUrl?: string;
	dataIntegrityNotes?: string[];
}

interface ToolContext {
	userId?: string;
	username?: string;
	isAdmin?: boolean;
}

async function runTool(name: string, input: any, ctx: ToolContext = {}): Promise<ToolResult> {
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

			// Operator-friendly "explain" bullets — new-idea #3 (cartridge explain
			// mode). Translates the raw lineage into the kind of story a coworker
			// would tell: "Backed by Maria on Tuesday using lot 24a-7. Wax-filled
			// on Robot 1 with PT-CT-114 lot 9c1-4. Passed QC. Stored on rack B2."
			// The agent should prefer these strings verbatim when the user says
			// "explain", "walk me through", or "tell the story" of a cart.
			const fmtDate = (d: any): string => {
				if (!d) return '';
				try { return new Date(d).toISOString().slice(0, 10); } catch { return ''; }
			};
			const explain: string[] = [];
			if (cart.backing?.inductedAt || cart.backing?.lotId) {
				const who = cart.backing?.inductedBy?.username ? ` by ${cart.backing.inductedBy.username}` : '';
				const when = cart.backing?.inductedAt ? ` on ${fmtDate(cart.backing.inductedAt)}` : '';
				const lot = cart.backing?.lotId ? ` from backing lot ${cart.backing.lotId}` : '';
				explain.push(`Backed${who}${when}${lot}.`);
			}
			if (waxRun) {
				const who = waxRun.operator?.username ? ` by ${waxRun.operator.username}` : '';
				const robot = waxRun.robot?.name ? ` on ${waxRun.robot.name}` : '';
				const when = waxRun.runStartTime ? ` on ${fmtDate(waxRun.runStartTime)}` : '';
				const lot = waxLot?.lotId ? ` using wax lot ${waxLot.lotId}` : (waxRun.waxSourceLot ? ` using wax lot ${waxRun.waxSourceLot}` : '');
				explain.push(`Wax-filled${who}${robot}${when}${lot} (run ${waxRun._id}, ${waxRun.status}).`);
			}
			if (cart.waxQc) {
				const verdict = cart.waxQc.status === 'accepted' || cart.waxQc.status === 'pass'
					? 'Passed wax QC'
					: cart.waxQc.status === 'rejected' || cart.waxQc.status === 'fail'
						? 'Failed wax QC'
						: `Wax QC: ${cart.waxQc.status}`;
				const who = cart.waxQc.inspector?.username ? ` (${cart.waxQc.inspector.username})` : '';
				const when = cart.waxQc.inspectedAt ? ` on ${fmtDate(cart.waxQc.inspectedAt)}` : '';
				explain.push(`${verdict}${who}${when}.`);
			}
			if (cart.waxStorage) {
				const where = cart.waxStorage.location ? ` at ${cart.waxStorage.location}` : '';
				const when = cart.waxStorage.storedAt ? ` since ${fmtDate(cart.waxStorage.storedAt)}` : '';
				explain.push(`Stored${where}${when}.`);
			}
			if (cart.reagentFilling?.runId) {
				const when = cart.reagentFilling.completedAt ? ` on ${fmtDate(cart.reagentFilling.completedAt)}` : '';
				explain.push(`Reagent-filled${when} (run ${cart.reagentFilling.runId}).`);
			}
			explain.push(`Current status: ${cart.status ?? 'unknown'}.`);

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
				explain,
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

			const items = filtered.map(r => ({
				equipmentId: r.equipmentId,
				equipmentName: eqMap.get(r.equipmentId)?.name ?? 'unknown',
				equipmentType: r.equipmentType ?? eqMap.get(r.equipmentId)?.equipmentType,
				lastCalibrated: r.calibrationDate,
				dueDate: r.nextCalibrationDue,
				daysUntilDue: Math.round((new Date(r.nextCalibrationDue).getTime() - Date.now()) / 86400e3),
				status: r.status
			}));

			// Phase K.6 — safetyCritical when any equipment is OVERDUE (negative
			// daysUntilDue). Equipment in this state can't be used per QMS rules
			// until re-calibrated; the operator needs to see this prominently,
			// not buried under upcoming-due items.
			const overdue = items.filter(it => it.daysUntilDue < 0);
			const safetyCritical = overdue.length > 0;
			const safetyCriticalReasons = overdue.map(it =>
				`${it.equipmentName} (${it.equipmentId}): calibration ${Math.abs(it.daysUntilDue)} day${Math.abs(it.daysUntilDue) === 1 ? '' : 's'} overdue — equipment is locked out until recalibrated.`
			);

			return {
				items,
				windowDays: daysAhead,
				safetyCritical,
				safetyCriticalReasons,
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
			// Prefer the persisted findings written by the daily cron — they're
			// fast (no aggregations) and consistent across the day. Fall back to
			// a live recompute if the collection has no rows yet (first run /
			// cron hasn't ticked).
			let summary = await summarizeFromAnomalies();
			let sourceLabel = 'bims_anomalies (persisted daily scan at 07:00 UTC)';
			if (!summary) {
				summary = await computeSummary();
				sourceLabel = 'live recompute — daily scan has not run yet';
			}

			return {
				summary: {
					totalIssueCount: summary.totalIssueCount,
					issues: summary.issues
				},
				details: {
					nullWaxSourceLot: summary.byKind.nullWaxSourceLot,
					staleEquipmentReads: summary.byKind.staleEquipmentReads,
					stuckCartridges: summary.byKind.stuckCartridges,
					overConsumedLots: summary.byKind.overConsumedLots,
					orphanLotReferences: summary.byKind.orphanLotReferences,
					counterDrift: summary.byKind.counterDrift,
					legacyStatusCarriers: summary.byKind.legacyStatusCarriers
				},
				source: sourceLabel,
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
		case 'lookup_chemical': {
			const q = String(input.query ?? '').trim();
			if (!q) return {
				error: 'query required',
				source: 'data/chemical-inventory/*.csv',
				sourceUrl: undefined
			};
			const hazardClass = input.hazardClass ? String(input.hazardClass).trim() : undefined;
			const org = input.org ? String(input.org).trim() as ('brevitest' | 'fannin' | 'all') : undefined;
			const limit = input.limit !== undefined ? Number(input.limit) : undefined;

			const result = lookupChemical(q, { hazardClass, org, limit });
			const notes: string[] = [];
			if (result.queryNormalized.length < 2) notes.push('Query must be at least 2 characters.');
			if (result.timedOut) notes.push('Lookup timed out at 500ms. Try a more distinctive query.');
			if (result.truncated) {
				notes.push(`${result.totalAvailable} matches but capped at ${result.totalReturned}. Add an Inventory Code (C-NNN / D-NNN) or a hazardClass filter to narrow.`);
			}
			if (result.matches.length === 0 && result.queryNormalized.length >= 2) {
				notes.push(`No chemicals matched "${q}" across ${result.corpusFiles.join(', ')}. Try a CAS number, an Inventory Code (C-NNN / D-NNN), or a distinctive name fragment.`);
			}
			if (result.dualStocked.length > 0) {
				const names = result.dualStocked.join(', ');
				notes.push(`Both Brevitest and Fannin keep their own stock of: ${names}. Make sure you're reaching for the right bottle — they may have different lot numbers, opening dates, or storage locations.`);
			}

			// Phase K.6 — safetyCritical flag. Set when any returned chemical has a
			// hazard code that requires immediate operator caution (HTX = highly
			// toxic, OX2 = strong oxidizer, FLAM in F1B class = flammable >1 gal,
			// or matches azide/water-reactive patterns). The widget renders these
			// with a distinct hazard banner; the agent leads the answer with the
			// hazard rather than burying it.
			const safetyCriticalReasons: string[] = [];
			for (const row of result.matches) {
				const codes = (row.hazardClass ?? '').toUpperCase();
				const probe = `${row.name} ${row.primaryChemicalName}`.toLowerCase();
				if (codes.includes('HTX')) {
					safetyCriticalReasons.push(`${row.tag} ${row.name}: HTX (highly toxic) — full isolation required.`);
				} else if (/azide/.test(probe)) {
					safetyCriticalReasons.push(`${row.tag} ${row.name}: azide — never co-locate with acids or heavy metals.`);
				} else if (codes.includes('OX2')) {
					safetyCriticalReasons.push(`${row.tag} ${row.name}: strong oxidizer (OX2) — keep away from organics and flammables.`);
				} else if (/(metal sodium|metal potassium|lithium aluminum|calcium hydride|water-reactive|reacts with water)/.test(probe)) {
					safetyCriticalReasons.push(`${row.tag} ${row.name}: water-reactive — desiccated isolation, no aqueous co-location.`);
				}
			}

			return {
				chemicals: result.matches,
				totalReturned: result.totalReturned,
				totalAvailable: result.totalAvailable,
				truncated: result.truncated,
				matchedOrgs: result.matchedOrgs,
				corpusFiles: result.corpusFiles,
				safetyCritical: safetyCriticalReasons.length > 0,
				safetyCriticalReasons,
				source: 'data/chemical-inventory/*.csv (bundled Brevitest + Fannin chemical lists)',
				sourceUrl: undefined,
				dataIntegrityNotes: notes
			};
		}
		case 'find_location': {
			const q = String(input.query ?? '').trim();
			if (!q) return {
				error: 'query required',
				source: 'data/equipment-datasheets/*.csv + floor-plan.ts',
				sourceUrl: undefined
			};

			const result = resolveLocation(q);
			const knownTagCount = getTagMapSize();

			// Clean tag/zone resolution → return found:true with no integrity
			// notes so confidence stays high.
			// Equipment-name fuzzy match that resolved → also clean.
			// Unresolved → return found:false with the not-found reason in a
			// dedicated field. notFoundReason is NOT a dataIntegrityNote, so
			// confidence stays high for "I looked, didn't see it" answers.
			const resolved = result.matchedAs !== 'unresolved' && result.zone !== null;

			return {
				found: resolved,
				matchedAs: result.matchedAs,
				zone: result.zone ? {
					id: result.zone.id,
					name: result.zone.name,
					owningOrg: result.zone.owningOrg,
					position: result.zone.position,
					description: result.zone.description,
					band: result.zone.band
				} : null,
				tag: result.tagEntry ? {
					tag: q.toUpperCase(),
					equipmentName: result.tagEntry.equipmentName,
					rawLocation: result.tagEntry.rawLocation,
					source: result.tagEntry.source
				} : null,
				equipmentInZone: result.equipmentInZone,
				equipmentInZoneCount: result.equipmentInZone.length,
				knownTagCount,
				notFoundReason: result.notFoundReason,
				source: 'data/equipment-datasheets/*.csv (tag→zone via Location column) + floor-plan.ts (zone definitions)',
				sourceUrl: undefined,
				dataIntegrityNotes: result.notes
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
		case 'list_experiments': {
			const filter: any = {};
			if (input.program) filter.program = input.program;
			if (input.status) filter.status = input.status;
			if (input.sinceDays) {
				filter.updatedAt = { $gte: new Date(Date.now() - Number(input.sinceDays) * 86400e3) };
			}
			const limit = Math.min(Math.max(Number(input.limit ?? 20), 1), 50);
			const exps = await Experiment.find(filter)
				.select('_id name program status folderId description nextSerialNumber arms updatedAt')
				.sort({ updatedAt: -1 })
				.limit(limit + 1)
				.lean() as any[];
			const truncated = exps.length > limit;
			return {
				experiments: exps.slice(0, limit).map(e => ({
					_id: e._id,
					name: e.name,
					program: e.program,
					status: e.status,
					folderId: e.folderId,
					description: e.description,
					armCount: Array.isArray(e.arms) ? e.arms.length : 0,
					cartridgeCount: Array.isArray(e.arms)
						? e.arms.reduce((s: number, a: any) => s + (Array.isArray(a.cartridges) ? a.cartridges.length : 0), 0)
						: 0,
					updatedAt: e.updatedAt
				})),
				totalReturned: Math.min(exps.length, limit),
				truncated,
				totalAvailable: truncated ? `>${limit}` : exps.length,
				source: 'Experiment model — research-v2 collection (shared Mongo, BIMS reads only)',
				dataIntegrityNotes: []
			};
		}
		case 'find_experiment': {
			const q = String(input.query ?? '').trim();
			if (!q) return { error: 'query required', source: 'Experiment' };
			let exp = await Experiment.findById(q).lean().catch(() => null) as any;
			if (!exp) {
				const escaped = q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
				exp = await Experiment.findOne({ name: { $regex: escaped, $options: 'i' } }).lean() as any;
			}
			if (!exp) {
				return {
					found: false,
					query: q,
					source: 'Experiment model',
					dataIntegrityNotes: [`No experiment found matching "${q}". Try a name fragment or the experiment _id (nanoid).`]
				};
			}
			return {
				found: true,
				_id: exp._id,
				name: exp.name,
				program: exp.program,
				status: exp.status,
				description: exp.description,
				folderId: exp.folderId,
				nextSerialNumber: exp.nextSerialNumber,
				arms: (Array.isArray(exp.arms) ? exp.arms : []).map((a: any, i: number) => ({
					armIndex: i,
					name: a.name,
					description: a.description,
					assayId: a.assayId,
					assayName: a.assayName,
					cartridgeCount: Array.isArray(a.cartridges) ? a.cartridges.length : 0
				})),
				selected: exp.selected,
				updatedAt: exp.updatedAt,
				source: 'Experiment model — research-v2 collection',
				dataIntegrityNotes: []
			};
		}
		case 'get_experiment_arm_cartridges': {
			const expId = String(input.experimentId ?? '').trim();
			const armIdx = Number(input.armIndex ?? -1);
			if (!expId) return { error: 'experimentId required', source: 'Experiment + CartridgeRecord' };
			if (!Number.isFinite(armIdx) || armIdx < 0) return { error: 'armIndex required (>= 0)', source: 'Experiment + CartridgeRecord' };
			const exp = await Experiment.findById(expId)
				.select('_id name program arms')
				.lean() as any;
			if (!exp) return { error: `Experiment not found: ${expId}`, source: 'Experiment' };
			const arms = Array.isArray(exp.arms) ? exp.arms : [];
			if (armIdx >= arms.length) {
				return {
					error: `Arm index ${armIdx} out of range — experiment "${exp.name}" has ${arms.length} arms (0..${arms.length - 1}).`,
					source: 'Experiment'
				};
			}
			const arm = arms[armIdx];
			const armCartridges = Array.isArray(arm.cartridges) ? arm.cartridges : [];
			const barcodes = armCartridges.map((c: any) => c.barcode).filter(Boolean);
			const carts = barcodes.length > 0
				? await CartridgeRecord.find({ _id: { $in: barcodes } })
					.select('_id status currentPhase rawData result analysis testExecution createdAt finalizedAt')
					.lean() as any[]
				: [];
			const cartMap = new Map((carts as any[]).map(c => [c._id, c]));
			let phaseLegacyCount = 0;
			const items = armCartridges.map((c: any) => {
				const cart = cartMap.get(c.barcode);
				const status = cart?.status ?? cart?.currentPhase ?? null;
				if (cart && !cart.status && cart.currentPhase) phaseLegacyCount++;
				return {
					barcode: c.barcode,
					armStatus: c.status,
					quantity: c.quantity,
					sampleId: c.sampleId,
					sampleLabel: c.sampleLabel,
					cartridgeRecord: cart ? {
						status,
						hasRawData: !!cart.rawData,
						hasAnalysis: !!cart.analysis,
						result: cart.result,
						finalizedAt: cart.finalizedAt,
						createdAt: cart.createdAt
					} : null
				};
			});
			const notes: string[] = [];
			if (phaseLegacyCount > 0) {
				notes.push(`${phaseLegacyCount} cartridge(s) carry legacy 'currentPhase' field — migration to 'status' is incomplete in 12 BIMS files. Treating currentPhase as status.`);
			}
			const missingCount = items.filter((i: { cartridgeRecord: unknown }) => !i.cartridgeRecord).length;
			if (missingCount > 0) {
				notes.push(`${missingCount} arm-listed barcode(s) had no matching CartridgeRecord — research arm references a barcode that was never inducted into BIMS.`);
			}
			return {
				experiment: { _id: exp._id, name: exp.name, program: exp.program },
				arm: {
					armIndex: armIdx,
					name: arm.name,
					description: arm.description,
					assayId: arm.assayId,
					assayName: arm.assayName
				},
				cartridgeCount: items.length,
				cartridges: items,
				source: 'Experiment.arms[armIndex].cartridges joined with CartridgeRecord by barcode',
				dataIntegrityNotes: notes
			};
		}
		case 'list_reagent_catalog': {
			const filter: any = {};
			if (input.category) filter.category = input.category;
			if (input.type) filter.type = input.type;
			if (input.hasVariants) filter['variants.0'] = { $exists: true };
			const limit = Math.min(Math.max(Number(input.limit ?? 30), 1), 50);
			const entries = await ReagentCatalog.find(filter)
				.select('_id name parentId type category subcategory manufacturer catalogNumber defaultConcentration defaultConcentrationUnit storageConditions description tags protocolDefinitionId variants')
				.sort({ category: 1, name: 1 })
				.limit(limit + 1)
				.lean() as any[];
			const truncated = entries.length > limit;
			return {
				catalog: entries.slice(0, limit).map(e => ({
					_id: e._id,
					name: e.name,
					parentId: e.parentId,
					type: e.type,
					category: e.category,
					subcategory: e.subcategory,
					manufacturer: e.manufacturer,
					catalogNumber: e.catalogNumber,
					defaultConcentration: e.defaultConcentration,
					defaultConcentrationUnit: e.defaultConcentrationUnit,
					storageConditions: e.storageConditions,
					description: e.description,
					protocolDefinitionId: e.protocolDefinitionId,
					variantCount: Array.isArray(e.variants) ? e.variants.length : 0,
					activeVariantCount: Array.isArray(e.variants) ? e.variants.filter((v: any) => v.isActive !== false).length : 0
				})),
				totalReturned: Math.min(entries.length, limit),
				truncated,
				source: 'ReagentCatalog model — research-v2 collection',
				dataIntegrityNotes: []
			};
		}
		case 'find_reagent_catalog': {
			const q = String(input.query ?? '').trim();
			if (!q) return { error: 'query required', source: 'ReagentCatalog' };
			let entry = await ReagentCatalog.findById(q).lean().catch(() => null) as any;
			if (!entry) {
				const escaped = q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
				entry = await ReagentCatalog.findOne({ name: { $regex: escaped, $options: 'i' } }).lean() as any;
			}
			if (!entry) {
				return {
					found: false,
					query: q,
					source: 'ReagentCatalog model',
					dataIntegrityNotes: [`No catalog entry matched "${q}". Try a name fragment or the entry _id (nanoid).`]
				};
			}
			return {
				found: true,
				_id: entry._id,
				name: entry.name,
				parentId: entry.parentId,
				type: entry.type,
				category: entry.category,
				subcategory: entry.subcategory,
				manufacturer: entry.manufacturer,
				catalogNumber: entry.catalogNumber,
				defaultConcentration: entry.defaultConcentration,
				defaultConcentrationUnit: entry.defaultConcentrationUnit,
				molecularWeight: entry.molecularWeight,
				storageConditions: entry.storageConditions,
				costPerUnit: entry.costPerUnit,
				costUnitDescription: entry.costUnitDescription,
				description: entry.description,
				tags: entry.tags,
				protocolDefinitionId: entry.protocolDefinitionId,
				variants: Array.isArray(entry.variants) ? entry.variants.map((v: any) => ({
					key: v.key,
					label: v.label,
					description: v.description,
					parameterValues: v.parameterValues,
					isActive: v.isActive !== false,
					createdAt: v.createdAt
				})) : [],
				source: 'ReagentCatalog model',
				dataIntegrityNotes: []
			};
		}
		case 'list_reagent_inventory': {
			const statusInput = input.status ? String(input.status).trim() : 'active';
			const statusFilter = statusInput === 'all' ? null : statusInput;
			const filter: any = {};
			if (input.catalogId) filter.catalogId = input.catalogId;
			if (input.variantKey) filter.variantKey = input.variantKey;
			if (statusFilter) filter.status = statusFilter;
			if (input.nearExpiryDays) {
				const days = Math.max(Number(input.nearExpiryDays), 1);
				const cutoff = new Date(Date.now() + days * 86400e3).toISOString().slice(0, 10);
				const today = new Date().toISOString().slice(0, 10);
				filter.expirationDate = { $gte: today, $lte: cutoff };
				if (!statusFilter) filter.status = 'active';
			}
			const limit = Math.min(Math.max(Number(input.limit ?? 30), 1), 50);
			const items = await ReagentInventory.find(filter)
				.select('_id catalogId catalogName variantKey type manufacturerLotId catalogNumber manufacturer receivedDate expirationDate preparedFromExecutionId preparedDate concentration concentrationUnit volume initialVolume location status notes')
				.sort({ status: 1, expirationDate: 1, enteredDate: -1 })
				.limit(limit + 1)
				.lean() as any[];
			const truncated = items.length > limit;
			return {
				inventory: items.slice(0, limit),
				totalReturned: Math.min(items.length, limit),
				truncated,
				appliedFilters: { catalogId: input.catalogId, variantKey: input.variantKey, status: statusFilter, nearExpiryDays: input.nearExpiryDays },
				source: 'ReagentInventory model — research-v2 collection',
				dataIntegrityNotes: input.catalogId && !input.variantKey
					? ['catalogId without variantKey: results pool ALL variants of this catalog into one list. If the user asked about a specific variant, re-call with variantKey set; for catalog-level rollups use count_inventory_by_variant instead.']
					: []
			};
		}
		case 'find_reagent_inventory': {
			const barcode = String(input.barcode ?? '').trim();
			if (!barcode) return { error: 'barcode required', source: 'ReagentInventory' };
			const item = await ReagentInventory.findById(barcode).lean() as any;
			if (!item) {
				return {
					found: false,
					barcode,
					source: 'ReagentInventory model',
					dataIntegrityNotes: [`No inventory item with barcode "${barcode}".`]
				};
			}
			let variantLabel: string | null = null;
			let parentCatalog: any = null;
			if (item.catalogId) {
				parentCatalog = await ReagentCatalog.findById(item.catalogId)
					.select('name type category subcategory variants')
					.lean() as any;
				if (parentCatalog?.variants && item.variantKey) {
					const variant = parentCatalog.variants.find((v: any) => v.key === item.variantKey);
					if (variant) variantLabel = variant.label;
				}
			}
			const notes: string[] = [];
			if (item.catalogId && !parentCatalog) {
				notes.push(`catalogId "${item.catalogId}" did not resolve to a ReagentCatalog entry — orphan catalog reference.`);
			}
			if (item.variantKey && parentCatalog && !variantLabel) {
				notes.push(`variantKey "${item.variantKey}" did not match any variant in catalog "${parentCatalog.name}". Variant may have been deactivated or removed.`);
			}
			return {
				found: true,
				barcode: item._id,
				catalogId: item.catalogId,
				catalogName: item.catalogName ?? parentCatalog?.name,
				variantKey: item.variantKey,
				variantLabel,
				type: item.type,
				manufacturerLotId: item.manufacturerLotId,
				catalogNumber: item.catalogNumber,
				manufacturer: item.manufacturer,
				receivedDate: item.receivedDate,
				expirationDate: item.expirationDate,
				preparedFromExecutionId: item.preparedFromExecutionId,
				preparedDate: item.preparedDate,
				preparedBy: item.preparedBy,
				concentration: item.concentration,
				concentrationUnit: item.concentrationUnit,
				volume: item.volume,
				initialVolume: item.initialVolume,
				location: item.location,
				status: item.status,
				inspectionCount: Array.isArray(item.inspections) ? item.inspections.length : 0,
				notes: item.notes,
				source: 'ReagentInventory + ReagentCatalog (variant resolved)',
				dataIntegrityNotes: notes
			};
		}
		case 'list_protocols': {
			const filter: any = {};
			if (input.category) filter.category = input.category;
			const statusInput = input.status ? String(input.status).trim() : 'active';
			if (statusInput !== 'all') filter.status = statusInput;
			if (input.outputCatalogId) filter.outputCatalogId = input.outputCatalogId;
			const limit = Math.min(Math.max(Number(input.limit ?? 30), 1), 50);
			const protocols = await ProtocolDefinition.find(filter)
				.select('_id name version status category description outputCatalogId outputType updatedAt cellMap sourceSpreadsheet')
				.sort({ updatedAt: -1 })
				.limit(limit + 1)
				.lean() as any[];
			const truncated = protocols.length > limit;
			let cellMapEmptyCount = 0;
			const items = protocols.slice(0, limit).map(p => {
				const cellMapKeyCount = p.cellMap && typeof p.cellMap === 'object' ? Object.keys(p.cellMap).length : 0;
				if (cellMapKeyCount === 0) cellMapEmptyCount++;
				return {
					_id: p._id,
					name: p.name,
					version: p.version,
					status: p.status,
					category: p.category,
					description: p.description,
					outputCatalogId: p.outputCatalogId,
					outputType: p.outputType,
					sourceSpreadsheet: p.sourceSpreadsheet,
					cellMapKeyCount,
					updatedAt: p.updatedAt
				};
			});
			const notes: string[] = [];
			if (cellMapEmptyCount > 0) {
				notes.push(`${cellMapEmptyCount} protocol(s) have an empty cellMap — formula propagation does NOT work on those (live cellMap bug per docs/protocol-extraction-cellmap-bug.md). Reagent amounts stay at static-extracted values regardless of input parameter edits. Re-extraction needed.`);
			}
			return {
				protocols: items,
				totalReturned: items.length,
				truncated,
				source: 'ProtocolDefinition model — research-v2 collection',
				dataIntegrityNotes: notes
			};
		}
		case 'find_protocol': {
			const q = String(input.query ?? '').trim();
			if (!q) return { error: 'query required', source: 'ProtocolDefinition' };
			let p = await ProtocolDefinition.findById(q).lean().catch(() => null) as any;
			if (!p) {
				const escaped = q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
				p = await ProtocolDefinition.findOne({ name: { $regex: escaped, $options: 'i' } })
					.sort({ updatedAt: -1 })
					.lean() as any;
			}
			if (!p) {
				return {
					found: false,
					query: q,
					source: 'ProtocolDefinition model',
					dataIntegrityNotes: [`No protocol matched "${q}". Try a name fragment or the protocol _id.`]
				};
			}
			const cellMapKeyCount = p.cellMap && typeof p.cellMap === 'object' ? Object.keys(p.cellMap).length : 0;
			const notes: string[] = [];
			if (cellMapKeyCount === 0) {
				notes.push(`cellMap is EMPTY on this protocol — formula propagation is broken. Editing input parameters does NOT cascade through reagent amounts. Per docs/protocol-extraction-cellmap-bug.md, the parser fix is shipped but live protocols still need re-extraction.`);
			}
			return {
				found: true,
				_id: p._id,
				name: p.name,
				version: p.version,
				status: p.status,
				category: p.category,
				description: p.description,
				outputCatalogId: p.outputCatalogId,
				outputType: p.outputType,
				parameters: Array.isArray(p.parameters) ? p.parameters : [],
				materials: Array.isArray(p.materials) ? p.materials : [],
				steps: Array.isArray(p.steps) ? p.steps.map((s: any) => ({
					number: s.number,
					title: s.title,
					instructions: s.instructions,
					substepCount: Array.isArray(s.substeps) ? s.substeps.length : 0,
					reagentCount: Array.isArray(s.reagents) ? s.reagents.length : 0,
					duration: s.duration,
					checkpoint: s.checkpoint,
					qcRequired: s.qcRequired
				})) : [],
				versionHistoryCount: Array.isArray(p.versionHistory) ? p.versionHistory.length : 0,
				cellMapKeyCount,
				sourceSpreadsheet: p.sourceSpreadsheet,
				importedAt: p.importedAt,
				importedBy: p.importedBy,
				updatedAt: p.updatedAt,
				source: 'ProtocolDefinition model',
				dataIntegrityNotes: notes
			};
		}
		case 'list_protocol_executions': {
			const filter: any = {};
			if (input.definitionId) filter.definitionId = input.definitionId;
			if (input.variantKey) filter.variantKey = input.variantKey;
			if (input.status) filter.status = input.status;
			if (input.executedBy) {
				// Nanoid pattern is exactly 21 url-safe chars. Anything else is
				// treated as a name fragment regex against executedByName — friendlier
				// for operators who say "Nick" or "Jacob" rather than the user _id.
				const v = String(input.executedBy);
				if (/^[A-Za-z0-9_-]{21}$/.test(v)) {
					filter.executedBy = v;
				} else {
					const escaped = v.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
					filter.executedByName = { $regex: escaped, $options: 'i' };
				}
			}
			if (input.sinceDays) {
				const cutoff = new Date(Date.now() - Number(input.sinceDays) * 86400e3).toISOString();
				filter.startedAt = { $gte: cutoff };
			}
			const limit = Math.min(Math.max(Number(input.limit ?? 30), 1), 50);
			const execs = await ProtocolExecution.find(filter)
				.select('_id definitionId definitionName definitionVersion variantKey executedBy executedByName startedAt completedAt status outputs outputInventoryId experimentId')
				.sort({ startedAt: -1 })
				.limit(limit + 1)
				.lean() as any[];
			const truncated = execs.length > limit;
			return {
				executions: execs.slice(0, limit).map(e => ({
					_id: e._id,
					definitionId: e.definitionId,
					definitionName: e.definitionName,
					definitionVersion: e.definitionVersion,
					variantKey: e.variantKey,
					executedBy: e.executedBy,
					executedByName: e.executedByName,
					startedAt: e.startedAt,
					completedAt: e.completedAt,
					status: e.status,
					outputCount: Array.isArray(e.outputs) ? e.outputs.length : 0,
					primaryOutputBarcode: Array.isArray(e.outputs) && e.outputs[0]?.barcode ? e.outputs[0].barcode : (e.outputInventoryId || null),
					experimentId: e.experimentId
				})),
				totalReturned: Math.min(execs.length, limit),
				truncated,
				source: 'ProtocolExecution model — research-v2 collection',
				dataIntegrityNotes: []
			};
		}
		case 'get_protocol_execution_details': {
			const id = String(input.executionId ?? '').trim();
			if (!id) return { error: 'executionId required', source: 'ProtocolExecution' };
			const exec = await ProtocolExecution.findById(id).lean() as any;
			if (!exec) {
				return {
					found: false,
					executionId: id,
					source: 'ProtocolExecution model',
					dataIntegrityNotes: [`No execution found with _id "${id}".`]
				};
			}
			let definition: any = null;
			if (exec.definitionId) {
				definition = await ProtocolDefinition.findById(exec.definitionId)
					.select('_id name version status outputCatalogId category')
					.lean() as any;
			}
			const notes: string[] = [];
			if (exec.definitionId && !definition) {
				notes.push(`definitionId "${exec.definitionId}" did not resolve — protocol may have been deleted. The denormalized definitionName/version on the execution still tells you what was run.`);
			}
			const outputs = Array.isArray(exec.outputs) ? exec.outputs : [];
			const materialsUsed = Array.isArray(exec.materialsUsed) ? exec.materialsUsed : [];
			const stepRecords = Array.isArray(exec.stepRecords) ? exec.stepRecords : [];
			return {
				found: true,
				_id: exec._id,
				definitionId: exec.definitionId,
				definitionName: exec.definitionName,
				definitionVersion: exec.definitionVersion,
				definitionResolved: definition ? {
					name: definition.name,
					currentVersion: definition.version,
					status: definition.status,
					outputCatalogId: definition.outputCatalogId,
					category: definition.category
				} : null,
				variantKey: exec.variantKey,
				executedBy: exec.executedBy,
				executedByName: exec.executedByName,
				startedAt: exec.startedAt,
				completedAt: exec.completedAt,
				status: exec.status,
				experimentId: exec.experimentId,
				parameterValues: exec.parameterValues,
				materialsUsed: materialsUsed.map((m: any) => ({
					key: m.key,
					inventoryId: m.inventoryId,
					catalogName: m.catalogName,
					actualConcentration: m.actualConcentration,
					amountUsed: m.amountUsed,
					unit: m.unit,
					scannedAt: m.scannedAt
				})),
				stepRecords: stepRecords.map((s: any) => ({
					stepNumber: s.stepNumber,
					completedAt: s.completedAt,
					completedBy: s.completedBy,
					skipped: s.skipped,
					skipReason: s.skipReason,
					notes: s.notes
				})),
				outputs: outputs.map((o: any) => ({
					barcode: o.barcode,
					volume: o.volume,
					notes: o.notes,
					createdAt: o.createdAt
				})),
				source: 'ProtocolExecution + ProtocolDefinition (joined)',
				dataIntegrityNotes: notes
			};
		}
		case 'count_inventory_by_variant': {
			const catalogId = String(input.catalogId ?? '').trim();
			if (!catalogId) return { error: 'catalogId required', source: 'ReagentInventory' };
			const catalog = await ReagentCatalog.findById(catalogId)
				.select('name type variants')
				.lean() as any;
			if (!catalog) {
				return {
					error: `Catalog entry "${catalogId}" not found.`,
					source: 'ReagentCatalog'
				};
			}
			const agg = await ReagentInventory.aggregate([
				{ $match: { catalogId } },
				{
					$group: {
						_id: { variantKey: '$variantKey', status: '$status' },
						count: { $sum: 1 },
						totalVolume: { $sum: { $ifNull: ['$volume', 0] } }
					}
				}
			]);
			const variantMap = new Map<string, any>();
			for (const row of agg) {
				const key = row._id.variantKey ?? '';
				const status = row._id.status ?? 'unknown';
				if (!variantMap.has(key)) variantMap.set(key, { variantKey: key, label: null, byStatus: {}, totals: { count: 0, totalVolume: 0 } });
				const entry = variantMap.get(key);
				entry.byStatus[status] = { count: row.count, totalVolume: row.totalVolume };
				entry.totals.count += row.count;
				entry.totals.totalVolume += row.totalVolume;
			}
			const declaredVariants = Array.isArray(catalog.variants) ? catalog.variants : [];
			for (const v of declaredVariants) {
				if (!variantMap.has(v.key)) {
					variantMap.set(v.key, { variantKey: v.key, label: v.label, byStatus: {}, totals: { count: 0, totalVolume: 0 } });
				} else {
					variantMap.get(v.key).label = v.label;
				}
			}
			const variants = [...variantMap.values()].sort((a, b) =>
				(b.totals.count - a.totals.count) || String(a.variantKey).localeCompare(String(b.variantKey))
			);
			const totalCount = variants.reduce((s, v) => s + v.totals.count, 0);
			const noVariantBucket = variants.find(v => v.variantKey === '');
			const notes: string[] = [];
			if (noVariantBucket && declaredVariants.length > 0) {
				notes.push(`${noVariantBucket.totals.count} inventory item(s) for "${catalog.name}" have no variantKey but the catalog has ${declaredVariants.length} declared variants — these are legacy items from before variant tracking; encourage operators to assign a variant.`);
			}
			return {
				catalog: { _id: catalogId, name: catalog.name, type: catalog.type },
				totalCount,
				variants,
				declaredVariantCount: declaredVariants.length,
				source: 'ReagentInventory aggregate by (variantKey, status); catalog metadata from ReagentCatalog.variants',
				dataIntegrityNotes: notes
			};
		}
		case 'list_samples': {
			const filter: any = {};
			if (input.experimentId) filter.experimentId = input.experimentId;
			if (input.analyteId) filter.analyteId = input.analyteId;
			const limit = Math.min(Math.max(Number(input.limit ?? 50), 1), 200);
			const samples = await Sample.find(filter)
				.select('_id experimentId sampleNumber concentration diluent matrix analyteId analyteName description')
				.sort({ experimentId: 1, sampleNumber: 1 })
				.limit(limit + 1)
				.lean() as any[];
			const truncated = samples.length > limit;
			return {
				samples: samples.slice(0, limit),
				totalReturned: Math.min(samples.length, limit),
				truncated,
				source: 'Sample model — research-v2 collection',
				dataIntegrityNotes: []
			};
		}
		case 'list_analytes': {
			const analytes = await Analyte.find()
				.select('_id name units dynamicRange lod loq referenceRange description')
				.sort({ name: 1 })
				.lean() as any[];
			return {
				analytes,
				totalReturned: analytes.length,
				source: 'Analyte model — research-v2 collection',
				dataIntegrityNotes: []
			};
		}
		case 'list_analysis_profiles': {
			const profiles = await AnalysisProfile.find()
				.select('_id name description scanGroupDetection scanGroupLabels sumColumns denominatorColumn ratioNumerators ratioScanGroups outputColumns outputScanGroups outputChannels')
				.sort({ name: 1 })
				.lean() as any[];
			return {
				profiles,
				totalReturned: profiles.length,
				source: 'AnalysisProfile model — research-v2 collection',
				dataIntegrityNotes: []
			};
		}
		case 'list_calibrated_analyses': {
			const filter: any = {};
			if (input.name) {
				const escaped = String(input.name).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
				filter.name = { $regex: escaped, $options: 'i' };
			}
			if (input.sinceDays) {
				const cutoff = new Date(Date.now() - Number(input.sinceDays) * 86400e3).toISOString();
				filter.lastRunAt = { $gte: cutoff };
			}
			const limit = Math.min(Math.max(Number(input.limit ?? 30), 1), 50);
			const items = await CalibratedAnalysis.find(filter)
				.select('_id name description baseProfileId cartridgeIds beadBarcode tracerBarcode correctionExponent lastRunAt lastRunBy createdAt')
				.sort({ lastRunAt: -1, createdAt: -1 })
				.limit(limit + 1)
				.lean() as any[];
			const truncated = items.length > limit;
			return {
				calibratedAnalyses: items.slice(0, limit).map((c: any) => ({
					_id: c._id,
					name: c.name,
					description: c.description,
					baseProfileId: c.baseProfileId,
					cartridgeCount: Array.isArray(c.cartridgeIds) ? c.cartridgeIds.length : 0,
					beadBarcode: c.beadBarcode,
					tracerBarcode: c.tracerBarcode,
					correctionExponent: c.correctionExponent,
					lastRunAt: c.lastRunAt,
					lastRunBy: c.lastRunBy,
					createdAt: c.createdAt
				})),
				totalReturned: Math.min(items.length, limit),
				truncated,
				source: 'CalibratedAnalysis model — research-v2 collection',
				dataIntegrityNotes: []
			};
		}
		case 'find_calibrated_analysis': {
			const q = String(input.query ?? '').trim();
			if (!q) return { error: 'query required', source: 'CalibratedAnalysis' };
			let item = await CalibratedAnalysis.findById(q).lean().catch(() => null) as any;
			if (!item) {
				const escaped = q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
				item = await CalibratedAnalysis.findOne({ name: { $regex: escaped, $options: 'i' } })
					.sort({ lastRunAt: -1 })
					.lean() as any;
			}
			if (!item) {
				return {
					found: false,
					query: q,
					source: 'CalibratedAnalysis model',
					dataIntegrityNotes: [`No calibrated analysis matched "${q}". Try a name fragment or the _id.`]
				};
			}
			return {
				found: true,
				_id: item._id,
				name: item.name,
				description: item.description,
				baseProfileId: item.baseProfileId,
				cartridgeIds: item.cartridgeIds,
				cartridgeCount: Array.isArray(item.cartridgeIds) ? item.cartridgeIds.length : 0,
				excludedChannels: item.excludedChannels,
				beadBarcode: item.beadBarcode,
				tracerBarcode: item.tracerBarcode,
				correctionExponent: item.correctionExponent,
				resultsPresent: !!item.results,
				lastRunAt: item.lastRunAt,
				lastRunBy: item.lastRunBy,
				createdAt: item.createdAt,
				source: 'CalibratedAnalysis model',
				dataIntegrityNotes: []
			};
		}
		case 'get_capability_trend': {
			const processType = String(input.processType ?? '').trim();
			const metric = String(input.metric ?? 'cycleTime').trim();
			const sinceDays = Math.min(Math.max(Number(input.sinceDays ?? 30), 7), 365);
			const granularity = input.granularity === 'day' ? 'day' : 'week';
			if (!processType) return { error: 'processType required', source: 'UnifiedRuns + SpecLimit' };

			const since = new Date(Date.now() - sinceDays * 86400e3);
			const runs = await loadUnifiedRuns({
				from: since, to: new Date(),
				processTypes: [processType] as any,
				operatorIds: null, robotIds: null, equipmentIds: null,
				assayIds: null, inputLotBarcodes: null, shifts: null
			});

			const valueOf = (r: any): number | null => {
				if (metric === 'cycleTime') return r.cycleTimeMin;
				if (metric === 'yield' && r.actualCount && r.acceptedCount != null) return r.acceptedCount / r.actualCount;
				if (metric === 'acceptedCount') return r.acceptedCount;
				return null;
			};
			const keyOf = (d: Date): string => {
				if (granularity === 'day') return d.toISOString().slice(0, 10);
				// ISO week-ish: year-Wnn
				const year = d.getUTCFullYear();
				const start = Date.UTC(year, 0, 1);
				const dayOfYear = Math.floor((d.getTime() - start) / 86400000);
				const week = Math.floor(dayOfYear / 7) + 1;
				return `${year}-W${String(week).padStart(2, '0')}`;
			};

			const bins = new Map<string, number[]>();
			for (const r of runs) {
				const t = r.endTime ?? r.startTime ?? r.createdAt;
				const v = valueOf(r);
				if (!t || v == null || !Number.isFinite(v)) continue;
				const k = keyOf(new Date(t));
				if (!bins.has(k)) bins.set(k, []);
				bins.get(k)!.push(v);
			}

			const spec = await SpecLimit.findOne({ processType, metric }).lean().catch(() => null) as any;
			const LSL = spec?.lsl ?? null;
			const USL = spec?.usl ?? null;

			const trend = [...bins.entries()]
				.sort(([a], [b]) => a.localeCompare(b))
				.map(([period, values]) => {
					const cap = capability(values, { LSL, USL });
					return { period, n: cap.n, mean: cap.mean, sigma: cap.stdDev, cp: cap.cp, cpk: cap.cpk };
				});

			const cpkSeries: [number, number][] = trend
				.map((t, i) => [i, t.cpk ?? NaN] as [number, number])
				.filter(([, v]) => Number.isFinite(v));
			const slope = cpkSeries.length >= 2 ? linearRegression(cpkSeries) : null;

			const notes: string[] = [];
			if (!spec) notes.push(`No SpecLimit configured for processType=${processType} metric=${metric}. Cp/Cpk return null without spec limits — n/mean/sigma still computed per bin.`);
			if (trend.length < 3) notes.push(`Only ${trend.length} bin(s) of data — trend regression is unreliable; widen sinceDays or change granularity.`);

			return {
				processType, metric, windowDays: sinceDays, granularity,
				specLimits: { LSL, USL, source: spec ? 'SpecLimit model' : 'not configured' },
				trend,
				slope: slope?.slope ?? null,
				slopeR2: slope?.r2 ?? null,
				direction: slope?.slope != null ? (slope.slope > 0 ? 'improving' : slope.slope < 0 ? 'degrading' : 'flat') : null,
				source: 'loadUnifiedRuns() + SpecLimit + capability() per bin + linearRegression on Cpk',
				dataIntegrityNotes: notes
			};
		}
		case 'cpk_vs_target': {
			const processType = String(input.processType ?? '').trim();
			const metric = String(input.metric ?? '').trim();
			const targetCpk = Number(input.targetCpk ?? 1.33);
			const sinceDays = Math.min(Math.max(Number(input.sinceDays ?? 30), 7), 365);
			if (!processType || !metric) return { error: 'processType + metric required', source: 'UnifiedRuns + SpecLimit + capability()' };

			const since = new Date(Date.now() - sinceDays * 86400e3);
			const runs = await loadUnifiedRuns({
				from: since, to: new Date(),
				processTypes: [processType] as any,
				operatorIds: null, robotIds: null, equipmentIds: null,
				assayIds: null, inputLotBarcodes: null, shifts: null
			});
			const values: number[] = [];
			for (const r of runs) {
				if (metric === 'cycleTime' && r.cycleTimeMin != null) values.push(r.cycleTimeMin);
				else if (metric === 'yield' && r.actualCount && r.acceptedCount != null) values.push(r.acceptedCount / r.actualCount);
				else if (metric === 'acceptedCount' && r.acceptedCount != null) values.push(r.acceptedCount);
			}

			const spec = await SpecLimit.findOne({ processType, metric }).lean().catch(() => null) as any;
			const cap = capability(values, { LSL: spec?.lsl ?? null, USL: spec?.usl ?? null });

			const cpkDelta = cap.cpk != null ? cap.cpk - targetCpk : null;
			const meetsTarget = cap.cpk != null && cap.cpk >= targetCpk;
			let suggestion = '';
			if (cap.cpk == null) {
				suggestion = 'No Cpk computed — needs spec limits and ≥2 data points.';
			} else if (meetsTarget) {
				suggestion = `Target met (Cpk ${cap.cpk.toFixed(2)} ≥ ${targetCpk}). Consider tightening spec or raising target.`;
			} else if (cap.cp != null && cap.cp >= targetCpk) {
				suggestion = `Process is spread-capable (Cp ${cap.cp.toFixed(2)} meets target) but off-center. Shift the mean toward (LSL+USL)/2 to lift Cpk without reducing variation.`;
			} else if (cap.cp != null && cap.stdDev != null && cap.stdDev > 0) {
				const sigmaRatio = targetCpk > 0 ? cap.cp / targetCpk : 1;
				const sigmaReductionPct = Math.max(0, (1 - sigmaRatio) * 100);
				suggestion = `Process needs variation reduction. Approximate σ reduction to reach Cp=${targetCpk}: ~${sigmaReductionPct.toFixed(1)}%.`;
			} else {
				suggestion = 'Insufficient data to recommend a path — collect more measurements.';
			}

			const notes: string[] = [];
			if (!spec) notes.push(`No SpecLimit for processType=${processType} metric=${metric}. Configure spec limits to enable Cp/Cpk.`);

			return {
				processType, metric, targetCpk, windowDays: sinceDays,
				n: cap.n, mean: cap.mean, sigma: cap.stdDev,
				cp: cap.cp, cpk: cap.cpk,
				cpkDelta, meetsTarget,
				dpmo: cap.dpmo,
				suggestion,
				source: 'loadUnifiedRuns() + SpecLimit + capability()',
				dataIntegrityNotes: notes
			};
		}
		case 'shift_correlation': {
			const metric = String(input.metric ?? 'cycleTime').trim();
			const sinceDays = Math.min(Math.max(Number(input.sinceDays ?? 30), 7), 365);
			const processType = input.processType ? String(input.processType).trim() : null;

			const since = new Date(Date.now() - sinceDays * 86400e3);
			const runs = await loadUnifiedRuns({
				from: since, to: new Date(),
				processTypes: (processType ? [processType] : null) as any,
				operatorIds: null, robotIds: null, equipmentIds: null,
				assayIds: null, inputLotBarcodes: null, shifts: null
			});

			const dayVals: number[] = [];
			const nightVals: number[] = [];
			for (const r of runs) {
				if (!r.startTime) continue;
				let v: number | null = null;
				if (metric === 'cycleTime' && r.cycleTimeMin != null) v = r.cycleTimeMin;
				else if (metric === 'yield' && r.actualCount && r.acceptedCount != null) v = r.acceptedCount / r.actualCount;
				if (v == null) continue;
				const h = new Date(r.startTime).getHours();
				if (h >= 6 && h < 22) dayVals.push(v);
				else nightVals.push(v);
			}

			const notes: string[] = [];
			if (dayVals.length < 2 || nightVals.length < 2) notes.push(`Insufficient data for t-test (day n=${dayVals.length}, night n=${nightVals.length}; need ≥2 per side). Widen window or drop the processType filter.`);

			const test = tTest(dayVals, nightVals);
			const significant = test.pValue != null && test.pValue < 0.05;

			return {
				metric, windowDays: sinceDays, processType,
				day: { n: dayVals.length, mean: test.meanA },
				night: { n: nightVals.length, mean: test.meanB },
				tStat: test.t, pValue: test.pValue, df: test.df,
				significant,
				interpretation: significant
					? `Day vs night difference in ${metric} is statistically significant (p=${test.pValue!.toFixed(4)} < 0.05). Worth investigating root cause (different operators, lighting, temperature, supply quality at night).`
					: (test.pValue != null ? `No significant day/night difference in ${metric} (p=${test.pValue.toFixed(4)}). Shift is not a primary driver.` : 'Could not compute t-test — insufficient data.'),
				source: 'loadUnifiedRuns() bucketed by start-hour (day 06:00-22:00, night 22:00-06:00) + tTest()',
				dataIntegrityNotes: notes
			};
		}
		case 'fmea_risk_query': {
			const rpnThreshold = Number(input.rpnThreshold ?? 0);
			const statusFilter = input.statusFilter ? String(input.statusFilter).trim() : null;
			const limit = Math.min(Math.max(Number(input.limit ?? 20), 1), 100);

			const filter: any = {};
			if (rpnThreshold > 0) filter.rpn = { $gte: rpnThreshold };
			if (statusFilter) filter.status = statusFilter;

			const records = await FmeaRecord.find(filter)
				.sort({ rpn: -1 })
				.limit(limit + 1)
				.lean() as any[];
			const truncated = records.length > limit;

			return {
				records: records.slice(0, limit).map(r => ({
					_id: r._id,
					processType: r.processType,
					failureMode: r.failureMode,
					effect: r.effect,
					cause: r.cause,
					severity: r.severity,
					occurrence: r.occurrence,
					detection: r.detection,
					rpn: r.rpn,
					status: r.status,
					recommendedAction: r.recommendedAction,
					actionOwner: r.actionOwner,
					actionDueDate: r.actionDueDate,
					updatedAt: r.updatedAt
				})),
				totalReturned: Math.min(records.length, limit),
				truncated,
				rpnThreshold,
				statusFilter,
				source: 'FmeaRecord sorted by rpn desc',
				sourceUrl: '/manufacturing/analysis',
				dataIntegrityNotes: records.length === 0 ? ['No FMEA records matched. Try lowering rpnThreshold or dropping the status filter.'] : []
			};
		}
		case 'forecast_capability_impact': {
			const processType = String(input.processType ?? '').trim();
			const metric = String(input.metric ?? '').trim();
			if (!processType || !metric) return { error: 'processType + metric required', source: 'UnifiedRuns + SpecLimit + capability()' };
			const scenario = input.scenario ?? {};
			const sigmaReductionPct = Math.max(0, Math.min(99, Number(scenario.sigmaReductionPct ?? 0)));
			const meanShift = Number(scenario.meanShift ?? 0);

			const since = new Date(Date.now() - 30 * 86400e3);
			const runs = await loadUnifiedRuns({
				from: since, to: new Date(),
				processTypes: [processType] as any,
				operatorIds: null, robotIds: null, equipmentIds: null,
				assayIds: null, inputLotBarcodes: null, shifts: null
			});
			const values: number[] = [];
			for (const r of runs) {
				if (metric === 'cycleTime' && r.cycleTimeMin != null) values.push(r.cycleTimeMin);
				else if (metric === 'yield' && r.actualCount && r.acceptedCount != null) values.push(r.acceptedCount / r.actualCount);
			}
			const spec = await SpecLimit.findOne({ processType, metric }).lean().catch(() => null) as any;
			const current = capability(values, { LSL: spec?.lsl ?? null, USL: spec?.usl ?? null });
			if (current.stdDev == null || current.mean == null) {
				return {
					error: 'Insufficient current data to forecast — need ≥2 measurements with current sigma.',
					processType, metric,
					source: 'UnifiedRuns 30-day window'
				};
			}

			const sigmaMul = 1 - sigmaReductionPct / 100;
			const newMean = current.mean + meanShift;
			const forecastValues = values.map(v => newMean + (v - current.mean!) * sigmaMul);
			const forecast = capability(forecastValues, { LSL: spec?.lsl ?? null, USL: spec?.usl ?? null });

			return {
				processType, metric,
				scenario: { sigmaReductionPct, meanShift },
				current: { n: current.n, mean: current.mean, sigma: current.stdDev, cp: current.cp, cpk: current.cpk },
				forecast: { n: forecast.n, mean: forecast.mean, sigma: forecast.stdDev, cp: forecast.cp, cpk: forecast.cpk },
				cpkDelta: (forecast.cpk ?? 0) - (current.cpk ?? 0),
				cpDelta: (forecast.cp ?? 0) - (current.cp ?? 0),
				source: 'capability(synthetic-values) where synthetic = newMean + (v - mean) × (1 - sigmaReductionPct/100)',
				dataIntegrityNotes: spec ? [] : ['No SpecLimit configured — Cp/Cpk return null. Forecast only shows mean/sigma changes.']
			};
		}
		case 'bulk_temperature_summary': {
			const names: string[] = Array.isArray(input.equipmentNames)
				? input.equipmentNames.map((n: any) => String(n).trim()).filter(Boolean)
				: [];
			if (names.length === 0) return { error: 'equipmentNames array required (≥1)', source: 'Equipment + TemperatureReading + TemperatureAlert' };
			if (names.length > 20) return { error: 'Max 20 equipment names per call', source: 'Equipment + TemperatureReading + TemperatureAlert' };
			const sinceDays = Math.min(Math.max(Number(input.sinceDays ?? 7), 1), 30);
			const since = new Date(Date.now() - sinceDays * 86400e3);

			const items = await Promise.all(names.map(async (name: string) => {
				const eq = await Equipment.findOne({ name: { $regex: name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), $options: 'i' } })
					.select('_id name mocreoDeviceId temperatureMinC temperatureMaxC').lean() as any;
				if (!eq) return { query: name, found: false };

				const [readings, alertCount] = await Promise.all([
					TemperatureReading.find({
						$or: [{ equipmentId: eq._id }, { sensorId: eq.mocreoDeviceId }],
						timestamp: { $gte: since }
					}).select('temperature').lean() as any,
					TemperatureAlert.countDocuments({
						$or: [{ equipmentId: eq._id }, { sensorId: eq.mocreoDeviceId }],
						timestamp: { $gte: since }
					})
				]);
				const temps = (readings as any[]).map(r => r.temperature).filter((t: any) => typeof t === 'number');
				if (temps.length === 0) {
					return { query: name, equipmentName: eq.name, found: true, readingCount: 0, alertCount };
				}
				const min = Math.min(...temps), max = Math.max(...temps);
				const avg = temps.reduce((s: number, t: number) => s + t, 0) / temps.length;
				const inSpec = eq.temperatureMinC != null && eq.temperatureMaxC != null
					? temps.filter((t: number) => t >= eq.temperatureMinC && t <= eq.temperatureMaxC).length
					: null;
				return {
					query: name,
					equipmentName: eq.name,
					found: true,
					readingCount: temps.length,
					minC: Math.round(min * 100) / 100,
					maxC: Math.round(max * 100) / 100,
					avgC: Math.round(avg * 100) / 100,
					targetRange: eq.temperatureMinC != null ? `${eq.temperatureMinC} to ${eq.temperatureMaxC}°C` : null,
					inSpecCount: inSpec,
					inSpecPct: inSpec != null ? Math.round((inSpec / temps.length) * 1000) / 10 : null,
					alertCount
				};
			}));

			return {
				windowDays: sinceDays,
				equipmentCount: items.length,
				items,
				source: 'Equipment + TemperatureReading + TemperatureAlert (per name)',
				sourceUrl: '/equipment/activity',
				dataIntegrityNotes: items.filter(i => !i.found).length > 0
					? [`${items.filter(i => !i.found).length} of ${items.length} names did not match any Equipment record.`]
					: []
			};
		}
		case 'bulk_cartridge_status': {
			const barcodes: string[] = Array.isArray(input.barcodes)
				? input.barcodes.map((b: any) => String(b).trim()).filter(Boolean)
				: [];
			if (barcodes.length === 0) return { error: 'barcodes array required (≥1)', source: 'CartridgeRecord' };
			if (barcodes.length > 100) return { error: 'Max 100 barcodes per call', source: 'CartridgeRecord' };

			const carts = await CartridgeRecord.find({ _id: { $in: barcodes } })
				.select('_id status currentPhase finalizedAt result waxQc.status reagentInspection.status testResult.status createdAt')
				.lean() as any[];
			const found = new Map((carts as any[]).map(c => [c._id, c]));

			let legacyCount = 0;
			const items = barcodes.map(b => {
				const c = found.get(b);
				if (!c) return { barcode: b, found: false };
				const status = c.status ?? c.currentPhase ?? null;
				if (!c.status && c.currentPhase) legacyCount++;
				return {
					barcode: b,
					found: true,
					status,
					finalizedAt: c.finalizedAt ?? null,
					result: c.result ?? null,
					waxQcStatus: c.waxQc?.status ?? null,
					reagentInspectionStatus: c.reagentInspection?.status ?? null,
					testResultStatus: c.testResult?.status ?? null,
					createdAt: c.createdAt
				};
			});
			const statusCounts: Record<string, number> = {};
			for (const it of items) {
				if (it.found && it.status) statusCounts[it.status] = (statusCounts[it.status] ?? 0) + 1;
			}

			const notes: string[] = [];
			const notFound = barcodes.length - carts.length;
			if (notFound > 0) notes.push(`${notFound} of ${barcodes.length} barcodes had no CartridgeRecord (typo, not yet inducted, or research-only barcode never assigned to a cart).`);
			if (legacyCount > 0) notes.push(`${legacyCount} cartridge(s) carry legacy 'currentPhase' — migration to 'status' still incomplete in 12 BIMS files. Treated as status.`);

			return {
				totalRequested: barcodes.length,
				totalFound: carts.length,
				notFound,
				statusCounts,
				cartridges: items,
				source: 'CartridgeRecord projection by _id $in barcodes (defensive status||currentPhase)',
				sourceUrl: '/cartridge-admin',
				dataIntegrityNotes: notes
			};
		}
		case 'find_runs_by_operator': {
			const operator = String(input.operator ?? '').trim();
			if (!operator) return { error: 'operator required', source: 'UnifiedRuns' };
			const sinceDays = Math.min(Math.max(Number(input.sinceDays ?? 7), 1), 90);
			const processType = input.processType ? String(input.processType).trim() : null;
			const since = new Date(Date.now() - sinceDays * 86400e3);

			const runs = await loadUnifiedRuns({
				from: since, to: new Date(),
				processTypes: (processType ? [processType] : null) as any,
				operatorIds: null, robotIds: null, equipmentIds: null,
				assayIds: null, inputLotBarcodes: null, shifts: null
			});
			const lower = operator.toLowerCase();
			const matching = runs.filter(r => r.operator && r.operator.toLowerCase().includes(lower));

			const byProcess: Record<string, number> = {};
			for (const r of matching) byProcess[r.processType] = (byProcess[r.processType] ?? 0) + 1;

			return {
				operator,
				windowDays: sinceDays,
				processType,
				totalReturned: matching.length,
				byProcess,
				runs: matching.slice(0, 50).map(r => ({
					runId: r.runId,
					processType: r.processType,
					status: r.status,
					operator: r.operator,
					robot: r.robotName,
					startTime: r.startTime,
					endTime: r.endTime,
					cycleTimeMin: r.cycleTimeMin,
					actualCount: r.actualCount,
					acceptedCount: r.acceptedCount,
					rejectedCount: r.rejectedCount
				})),
				truncated: matching.length > 50,
				source: 'loadUnifiedRuns() + case-insensitive substring match on run.operator',
				dataIntegrityNotes: matching.length === 0
					? [`No runs matched operator "${operator}" in the last ${sinceDays} days. Try a different spelling, drop the processType filter, or widen sinceDays.`]
					: []
			};
		}
		case 'trace_reagent_chain': {
			const barcode = String(input.cartridgeBarcode ?? '').trim();
			if (!barcode) return { error: 'cartridgeBarcode required', source: 'CartridgeRecord + ProtocolExecution + ReagentInventory' };
			const maxDepth = Math.min(Math.max(Number(input.maxDepth ?? 8), 1), 12);
			const NODE_CAP = 200;

			const cart = await CartridgeRecord.findById(barcode)
				.select('_id status currentPhase reagentChain finalizedAt')
				.lean() as any;
			if (!cart) {
				return {
					found: false,
					cartridgeBarcode: barcode,
					source: 'CartridgeRecord.reagentChain → ProtocolExecution → ReagentInventory (recursive)',
					dataIntegrityNotes: [`No cartridge found with barcode "${barcode}".`]
				};
			}
			const chain: any[] = Array.isArray(cart.reagentChain) ? cart.reagentChain : [];
			if (chain.length === 0) {
				return {
					found: true,
					cartridgeBarcode: cart._id,
					cartridgeStatus: cart.status ?? cart.currentPhase ?? null,
					reagentChain: [],
					trace: [],
					nodesVisited: 0,
					truncated: false,
					depthReached: 0,
					source: 'CartridgeRecord.reagentChain → ProtocolExecution → ReagentInventory (recursive)',
					dataIntegrityNotes: [
						'reagentChain[] is empty on this cartridge. Per Jacob, the reagentChain attach UI is deferred until the variant + execution flow is exercised end-to-end with real lab work — no backfill of existing cartridges. Most cartridges today will return an empty chain. The schema field exists so future writes have somewhere to land.'
					]
				};
			}

			const visitedExecutions = new Set<string>();
			const visitedInventory = new Set<string>();
			let nodeCount = 0;
			let truncatedFlag = false;
			let maxDepthSeen = 0;
			const orphanRefs: string[] = [];

			async function traceInventory(inventoryId: string, depth: number): Promise<any> {
				if (!inventoryId) return null;
				if (depth > maxDepthSeen) maxDepthSeen = depth;
				if (visitedInventory.has(inventoryId)) {
					return { inventoryId, repeated: true };
				}
				if (depth > maxDepth) {
					truncatedFlag = true;
					return { inventoryId, depthCapped: true };
				}
				if (nodeCount >= NODE_CAP) {
					truncatedFlag = true;
					return { inventoryId, nodeCapped: true };
				}
				visitedInventory.add(inventoryId);
				nodeCount++;

				const item = await ReagentInventory.findById(inventoryId)
					.select('_id catalogId catalogName variantKey type manufacturer manufacturerLotId catalogNumber preparedFromExecutionId preparedDate preparedBy volume status receivedDate expirationDate')
					.lean() as any;
				if (!item) {
					orphanRefs.push(`inventoryId "${inventoryId}" did not resolve`);
					return { inventoryId, error: 'inventory not found' };
				}

				let producedBy: any = null;
				if (item.type === 'prepared' && item.preparedFromExecutionId) {
					producedBy = await traceExecution(item.preparedFromExecutionId, depth + 1);
				}

				return {
					inventoryId: item._id,
					catalogId: item.catalogId,
					catalogName: item.catalogName,
					variantKey: item.variantKey,
					type: item.type,
					manufacturer: item.manufacturer,
					manufacturerLotId: item.manufacturerLotId,
					catalogNumber: item.catalogNumber,
					preparedDate: item.preparedDate,
					preparedBy: item.preparedBy,
					volume: item.volume,
					status: item.status,
					receivedDate: item.receivedDate,
					expirationDate: item.expirationDate,
					producedBy
				};
			}

			async function traceExecution(executionId: string, depth: number): Promise<any> {
				if (!executionId) return null;
				if (depth > maxDepthSeen) maxDepthSeen = depth;
				if (visitedExecutions.has(executionId)) {
					return { executionId, repeated: true };
				}
				if (depth > maxDepth) {
					truncatedFlag = true;
					return { executionId, depthCapped: true };
				}
				if (nodeCount >= NODE_CAP) {
					truncatedFlag = true;
					return { executionId, nodeCapped: true };
				}
				visitedExecutions.add(executionId);
				nodeCount++;

				const exec = await ProtocolExecution.findById(executionId)
					.select('_id definitionId definitionName definitionVersion variantKey executedBy executedByName startedAt completedAt status outputs materialsUsed')
					.lean() as any;
				if (!exec) {
					orphanRefs.push(`executionId "${executionId}" did not resolve`);
					return { executionId, error: 'execution not found' };
				}

				const materialsUsed: any[] = Array.isArray(exec.materialsUsed) ? exec.materialsUsed : [];
				const inputs: any[] = [];
				for (const m of materialsUsed) {
					const node = await traceInventory(m?.inventoryId, depth + 1);
					if (node) {
						inputs.push({
							key: m?.key,
							catalogName: m?.catalogName,
							amountUsed: m?.amountUsed,
							unit: m?.unit,
							scannedAt: m?.scannedAt,
							inventory: node
						});
					}
				}
				const outputs: any[] = Array.isArray(exec.outputs) ? exec.outputs : [];

				return {
					executionId: exec._id,
					definitionId: exec.definitionId,
					protocolName: exec.definitionName,
					definitionVersion: exec.definitionVersion,
					variantKey: exec.variantKey,
					executedBy: exec.executedByName ?? exec.executedBy,
					startedAt: exec.startedAt,
					completedAt: exec.completedAt,
					status: exec.status,
					outputs: outputs.map((o: any) => ({ barcode: o.barcode, volume: o.volume })),
					inputs
				};
			}

			const trace: any[] = [];
			for (const entry of chain) {
				if (!entry?.executionId) continue;
				const node = await traceExecution(entry.executionId, 1);
				if (node) {
					trace.push({
						chainEntry: {
							executionId: entry.executionId,
							protocolName: entry.protocolName,
							outputBarcode: entry.outputBarcode,
							verified: entry.verified
						},
						execution: node
					});
				}
			}

			const notes: string[] = [];
			if (truncatedFlag) {
				notes.push(`Trace truncated — hit depth cap ${maxDepth} or node cap ${NODE_CAP}. Increase maxDepth (max 12) for deeper chains, or query a specific protocol execution with get_protocol_execution_details.`);
			}
			if (orphanRefs.length > 0) {
				notes.push(`Orphan references encountered (${orphanRefs.length}): ${orphanRefs.slice(0, 5).join('; ')}${orphanRefs.length > 5 ? '…' : ''}. These point to a deleted protocol execution or inventory item; the chain tree shows them as { error: '...' } leaves.`);
			}
			const unverifiedCount = chain.filter((c: any) => !c.verified).length;
			if (unverifiedCount > 0) {
				notes.push(`${unverifiedCount}/${chain.length} reagentChain entries on this cartridge have verified=false. Per the soft enforcement gate (DOMAIN-17 PE-05), unverified entries don't block the cartridge run today, but flag the chain as not fully validated.`);
			}

			return {
				found: true,
				cartridgeBarcode: cart._id,
				cartridgeStatus: cart.status ?? cart.currentPhase ?? null,
				reagentChainEntryCount: chain.length,
				nodesVisited: nodeCount,
				maxDepthReached: maxDepthSeen,
				truncated: truncatedFlag,
				trace,
				source: 'CartridgeRecord.reagentChain → ProtocolExecution.materialsUsed → ReagentInventory.preparedFromExecutionId (recursive, cycle-protected)',
				dataIntegrityNotes: notes
			};
		}
		case 'find_research_cartridge': {
			const barcode = String(input.barcode ?? '').trim();
			if (!barcode) return { error: 'barcode required', source: 'CartridgeRecord' };
			const cart = await CartridgeRecord.findById(barcode)
				.select('_id status currentPhase assayId assayName assay device experiment arm program rawData readouts result reagentChain analysis testExecution sample testResult priorStatus checkpoints createdAt updatedAt finalizedAt')
				.lean() as any;
			if (!cart) {
				return {
					found: false,
					barcode,
					source: 'CartridgeRecord (research-side projection)',
					sourceUrl: `/cartridges/${barcode}`,
					dataIntegrityNotes: [`No cartridge found with barcode "${barcode}".`]
				};
			}
			const effectiveStatus = cart.status ?? cart.currentPhase ?? null;
			const notes: string[] = [];
			if (!cart.status && cart.currentPhase) {
				notes.push(`Cartridge carries legacy 'currentPhase' field instead of 'status' — currentPhase→status migration is incomplete in 12 BIMS files. Treating currentPhase as status.`);
			}
			if (!cart.finalizedAt && effectiveStatus === 'completed') {
				notes.push('Cartridge is in completed status but finalizedAt is unset — Lambda FREEZE-02 (stamping finalizedAt on completion) is pending. Sacred middleware is not actually freezing this record yet.');
			}
			if (effectiveStatus === 'underway' && (!cart.assayId || !cart.assay)) {
				notes.push('Cartridge is underway but assayId/assay snapshot is missing — Lambda validate-cartridge may have failed to populate.');
			}
			if (Array.isArray(cart.reagentChain) && cart.reagentChain.length === 0) {
				notes.push('reagentChain[] is empty — no protocol-execution traceability for this cartridge. Per Jacob, the reagentChain attach UI is deferred; no backfill of existing carts.');
			}
			return {
				found: true,
				barcode: cart._id,
				status: effectiveStatus,
				priorStatus: cart.priorStatus,
				assayId: cart.assayId,
				assayName: cart.assayName,
				program: cart.program,
				experiment: cart.experiment,
				arm: cart.arm,
				hasRawData: !!cart.rawData,
				readouts: cart.readouts,
				result: cart.result,
				analysisStatus: cart.analysis ? 'present' : 'absent',
				reagentChain: Array.isArray(cart.reagentChain) ? cart.reagentChain.map((r: any) => ({
					executionId: r.executionId,
					protocolName: r.protocolName,
					outputBarcode: r.outputBarcode,
					verified: r.verified
				})) : [],
				testExecution: cart.testExecution ? {
					spuId: cart.testExecution.spu?._id,
					executedAt: cart.testExecution.executedAt
				} : null,
				sample: cart.sample,
				testResultStatus: cart.testResult?.status,
				finalizedAt: cart.finalizedAt,
				createdAt: cart.createdAt,
				updatedAt: cart.updatedAt,
				source: 'CartridgeRecord projected to research fields (rawData, analysis, reagentChain, testExecution, testResult)',
				sourceUrl: `/cartridges/${cart._id}`,
				dataIntegrityNotes: notes
			};
		}
		// === Phase 6.1 — Operational coverage ===
		case 'list_workflow_violations': {
			const days = Math.min(Math.max(Number(input.sinceDays ?? 7), 1), 90);
			const limit = Math.min(Math.max(Number(input.limit ?? 50), 1), 50);
			const filter: any = { timestamp: { $gte: new Date(Date.now() - days * 86400e3) } };
			if (input.severity) filter.severity = String(input.severity);
			if (input.status) {
				if (String(input.status).toLowerCase() === 'open') filter.resolved = false;
				else if (String(input.status).toLowerCase() === 'resolved') filter.resolved = true;
			}
			const violations = await WorkflowViolation.find(filter)
				.sort({ timestamp: -1 })
				.limit(limit + 1)
				.lean() as any[];
			const truncated = violations.length > limit;
			return {
				violations: violations.slice(0, limit).map(v => ({
					_id: v._id,
					type: v.type,
					taskId: v.taskId,
					assignee: v.assignee,
					description: v.description,
					severity: v.severity,
					resolved: v.resolved,
					resolvedAt: v.resolvedAt,
					resolvedBy: v.resolvedBy,
					timestamp: v.timestamp
				})),
				totalReturned: Math.min(violations.length, limit),
				truncated,
				windowDays: days,
				source: 'WorkflowViolation model',
				sourceUrl: '/admin/workflow-violations'
			};
		}
		case 'list_validation_sessions': {
			const days = Math.min(Math.max(Number(input.sinceDays ?? 30), 1), 365);
			const limit = Math.min(Math.max(Number(input.limit ?? 50), 1), 50);
			const filter: any = { createdAt: { $gte: new Date(Date.now() - days * 86400e3) } };
			if (input.spuId) filter.spuId = String(input.spuId);
			if (input.type) filter.type = String(input.type);
			if (input.status) filter.status = String(input.status);
			const sessions = await ValidationSession.find(filter)
				.select('_id type spuId status startedAt completedAt overallPassed failureReasons userId barcode createdAt')
				.sort({ createdAt: -1 })
				.limit(limit + 1)
				.lean() as any[];
			const truncated = sessions.length > limit;
			return {
				validationSessions: sessions.slice(0, limit).map(s => ({
					_id: s._id,
					type: s.type,
					spuId: s.spuId,
					status: s.status,
					startedAt: s.startedAt,
					completedAt: s.completedAt,
					overallPassed: s.overallPassed,
					failureReasons: s.failureReasons,
					userId: s.userId,
					barcode: s.barcode,
					createdAt: s.createdAt
				})),
				totalReturned: Math.min(sessions.length, limit),
				truncated,
				windowDays: days,
				source: 'ValidationSession model',
				sourceUrl: '/admin/validation-sessions'
			};
		}
		case 'list_open_approval_requests': {
			const limit = Math.min(Math.max(Number(input.limit ?? 50), 1), 50);
			const filter: any = { status: { $in: ['pending', 'in_review'] } };
			const typeFilter = input.targetType ?? input.requestType;
			if (typeFilter) filter.changeType = String(typeFilter);
			const requests = await ApprovalRequest.find(filter)
				.select('_id requesterId changeTitle changeDescription changeType priority status dueDate approvedAt approvedBy createdAt updatedAt')
				.sort({ createdAt: -1 })
				.limit(limit + 1)
				.lean() as any[];
			const truncated = requests.length > limit;
			return {
				requests: requests.slice(0, limit).map(r => ({
					_id: r._id,
					requesterId: r.requesterId,
					changeTitle: r.changeTitle,
					changeDescription: r.changeDescription,
					changeType: r.changeType,
					priority: r.priority,
					status: r.status,
					dueDate: r.dueDate,
					createdAt: r.createdAt,
					updatedAt: r.updatedAt
				})),
				totalReturned: Math.min(requests.length, limit),
				truncated,
				source: 'ApprovalRequest model where status in [pending, in_review]',
				sourceUrl: '/admin/approvals'
			};
		}
		case 'equipment_uptime': {
			const nameQuery = String(input.equipmentName ?? '').trim();
			if (!nameQuery) return { error: 'equipmentName required', source: 'TemperatureReading + Equipment', sourceUrl: '/equipment/activity' };
			const days = Math.min(Math.max(Number(input.sinceDays ?? 30), 1), 90);
			const since = new Date(Date.now() - days * 86400e3);

			const eq = await Equipment.findOne({ name: { $regex: nameQuery, $options: 'i' } })
				.select('_id name mocreoDeviceId temperatureMinC temperatureMaxC').lean() as any;
			if (!eq) return {
				error: `No equipment matching "${nameQuery}"`,
				source: 'Equipment',
				sourceUrl: '/equipment/activity'
			};
			const notes: string[] = [];
			if (eq.temperatureMinC == null || eq.temperatureMaxC == null) {
				notes.push(`We don't have a target temperature range recorded for ${eq.name}, so I can't compute an in-spec percentage. The reading count is still useful for gap detection.`);
			}

			const readings = await TemperatureReading.find({
				$or: [{ equipmentId: eq._id }, { sensorId: eq.mocreoDeviceId }],
				timestamp: { $gte: since }
			}).select('temperature timestamp').sort({ timestamp: 1 }).lean() as any[];

			let inRange = 0;
			let outOfRange = 0;
			for (const r of readings) {
				if (eq.temperatureMinC == null || eq.temperatureMaxC == null) continue;
				if (typeof r.temperature !== 'number') continue;
				if (r.temperature >= eq.temperatureMinC && r.temperature <= eq.temperatureMaxC) inRange++;
				else outOfRange++;
			}

			// Gap detection — a gap is no reading for > 1 hour between consecutive readings.
			let gapCount = 0;
			let prev: Date | null = null;
			for (const r of readings) {
				const t = new Date(r.timestamp);
				if (prev) {
					const minutes = (t.getTime() - prev.getTime()) / 60000;
					if (minutes > 60) gapCount++;
				}
				prev = t;
			}
			// Also flag leading/trailing gap from since→first reading, last→now.
			if (readings.length > 0) {
				const firstGap = (new Date(readings[0].timestamp).getTime() - since.getTime()) / 60000;
				if (firstGap > 60) gapCount++;
				const lastGap = (Date.now() - new Date(readings[readings.length - 1].timestamp).getTime()) / 60000;
				if (lastGap > 60) gapCount++;
			}

			const totalEvaluated = inRange + outOfRange;
			const uptimePct = totalEvaluated > 0 ? Math.round((inRange / totalEvaluated) * 1000) / 10 : null;

			return {
				equipmentName: eq.name,
				windowDays: days,
				targetRange: eq.temperatureMinC != null ? `${eq.temperatureMinC} to ${eq.temperatureMaxC}°C` : null,
				totalReadings: readings.length,
				inRangeCount: inRange,
				outOfRangeCount: outOfRange,
				gapCount,
				uptimePct,
				source: 'TemperatureReading + Equipment.temperatureMinC/MaxC',
				sourceUrl: '/equipment/activity',
				dataIntegrityNotes: notes
			};
		}
		case 'list_open_service_tickets': {
			const limit = Math.min(Math.max(Number(input.limit ?? 50), 1), 50);
			const filter: any = { status: { $nin: ['closed'] } };
			if (input.sinceDays) {
				const days = Math.min(Math.max(Number(input.sinceDays), 1), 365);
				filter.createdAt = { $gte: new Date(Date.now() - days * 86400e3) };
			}
			const tickets = await ServiceTicket.find(filter)
				.sort({ createdAt: -1 })
				.limit(limit + 1)
				.lean() as any[];
			const truncated = tickets.length > limit;
			return {
				tickets: tickets.slice(0, limit).map(t => ({
					_id: t._id,
					spuId: t.spuId,
					spuSerialNumber: t.spuSerialNumber,
					title: t.title,
					description: t.description,
					priority: t.priority,
					status: t.status,
					assignedTo: t.assignedTo?.username,
					createdBy: t.createdBy?.username,
					createdAt: t.createdAt,
					updatedAt: t.updatedAt
				})),
				totalReturned: Math.min(tickets.length, limit),
				truncated,
				source: 'ServiceTicket model where status != closed',
				sourceUrl: '/admin/service-tickets'
			};
		}
		case 'recent_device_events': {
			const hours = Math.min(Math.max(Number(input.sinceHours ?? 24), 1), 720);
			const limit = Math.min(Math.max(Number(input.limit ?? 100), 1), 100);
			const filter: any = { createdAt: { $gte: new Date(Date.now() - hours * 3600e3) } };
			if (input.deviceId) filter.deviceId = String(input.deviceId);
			if (input.eventType) filter.eventType = String(input.eventType);
			const events = await DeviceEvent.find(filter)
				.select('_id deviceId eventType cartridgeUuid success errorMessage createdAt')
				.sort({ createdAt: -1 })
				.limit(limit + 1)
				.lean() as any[];
			const truncated = events.length > limit;
			return {
				events: events.slice(0, limit).map(e => ({
					_id: e._id,
					deviceId: e.deviceId,
					eventType: e.eventType,
					cartridgeUuid: e.cartridgeUuid,
					success: e.success,
					errorMessage: e.errorMessage,
					createdAt: e.createdAt
				})),
				totalReturned: Math.min(events.length, limit),
				truncated,
				windowHours: hours,
				source: 'DeviceEvent model (TTL-trimmed at 30 days)',
				sourceUrl: '/admin/device-events'
			};
		}
		case 'recent_scanner_events': {
			const minutes = Math.min(Math.max(Number(input.sinceMinutes ?? 60), 1), 1440);
			const limit = Math.min(Math.max(Number(input.limit ?? 100), 1), 100);
			const filter: any = { receivedAt: { $gte: new Date(Date.now() - minutes * 60e3) } };
			if (input.deviceId) filter.deviceId = String(input.deviceId);
			const events = await ScannerEvent.find(filter)
				.select('_id deviceId eventType barcode source contextRef errorMessage receivedAt')
				.sort({ receivedAt: -1 })
				.limit(limit + 1)
				.lean() as any[];
			const truncated = events.length > limit;
			return {
				events: events.slice(0, limit).map(e => ({
					_id: e._id,
					deviceId: e.deviceId,
					eventType: e.eventType,
					barcode: e.barcode,
					source: e.source,
					contextRef: e.contextRef,
					errorMessage: e.errorMessage,
					receivedAt: e.receivedAt
				})),
				totalReturned: Math.min(events.length, limit),
				truncated,
				windowMinutes: minutes,
				source: 'ScannerEvent model',
				sourceUrl: '/admin/scanner-events'
			};
		}
		case 'list_open_shipping_lots': {
			const lots = await ShippingLot.find({
				status: { $in: ['open', 'testing', 'released'] }
			})
				.select('_id assayType customer status cartridgeCount releasedAt releasedBy notes createdAt updatedAt')
				.sort({ createdAt: -1 })
				.limit(50)
				.lean() as any[];
			return {
				shippingLots: lots.map(l => ({
					_id: l._id,
					assay: l.assayType?.name,
					customer: l.customer?.name,
					status: l.status,
					cartridgeCount: l.cartridgeCount,
					releasedAt: l.releasedAt,
					releasedBy: l.releasedBy,
					notes: l.notes,
					createdAt: l.createdAt
				})),
				totalReturned: lots.length,
				source: 'ShippingLot model where status in [open, testing, released]',
				sourceUrl: '/shipping'
			};
		}
		case 'find_shipping_package': {
			const q = String(input.query ?? '').trim();
			if (!q) return { error: 'query required', source: 'ShippingPackage', sourceUrl: '/shipping' };
			const packages = await ShippingPackage.find({
				$or: [
					{ _id: q },
					{ trackingNumber: q },
					{ barcode: q },
					{ 'cartridges.cartridgeId': q }
				]
			})
				.select('_id barcode customer trackingNumber carrier status packedBy packedAt shippedAt deliveredAt cartridges notes')
				.limit(10)
				.lean() as any[];
			if (packages.length === 0) {
				return {
					found: false,
					query: q,
					source: 'ShippingPackage model',
					sourceUrl: '/shipping',
					dataIntegrityNotes: [`No shipping package matched "${q}". Could be a typo, a package that never got tracking entered, or a cartridge that wasn't packed yet.`]
				};
			}
			return {
				found: true,
				packages: packages.map(p => ({
					_id: p._id,
					barcode: p.barcode,
					customer: p.customer?.name,
					trackingNumber: p.trackingNumber,
					carrier: p.carrier,
					status: p.status,
					packedBy: p.packedBy,
					packedAt: p.packedAt,
					shippedAt: p.shippedAt,
					deliveredAt: p.deliveredAt,
					cartridgeCount: Array.isArray(p.cartridges) ? p.cartridges.length : 0,
					cartridges: Array.isArray(p.cartridges)
						? p.cartridges.slice(0, 20).map((c: any) => ({ cartridgeId: c.cartridgeId, addedAt: c.addedAt }))
						: [],
					notes: p.notes
				})),
				totalReturned: packages.length,
				source: 'ShippingPackage model (searched _id, trackingNumber, barcode, cartridges.cartridgeId)',
				sourceUrl: '/shipping'
			};
		}
		case 'get_user_training': {
			if (!ctx.isAdmin) {
				return {
					error: 'Training records are admin-only. Ask an admin to look this up.',
					source: 'User.trainingRecords (admin-gated)',
					sourceUrl: '/admin/users'
				};
			}
			const username = String(input.username ?? '').trim();
			if (!username) return { error: 'username required', source: 'User.trainingRecords', sourceUrl: '/admin/users' };
			const user = await User.findOne({ username: { $regex: `^${username.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`, $options: 'i' } })
				.select('_id username firstName lastName trainingRecords')
				.lean() as any;
			if (!user) {
				return {
					found: false,
					username,
					source: 'User.trainingRecords',
					sourceUrl: '/admin/users',
					dataIntegrityNotes: [`No user found with username "${username}".`]
				};
			}
			const records = Array.isArray(user.trainingRecords) ? user.trainingRecords : [];
			return {
				found: true,
				username: user.username,
				fullName: [user.firstName, user.lastName].filter(Boolean).join(' '),
				trainingCount: records.length,
				trainingRecords: records.map((r: any) => ({
					documentId: r.documentId,
					documentTitle: r.documentTitle,
					documentRevision: r.documentRevision,
					trainedAt: r.trainedAt,
					trainer: r.trainerId?.username,
					signatureId: r.signatureId,
					notes: r.notes
				})),
				source: 'User.trainingRecords[] subdoc array (admin-gated)',
				sourceUrl: '/admin/users'
			};
		}
		case 'chemical_hazard_summary': {
			const raw = String(input.query ?? '').trim();
			if (!raw) return { error: 'query required', source: 'chemical-inventory CSVs', sourceUrl: undefined };
			const queries = raw.split(',').map(q => q.trim()).filter(Boolean);

			// One lookup per query term — collect best match (first hit) for each.
			const collected: any[] = [];
			const unresolved: string[] = [];
			for (const q of queries) {
				const r = lookupChemical(q, { limit: 1 });
				if (r.matches.length > 0) collected.push(r.matches[0]);
				else unresolved.push(q);
			}

			const hazardEntries = collected.map(c => ({
				tag: c.tag,
				name: c.name,
				cas: c.cas,
				hazardClass: c.hazardClass,
				physicalState: c.physicalState,
				storageCode: c.storageCode,
				primaryChemicalName: c.primaryChemicalName,
				org: c.org,
				quantityOnHand: c.quantityOnHand,
				nfpa: c.fields['NFPA (H/F/R/Spec)'] ?? null,
				classificationNotes: c.fields['Classification Notes'] ?? null,
				inventoryLink: c.inventoryLink
			}));

			// Pairwise compatibility check only when 2+ chemicals were queried.
			let compatibility: any = null;
			if (collected.length >= 2) {
				compatibility = checkCompatibility(collected);
			}

			const notFoundReason = unresolved.length > 0
				? `Couldn't match: ${unresolved.join(', ')}. Try a different name fragment, the inventory code (C-NNN / D-NNN), or the CAS number.`
				: null;

			return {
				found: hazardEntries.length > 0,
				queries,
				chemicals: hazardEntries,
				compatibility,
				notFoundReason,
				source: 'chemical-inventory CSVs + built-in storage-compatibility matrix',
				sourceUrl: undefined,
				dataIntegrityNotes: []
			};
		}
		case 'chemicals_in_protocol': {
			const q = String(input.protocolId ?? '').trim();
			if (!q) return { error: 'protocolId required', source: 'ProtocolDefinition + ReagentCatalog', sourceUrl: undefined };

			// Resolve by _id or by name fragment.
			let protocol = await ProtocolDefinition.findById(q).lean().catch(() => null) as any;
			if (!protocol) {
				const escaped = q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
				protocol = await ProtocolDefinition.findOne({ name: { $regex: escaped, $options: 'i' } })
					.sort({ updatedAt: -1 })
					.lean() as any;
			}
			if (!protocol) {
				return {
					found: false,
					query: q,
					source: 'ProtocolDefinition + ReagentCatalog',
					dataIntegrityNotes: [`No protocol matched "${q}". Try a name fragment or the protocol _id.`]
				};
			}

			const materials = Array.isArray(protocol.materials) ? protocol.materials.slice(0, 50) : [];
			const catalogIds = [...new Set(materials.map((m: any) => m?.catalogId).filter(Boolean))] as string[];

			const catalogEntries = catalogIds.length > 0
				? await ReagentCatalog.find({ _id: { $in: catalogIds } })
					.select('_id name type category subcategory manufacturer catalogNumber description tags')
					.lean() as any[]
				: [];
			const catalogMap = new Map(catalogEntries.map(e => [e._id, e]));

			let unlinkedCount = 0;
			const items = materials.map((m: any) => {
				const entry = m.catalogId ? catalogMap.get(m.catalogId) : null;
				if (entry) unlinkedCount += 0;
				return {
					key: m.key,
					catalogId: m.catalogId,
					catalogName: entry?.name ?? m.catalogName ?? null,
					type: entry?.type ?? null,
					category: entry?.category ?? null,
					amount: m.amount,
					unit: m.unit,
					manufacturer: entry?.manufacturer ?? null,
					catalogNumber: entry?.catalogNumber ?? null,
					// We don't currently link catalog entries to raw chemicals; null here is expected.
					rawChemicalLink: null
				};
			});

			const notes: string[] = [];
			notes.push('Protocols list prepared reagents from the research catalog — they don\'t link to raw chemicals (C-NNN / D-NNN) automatically. To see what raw chemicals back a prepared reagent, look up its protocolDefinitionId chain manually or use trace_reagent_chain on a cartridge that consumed it.');

			return {
				found: true,
				protocolId: protocol._id,
				protocolName: protocol.name,
				protocolVersion: protocol.version,
				protocolStatus: protocol.status,
				materialsCount: materials.length,
				materials: items,
				source: 'ProtocolDefinition.materials[] joined to ReagentCatalog (no raw-chemical link yet)',
				sourceUrl: `/research/protocols/${protocol._id}`,
				dataIntegrityNotes: notes
			};
		}
		case 'yield_trends_by_robot': {
			const days = Math.min(Math.max(Number(input.sinceDays ?? 30), 1), 90);
			const since = new Date(Date.now() - days * 86400e3);

			const runFilter: any = {
				status: 'completed',
				createdAt: { $gte: since }
			};
			if (input.robotName) runFilter['robot.name'] = { $regex: String(input.robotName).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), $options: 'i' };

			const runs = await WaxFillingRun.find(runFilter)
				.select('_id robot runEndTime cartridgeIds createdAt')
				.lean() as any[];

			const checkedOutIds = await getCheckedOutCartridgeIds();
			const allCartIds = runs.flatMap(r => r.cartridgeIds ?? []);
			const cartAgg = allCartIds.length > 0
				? await CartridgeRecord.aggregate([
					{ $match: { _id: { $in: allCartIds, $nin: checkedOutIds } } },
					{
						$group: {
							_id: '$waxFilling.runId',
							accepted: { $sum: { $cond: [
								{ $eq: [{ $toLower: { $ifNull: ['$waxQc.status', ''] } }, 'accepted'] },
								1, 0
							] } },
							scrapped: { $sum: { $cond: [
								{ $in: [{ $toLower: { $ifNull: ['$waxQc.status', ''] } }, ['scrapped', 'rejected']] },
								1, 0
							] } }
						}
					}
				])
				: [];
			const aggMap = new Map(cartAgg.map((g: any) => [g._id, g]));

			// Daily bucket per robot.
			interface Bucket { accepted: number; scrapped: number; runs: number; }
			const byRobotByDay = new Map<string, Map<string, Bucket>>();
			for (const r of runs) {
				const robot = r.robot?.name ?? 'unknown';
				const dateKey = new Date(r.runEndTime ?? r.createdAt).toISOString().slice(0, 10);
				const agg = aggMap.get(r._id) ?? { accepted: 0, scrapped: 0 };
				if (!byRobotByDay.has(robot)) byRobotByDay.set(robot, new Map());
				const dayMap = byRobotByDay.get(robot)!;
				const b = dayMap.get(dateKey) ?? { accepted: 0, scrapped: 0, runs: 0 };
				b.accepted += agg.accepted;
				b.scrapped += agg.scrapped;
				b.runs += 1;
				dayMap.set(dateKey, b);
			}

			const byRobot: any[] = [];
			for (const [robot, dayMap] of byRobotByDay.entries()) {
				const daily: any[] = [];
				let totalAccepted = 0;
				let totalScrapped = 0;
				let totalRuns = 0;
				for (const [date, b] of dayMap.entries()) {
					const total = b.accepted + b.scrapped;
					daily.push({
						date,
						accepted: b.accepted,
						scrapped: b.scrapped,
						runs: b.runs,
						yieldPct: total > 0 ? Math.round((b.accepted / total) * 1000) / 10 : null
					});
					totalAccepted += b.accepted;
					totalScrapped += b.scrapped;
					totalRuns += b.runs;
				}
				daily.sort((a, b) => a.date.localeCompare(b.date));
				const overallTotal = totalAccepted + totalScrapped;
				byRobot.push({
					robot,
					runs: totalRuns,
					accepted: totalAccepted,
					scrapped: totalScrapped,
					overallYieldPct: overallTotal > 0 ? Math.round((totalAccepted / overallTotal) * 1000) / 10 : null,
					daily
				});
			}
			byRobot.sort((a, b) => b.runs - a.runs);

			return {
				windowDays: days,
				robots: byRobot,
				totalRuns: runs.length,
				source: 'WaxFillingRun + CartridgeRecord.waxQc aggregated by robot per day',
				sourceUrl: '/cartridge-admin'
			};
		}
		case 'scrap_pareto': {
			const days = Math.min(Math.max(Number(input.sinceDays ?? 30), 1), 365);
			const byField = String(input.byField ?? 'reason').toLowerCase();
			const since = new Date(Date.now() - days * 86400e3);

			const carts = await CartridgeRecord.find({
				status: { $in: ['scrapped', 'voided'] },
				updatedAt: { $gte: since }
			})
				.select('_id status voidReason waxQc waxFilling reagentFilling qaqcRelease updatedAt')
				.lean() as any[];

			// Extract a reason + source-tag for each scrapped cart.
			interface ScrapRow { reason: string; source: string; robot: string; operator: string; }
			const rows: ScrapRow[] = carts.map(c => {
				let reason = 'unspecified';
				let source = 'unknown';
				if (c.voidReason) {
					reason = String(c.voidReason).trim() || 'unspecified';
					source = 'top-level void';
				} else if (c.waxQc?.rejectionReason) {
					reason = String(c.waxQc.rejectionReason).trim() || 'unspecified';
					source = 'wax QC';
				} else if (c.qaqcRelease?.notes) {
					reason = String(c.qaqcRelease.notes).trim() || 'unspecified';
					source = 'QA/QC release';
				}
				return {
					reason,
					source,
					robot: c.waxFilling?.robotName ?? c.reagentFilling?.robotName ?? 'unknown',
					operator: c.waxQc?.operator?.username ?? c.waxFilling?.operator?.username ?? 'unknown'
				};
			});

			// Bucket by the chosen field.
			const groupKey = byField === 'robot' ? 'robot' : byField === 'operator' ? 'operator' : 'reason';
			const counts = new Map<string, { count: number; sources: Set<string> }>();
			for (const r of rows) {
				const key = (r as any)[groupKey] || 'unspecified';
				const e = counts.get(key) ?? { count: 0, sources: new Set() };
				e.count += 1;
				e.sources.add(r.source);
				counts.set(key, e);
			}
			const total = rows.length;
			const ranked = [...counts.entries()].map(([key, e]) => ({
				[groupKey]: key,
				count: e.count,
				percentOfTotal: total > 0 ? Math.round((e.count / total) * 1000) / 10 : 0,
				sourceFields: [...e.sources]
			})).sort((a, b) => b.count - a.count).slice(0, 20);

			return {
				windowDays: days,
				byField: groupKey,
				totalScrapped: total,
				ranked,
				source: 'CartridgeRecord (scrapped + voided) — reasons aggregated from voidReason, waxQc.rejectionReason, qaqcRelease.notes',
				sourceUrl: '/cartridge-admin'
			};
		}
		case 'assay_lot_cross_reference': {
			const assayQuery = String(input.assayName ?? '').trim();
			if (!assayQuery) return { error: 'assayName required', source: 'AssayDefinition + ReagentBatchRecord + ShippingLot', sourceUrl: undefined };
			const days = Math.min(Math.max(Number(input.sinceDays ?? 90), 1), 365);
			const since = new Date(Date.now() - days * 86400e3);

			const escaped = assayQuery.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

			// Find the assay definition(s) matching the name.
			const assays = await AssayDefinition.find({
				name: { $regex: escaped, $options: 'i' }
			}).select('_id name skuCode').limit(5).lean() as any[];

			if (assays.length === 0) {
				return {
					found: false,
					query: assayQuery,
					source: 'AssayDefinition',
					dataIntegrityNotes: [`No assay matched "${assayQuery}". Try the full assay name or its SKU code.`]
				};
			}
			const assayIds = assays.map(a => a._id);

			// Reagent batches that targeted those assays in window.
			const batches = await ReagentBatchRecord.find({
				'assayType._id': { $in: assayIds },
				createdAt: { $gte: since }
			})
				.select('_id runNumber assayType robot operator runStartTime runEndTime cartridgesFilled status')
				.sort({ runStartTime: -1 })
				.limit(50)
				.lean() as any[];

			const cartridgeIds = batches.flatMap(b =>
				(b.cartridgesFilled ?? []).map((c: any) => c.cartridgeId).filter(Boolean)
			);
			// Shipments containing those carts.
			const packages = cartridgeIds.length > 0
				? await ShippingPackage.find({ 'cartridges.cartridgeId': { $in: cartridgeIds } })
					.select('_id customer trackingNumber status shippedAt cartridges')
					.limit(100)
					.lean() as any[]
				: [];

			// Map cart → shipment(s).
			const cartToShipments = new Map<string, any[]>();
			for (const p of packages) {
				for (const c of p.cartridges ?? []) {
					if (!c.cartridgeId) continue;
					if (!cartToShipments.has(c.cartridgeId)) cartToShipments.set(c.cartridgeId, []);
					cartToShipments.get(c.cartridgeId)!.push({
						packageId: p._id,
						customer: p.customer?.name,
						trackingNumber: p.trackingNumber,
						status: p.status,
						shippedAt: p.shippedAt
					});
				}
			}

			return {
				found: true,
				assayQuery,
				matchedAssays: assays.map(a => ({ _id: a._id, name: a.name, skuCode: a.skuCode })),
				windowDays: days,
				batchCount: batches.length,
				batches: batches.map(b => ({
					_id: b._id,
					runNumber: b.runNumber,
					assayName: b.assayType?.name,
					robot: b.robot?.name,
					operator: b.operator?.username,
					status: b.status,
					runStartTime: b.runStartTime,
					runEndTime: b.runEndTime,
					cartridgeCount: Array.isArray(b.cartridgesFilled) ? b.cartridgesFilled.length : 0,
					shipments: [...new Set(
						(b.cartridgesFilled ?? [])
							.map((c: any) => c.cartridgeId)
							.filter(Boolean)
							.flatMap((cid: string) => (cartToShipments.get(cid) ?? []).map(s => `${s.customer ?? 'unknown'} (${s.trackingNumber ?? 'no tracking'})`))
					)].slice(0, 10)
				})),
				source: 'AssayDefinition → ReagentBatchRecord → ShippingPackage via cartridge IDs',
				sourceUrl: '/shipping'
			};
		}
		case 'production_cycle_time': {
			const days = Math.min(Math.max(Number(input.sinceDays ?? 30), 1), 90);
			const since = new Date(Date.now() - days * 86400e3);

			const filter: any = {
				cycleTime: { $gt: 0 },
				finishTime: { $gte: since }
			};
			if (input.processType) filter['processConfig.processType'] = String(input.processType);

			const records = await LotRecord.find(filter)
				.select('cycleTime processConfig finishTime')
				.lean() as any[];

			interface Bucket { values: number[]; }
			const byType = new Map<string, Bucket>();
			for (const r of records) {
				const type = r.processConfig?.processType ?? 'unknown';
				if (!byType.has(type)) byType.set(type, { values: [] });
				byType.get(type)!.values.push(Number(r.cycleTime));
			}

			const percentile = (sorted: number[], p: number): number => {
				if (sorted.length === 0) return 0;
				const idx = Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length));
				return sorted[idx];
			};

			const byProcess: any[] = [];
			for (const [type, b] of byType.entries()) {
				const sorted = b.values.sort((a, x) => a - x);
				const p50 = percentile(sorted, 50);
				const p90 = percentile(sorted, 90);
				const maxV = sorted[sorted.length - 1];
				byProcess.push({
					processType: type,
					sampleCount: sorted.length,
					p50Seconds: p50,
					p90Seconds: p90,
					maxSeconds: maxV
				});
			}
			byProcess.sort((a, b) => b.sampleCount - a.sampleCount);

			return {
				windowDays: days,
				processCount: byProcess.length,
				byProcess,
				source: 'LotRecord.cycleTime aggregated by processConfig.processType',
				sourceUrl: '/manufacturing'
			};
		}
		case 'chemical_burn_rate': {
			const q = String(input.query ?? '').trim();
			if (!q) return { error: 'query required', source: 'chemical-inventory CSVs', sourceUrl: undefined };

			const r = lookupChemical(q, { limit: 1 });
			if (r.matches.length === 0) {
				return {
					found: false,
					query: q,
					source: 'chemical-inventory CSVs',
					dataIntegrityNotes: [`Couldn't find a chemical matching "${q}". Try a name fragment, the inventory code (C-NNN / D-NNN), or the CAS number.`]
				};
			}
			const c = r.matches[0];
			return {
				found: true,
				tag: c.tag,
				name: c.name,
				org: c.org,
				cas: c.cas,
				hazardClass: c.hazardClass,
				currentQuantity: c.quantityOnHand,
				storageCode: c.storageCode,
				consumptionRate: null,
				daysRemaining: null,
				source: 'chemical-inventory CSVs (consumption tracking not yet wired into BIMS)',
				sourceUrl: undefined,
				dataIntegrityNotes: [
					'Raw-chemical consumption (C-NNN / D-NNN items) isn\'t tracked in BIMS yet — there\'s no transaction stream for bottle pulls or bench usage. Current quantity is what the CSV inventory says we have; we can\'t project days-of-runway until usage logging ships.'
				]
			};
		}
		case 'list_recent_document_changes': {
			const days = Math.min(Math.max(Number(input.sinceDays ?? 7), 1), 90);
			const limit = Math.min(Math.max(Number(input.limit ?? 30), 1), 30);
			const since = new Date(Date.now() - days * 86400e3);
			const filter: any = { 'revisions.createdAt': { $gte: since } };
			if (input.status) filter.status = String(input.status);
			const docs = await Document.find(filter)
				.select('_id documentNumber title category currentRevision status effectiveDate revisions')
				.sort({ updatedAt: -1 })
				.limit(limit + 1)
				.lean() as any[];
			const truncated = docs.length > limit;
			return {
				documents: docs.slice(0, limit).map(d => {
					const recentRevs = (Array.isArray(d.revisions) ? d.revisions : [])
						.filter((r: any) => r.createdAt && new Date(r.createdAt) >= since)
						.sort((a: any, b: any) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
					const newest = recentRevs[0];
					return {
						_id: d._id,
						documentNumber: d.documentNumber,
						title: d.title,
						category: d.category,
						status: d.status,
						currentRevision: d.currentRevision,
						effectiveDate: d.effectiveDate,
						newestRevisionInWindow: newest ? {
							revision: newest.revision,
							status: newest.status,
							changeDescription: newest.changeDescription,
							createdAt: newest.createdAt,
							approvedAt: newest.approvedAt
						} : null,
						revisionCountInWindow: recentRevs.length
					};
				}),
				totalReturned: Math.min(docs.length, limit),
				truncated,
				windowDays: days,
				source: 'Document.revisions[] filtered to recent createdAt',
				sourceUrl: '/documents'
			};
		}
		case 'shift_summary': {
			const hours = Math.min(Math.max(Number(input.windowHours ?? 8), 1), 24);
			const since = new Date(Date.now() - hours * 3600e3);
			const now = new Date();

			const [waxRuns, reagentRuns, anomalies, overdueCals, expiringLots, scrappedCarts] = await Promise.all([
				WaxFillingRun.find({ $or: [{ startedAt: { $gte: since } }, { updatedAt: { $gte: since } }] })
					.select('_id status startedAt completedAt blockReason cartridgeIds')
					.sort({ startedAt: -1 })
					.limit(50)
					.lean() as any,
				ReagentBatchRecord.find({ $or: [{ startedAt: { $gte: since } }, { updatedAt: { $gte: since } }] })
					.select('_id status startedAt completedAt blockReason cartridgeIds')
					.sort({ startedAt: -1 })
					.limit(50)
					.lean() as any,
				BimsAnomaly.find({ status: { $ne: 'resolved' } })
					.select('_id title summary severity firstSeenAt')
					.sort({ severity: -1, firstSeenAt: -1 })
					.limit(20)
					.lean() as any,
				CalibrationRecord.find({ nextDueAt: { $lte: now } })
					.select('_id equipmentTag equipmentName nextDueAt')
					.sort({ nextDueAt: 1 })
					.limit(20)
					.lean() as any,
				ReceivingLot.find({
					status: 'accepted',
					expiryDate: { $gte: now, $lte: new Date(Date.now() + 14 * 86400e3) }
				})
					.select('_id partNumber lotNumber expiryDate')
					.sort({ expiryDate: 1 })
					.limit(20)
					.lean() as any,
				CartridgeRecord.countDocuments({
					status: 'scrapped',
					updatedAt: { $gte: since }
				})
			]);

			const allRuns: any[] = [...(waxRuns as any[]), ...(reagentRuns as any[])];
			const runsCompleted = allRuns.filter((r: any) =>
				r.completedAt && new Date(r.completedAt) >= since && r.status === 'completed'
			).length;
			const runsStarted = allRuns.filter((r: any) =>
				r.startedAt && new Date(r.startedAt) >= since
			).length;
			const runsBlocked = allRuns
				.filter((r: any) => r.status === 'blocked' || r.status === 'aborted' || r.blockReason)
				.slice(0, 10)
				.map((r: any) => ({
					runId: r._id,
					status: r.status,
					blockReason: r.blockReason ?? null,
					cartridgeCount: Array.isArray(r.cartridgeIds) ? r.cartridgeIds.length : 0
				}));

			const integrityNotes: string[] = [];
			if (allRuns.length === 0) {
				integrityNotes.push(`No run activity in the last ${hours}h — verify operators are logging into BIMS or check /spu/runs directly.`);
			}

			return {
				windowStart: since.toISOString(),
				windowEnd: now.toISOString(),
				windowHours: hours,
				runsCompleted,
				runsStarted,
				runsBlocked,
				anomaliesOpen: (anomalies as any[]).map((a: any) => ({
					anomalyId: a._id,
					title: a.title,
					summary: a.summary,
					severity: a.severity,
					firstSeenAt: a.firstSeenAt
				})),
				equipmentOutOfCal: (overdueCals as any[]).map((c: any) => ({
					tag: c.equipmentTag,
					name: c.equipmentName,
					dueAt: c.nextDueAt,
					daysOverdue: Math.floor((now.getTime() - new Date(c.nextDueAt).getTime()) / 86400e3)
				})),
				chemicalsExpiringSoon: (expiringLots as any[]).map((l: any) => ({
					partNumber: l.partNumber,
					lotNumber: l.lotNumber,
					expiryDate: l.expiryDate,
					daysToExpiry: Math.floor((new Date(l.expiryDate).getTime() - now.getTime()) / 86400e3)
				})),
				scrappedCartridges: scrappedCarts,
				dataIntegrityNotes: integrityNotes.length > 0 ? integrityNotes : undefined,
				source: 'Aggregated: WaxFillingRun + ReagentBatchRecord + BimsAnomaly + CalibrationRecord + ReceivingLot + CartridgeRecord',
				sourceUrl: '/spu/runs'
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

8. **Ask BIMS is read-only. Never mutate; redirect to the right surface.** If the user asks to CREATE, UPDATE, DELETE, COMPLETE, FINALIZE, ABORT, RELEASE, SCRAP, VOID, SUBMIT, APPROVE, RE-RUN, or otherwise CHANGE state — say so directly and point them to the actual BIMS page that owns the action. NEVER simulate the change, NEVER claim it happened, NEVER offer to "queue" or "submit on your behalf." Template: "I'm read-only — I can look this up but I can't change it. To <action>, use the <area> in BIMS (e.g., wax-filling QC page, cartridge admin, work-instruction runner). That's where the audit log and operator sign-off live." This applies to BOTH BIMS and the research-side collections (experiments, reagents, protocols, etc.) — even though research-v2 has /api/agent/* mutation endpoints, Ask BIMS is wired read-only and that's intentional. When the BIMS+research unification ships and lives at one website, mutation tooling will be revisited; for now, redirect every "change X" request to a human-driven surface.

9. **"How many cartridges can I [action] right now?" — count the UPSTREAM queue, not the material.** Operators frame work in terms of the action they're about to do; the question is always about how many physical cartridges are READY to be acted on next, which means counting cartridges in the status JUST BEFORE the action transition. Never default to material-inventory math or forecast tools.

Mapping (action → status to count via count_cartridges_by_status or find_cartridges):
- "fill with wax" / "wax-fill" / "run on the OT-2 for wax" → status: 'backing' (backed carts ready for wax filling)
- "fill with reagent" / "reagent-fill" → status: 'wax_stored' (wax-filled-and-stored carts ready for reagent)
- "QC" / "inspect" / "release" → status corresponds to the upstream phase of that QC step
- "ship" → status: 'released' (passed QA/QC, ready for packaging)
- "test" / "run on the SPU" → status: 'linked' (assay loaded, ready for device run)

ONLY reach for material-volume tools (get_wax_tube_inventory, reagent inventory) or forecast tools (runway, inventory_burn_rate) when the user EXPLICITLY frames the question as material capacity ("maximum", "additional", "if I had unlimited carts", "what's the throughput from current stock"). If both interpretations are plausible (rare), answer the upstream-queue interpretation first and ONLY add the material number as a secondary sentence — never replace the queue answer with a forecast.

Real example from a 2026-05-13 user complaint: question "how many cartridges can I fill with wax right now?" was answered with bulk wax volume math (179,200 μL of wax → 150-300 cartridges by volume). The operator wanted the count of BACKED cartridges in the queue. Bug: agent routed to get_wax_tube_inventory; should have routed to count_cartridges_by_status with status='backing'.

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

G. **NEVER re-call the same tool in one turn, and don't chain browse→find→re-find sequences.** Before calling a tool, check whether you've already called it in this conversation turn — even with different parameters or a different query string. If yes, USE THE PRIOR RESULT.

   Concrete failure modes (ALL of these are anti-redundancy violations):
   - You call list_recent_runs(sinceHours=24), get no matches, then call list_recent_runs(sinceHours=168) hoping for more. Fix: pass a generous window on your FIRST call.
   - You call search_documentation(query='X'), get thin results, then call search_documentation(query='Y') hoping for better matches. Fix: pick your best query first time. If results are weak, return them and tell the user "no strong matches — try refining with a different keyword" rather than burning tokens on a second call.
   - You call search_work_instructions(query='WI-01'), get a hit with matchedSteps[], then call search_work_instructions(query='WI-01 backing') to drill in. Fix: the first call ALREADY returned the WI with its matched steps and full step count. Use what you got.
   - You call find_protocol(query='Active Beads v2') and don't get an exact match, then call list_protocols to browse, then call find_protocol AGAIN with an ID from the browse result. Fix: if find_protocol doesn't match, return the closest-fit info to the user with a "did you mean…" — do NOT chain to list_protocols then back to find_protocol.

   Two calls to the same tool in one turn is ALWAYS a bug. Plan your single best call and accept whatever comes back.

H. **UUID-style IDs are ReceivingLot IDs, not parts.** A string like 74b942a2-16a5-4ae4-aa91-917d3ecc146a is a ReceivingLot._id (or a similar UUID-style barcode). Use find_receiving_lot, NOT find_part. find_part queries the PT-CT-XXX catalog and will return nothing for UUID lookups, which then leads to false-positive "lot not found" warnings. Recognize UUIDs by their shape (8-4-4-4-12 hex with dashes).

---

OPERATOR EXPERIENCE — how to shape the answer to match how the operator works:

1. **Lead with the number.** For quantitative questions ("how many", "how much", "when", "what percent"), start the answer with the digit + unit, then one short line of context, then the IDs + verify link. Operators on the floor are scanning for the number first; if you bury it in a paragraph they miss it.
   - BAD: "Looking at the cartridge records, I can see that there are currently a number of cartridges in the backing status, specifically 47 of them, which are ready for wax filling."
   - GOOD: "47 backed cartridges ready for wax fill. From runs in the last 5 days; see /spu/cartridge?status=backing."

2. **Disambiguate site (BT vs Fannin).** Equipment and chemicals exist at both sites. If the user doesn't specify and the result returns hits on both sides, surface both with their org prefix (BT uses B-XX floor / E-XX bench; Fannin uses B-XX floor / F-XX bench). If only one side has it, lead with the site name. If both sides have it and the answer would be different per site, ask "BT or Fannin?" before answering.

3. **Time windows: name the window explicitly.** "Today" means since 06:00 site-local (shift start). "This shift" means since 06:00 if the current time is before 18:00, since 18:00 otherwise. "Recent" without qualifier = last 24 hours. Always state the window in the answer ("from 06:00 today", "in the last 24 hours") so the operator knows what's included.

4. **Multi-turn pronoun coherence.** When the user's follow-up says "it", "that one", "the run", "the cartridge", resolve to the primary entity from the previous turn's tool result. If the prior turn had multiple entities of the same type (e.g., 5 cartridges listed), ask: "Which one — by ID or position in the list?" Never silently pick one.

5. **Next-step proactivity.** After answering, if the result clearly reveals a blocked workflow OR an obvious next action, surface it under a short \`Next step:\` line. Examples: "Next step: scan PT-CT-114 from the rack to start the wax fill." / "Next step: the cartridge oven calibration is 3 days overdue — open /equipment/calibrations to log it." Do NOT invent steps for purely informational questions ("what is a backing lot?" gets no next step).

6. **Citation mode.** If the user says "cite this", "for the record", "I need this for an audit", "FDA reference", or asks the answer be formatted for paper records, append a single line at the bottom: \`Cited: BIMS Ask, <ISO timestamp UTC>, response <responseId>, model <model name>\`. The responseId is in your runtime context; use the current UTC ISO timestamp. This is a formatting addition only — never invent values to make a citation look fuller.

7. **Safety-critical results lead the answer.** When any tool result contains \`safetyCritical: true\`, the answer MUST open with the hazard line(s) from \`safetyCriticalReasons\` — not bury them mid-paragraph, not summarize them away. Format: a leading line like "⚠ Safety-critical: <reason>" before any other content, then the rest of the answer. The widget will render these prominently; do not also reformat them into a code block.
   - HTX chemicals (methotrexate, sodium azide, organomercurials) → lead with isolation requirement before mentioning storage code or quantity.
   - Calibration overdue → lead with "equipment locked out" before listing the due date.
   - Never invent a safetyCritical claim. If no tool returned \`safetyCritical: true\`, do not fabricate a hazard banner.

8. **Explain mode (cartridge walkthrough).** When the user says "explain this cartridge", "walk me through this cart", "what's the story", "summarize the history", or similar narrative framing, call \`trace_cartridge\` and use its \`explain\` array verbatim as a bulleted story. Do not paraphrase the explain bullets — they're written for the operator and follow the lab vocabulary. If \`explain\` is missing or empty, fall back to assembling the same story from the raw lineage fields. Do not use explain mode for terse "what's the status" questions — those still get the direct count/status answer per rule 1.

9. **Page context.** When the user's message is preceded by a \`## CURRENT PAGE\` block, that's the widget telling you where the operator is in BIMS — path, optional title, optional entityType + entityId. Treat it as quiet context, NOT as the question itself.
   - If the question contains a short pronoun ("this", "that", "it", "the cart", "the run", "this lot") AND \`entityType\`/\`entityId\` is present AND the pronoun's category matches \`entityType\`, resolve the pronoun to \`entityId\` and call the appropriate tool with that id. Example: page is \`/spu/cartridge/abc123\`, user asks "what's wrong with this?" → call \`find_cartridge\` (or \`trace_cartridge\`) with \`abc123\`.
   - If \`entityType\` does NOT match the pronoun's category (page is a cartridge, user asks "who finalized the run?"), IGNORE \`pageContext\` and treat the question as a normal lookup. Do not silently substitute the wrong id.
   - If the question is fully specified (has its own id or doesn't reference the page entity), just answer the question; \`pageContext\` is informational only. Never volunteer "I see you're on page X" — operators know what page they're on.
   - Never invent a pageContext value. If \`entityId\` is missing but \`entityType\` is set, only the page-area generalization is usable — ask for the id rather than guessing.

---

VOICE & PHRASING — how your answers should sound to the operator reading them:

You're talking to people who run this lab every day. They know cartridges, wax filling, reagent filling, assays, QC, SPUs, the manufacturing flow, FDA/recall implications, Mocreo temperatures, the OT-2 robots. They do NOT know — and should NOT need to know — the schema, table names, tool names, field names, or any internal jargon you read in your tool descriptions. Talk to them like a coworker who happens to have looked something up, not like an AI assistant explaining its own plumbing.

Rules for what comes out of your mouth:

1. **Never mention tool names, function names, or table names in the answer.** "I called list_recent_runs and it returned 5 results" → BAD. "Here are the 5 runs from the last week" → GOOD. The user does not need to know which tool you used; they need the answer. The sourceUrl link is there if they want to verify in BIMS.

2. **Never name database fields or schema concepts in the answer.** "The reagentChain[] field is empty" → BAD. "We haven't recorded the reagent chain for this cartridge yet — that workflow hasn't shipped" → GOOD. "The dataIntegrityNotes show…" → BAD. "There's one thing worth flagging:" → GOOD.

3. **Never surface internal counts that are meaningless to operators.** "The search corpus has 42 allowlisted files" → BAD. "I checked our documentation and didn't find anything on that" → GOOD. "Result was truncated at 50" → BAD. "I found at least 50; there may be more — want me to narrow?" → GOOD.

4. **When something isn't found, say so naturally.** Bad: "Cartridge X does not exist in the system." Good: "I can't find a cartridge with that ID — want to double-check the barcode?"

5. **When you're surfacing a known data gap, explain it in plain terms.** Don't read the integrity note verbatim. Translate it. Bad: "dataIntegrityNote: PartDefinition.inventoryCount may drift from sum of accepted ReceivingLot quantities." Good: "Heads up — the running inventory total can drift from what we've actually received in lots, so I'm pulling the lot total directly to be safe."

6. **Tone is direct and warm.** Match how a competent coworker would explain something. Short sentences. No corporate hedging ("As an AI assistant, I…"). No exclamation points. Don't apologize unnecessarily. Don't pad with "Great question!" or "I hope this helps!"

7. **When you cite a source, name the doc, not the tool.** "Per WI-01 step 4…" or "From the manufacturing flow audit…" — NOT "search_work_instructions returned WI-01 with matched step 4". The doc name is real; the tool name is internal scaffolding.

8. **Use the field name only when the user asked a code-level question.** If someone asks "what field links a cart to its wax run?" — yes, say waxFilling.runId. If they ask "where do I see what wax run filled this cart?" — say "open the cart's record; the wax run is linked at the top."

9. **Confidence calibration in plain English.** At partial/degraded confidence, qualify the answer in human terms ("based on what we've actually logged…", "this is what's recorded, though some carts have gaps…") rather than citing the confidence enum.

10. **Examples of full bad → good translations** (read these — they teach the pattern):
   - BAD: "I called get_wax_tube_inventory. Source: ReceivingLot model filtered by partNumber=PT-CT-114 and status=accepted. Result: 8 lots remaining."
   - GOOD: "We've got 8 wax tube lots on the shelf right now. (Open the inventory page if you want the per-lot breakdown.)"
   - BAD: "trace_reagent_chain returned found:true with reagentChain.length=0 and a dataIntegrityNote about Jacob's deferred attach UI."
   - GOOD: "I can see this cartridge, but its reagent chain hasn't been recorded yet — that workflow hasn't shipped, so most carts come back empty on this. The other tracing paths (input lots, runs, etc.) still work."
   - BAD: "search_documentation returned no matches for 'laser cutting issue'. Corpus: 42 allowlisted .md files."
   - GOOD: "I couldn't find anything in our docs that matches that phrasing — want me to try different keywords?"

The way you'd explain something to a smart coworker over coffee is the way the operator wants to read it.`;

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

/**
 * Coarse confidence signal derived from tool results, not from logprobs.
 *
 *   high     — every tool returned a clean payload; no integrity notes, no
 *              truncation, no not-found, no errors.
 *   partial  — at least one tool returned truncated results, an empty match,
 *              or a "not found" — the answer is incomplete but not unreliable.
 *   degraded — at least one tool surfaced dataIntegrityNotes with content,
 *              or any tool errored. Caller should phrase the answer cautiously
 *              and surface why.
 *
 * The widget should render this as a badge next to the answer. The system
 * prompt instructs Claude to qualify language at non-high confidence.
 */
export type AskBimsConfidence = 'high' | 'partial' | 'degraded';

export interface AskBimsResult {
	/**
	 * Stable identifier for this specific answer. The widget passes this back
	 * to /api/agent/ask/feedback when the operator clicks thumbs up/down so
	 * the feedback row can reference exactly which answer was rated.
	 */
	responseId: string;
	answer: string;
	toolCalls: Array<{ name: string; input: any; result: any }>;
	usage?: AskBimsUsage;
	model?: AskBimsModel;
	confidence?: AskBimsConfidence;
	confidenceReasons?: string[];
	error?: string;
}

/**
 * Walk every tool result and derive a coarse confidence + the specific
 * signals that drove it. Heuristic, not probabilistic — but the agent
 * harness guide's recommendation: "ground confidence in concrete tool-output
 * conditions, not in the model's self-report."
 */
function inferConfidence(toolCalls: AskBimsResult['toolCalls']): { confidence: AskBimsConfidence; reasons: string[] } {
	const reasons: string[] = [];
	let degraded = false;
	let partial = false;

	for (const tc of toolCalls) {
		const r = tc.result;
		if (!r || typeof r !== 'object') continue;

		const notes = (r as any).dataIntegrityNotes;
		if (Array.isArray(notes) && notes.length > 0) {
			degraded = true;
			reasons.push(`${tc.name} surfaced ${notes.length} dataIntegrityNote(s)`);
		}
		if ((r as any).error) {
			degraded = true;
			reasons.push(`${tc.name} returned an error`);
		}
		if ((r as any).skipped) {
			// Anti-redundancy guard refusal — informational, not a confidence hit.
			continue;
		}
		if ((r as any).truncated === true) {
			partial = true;
			reasons.push(`${tc.name} truncated its result`);
		}
		if ((r as any).found === false) {
			partial = true;
			reasons.push(`${tc.name} returned not-found`);
		}
		if ((r as any).timedOut === true) {
			partial = true;
			reasons.push(`${tc.name} timed out`);
		}
	}

	if (degraded) return { confidence: 'degraded', reasons };
	if (partial) return { confidence: 'partial', reasons };
	return { confidence: 'high', reasons };
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

/**
 * Page-context payload threaded from the widget. The widget captures the
 * current URL/title on open and parses common BIMS routes into an entity
 * type + id, so short follow-ups like "what's wrong with this?" can resolve
 * "this" without the user repeating the cartridge/run/lot id.
 *
 * Surfaced into the agent by prepending a `## CURRENT PAGE` block to the
 * last user message. Kept off the system prompt deliberately so the cached
 * system prompt stays stable across navigation.
 *
 * Optional in every shape — missing pageContext is the no-op path.
 */
export interface AskBimsPageContext {
	path: string;
	title?: string;
	entityType?: 'cartridge' | 'run' | 'wax_filling_run' | 'wax_batch' | 'reagent_run' |
		'lot' | 'receiving_lot' | 'part' | 'equipment' | 'document' | 'work_instruction' |
		'anomaly' | 'experiment' | 'protocol';
	entityId?: string;
}

export interface AskBimsOpts {
	model?: AskBimsModel;
	/**
	 * Sampling temperature override. Production leaves this undefined (Anthropic
	 * default), but the test harness passes 0 for deterministic regression
	 * detection — per Agent Harness Engineering Guide 2026.
	 */
	temperature?: number;
	userId?: string;
	username?: string;
	/**
	 * Whether the caller has admin:full permission. Threaded into runTool so
	 * admin-gated tools (e.g. get_user_training) can reject non-admin callers
	 * cleanly rather than leak data. Optional — defaults to false (non-admin).
	 */
	isAdmin?: boolean;
	/**
	 * Optional page context from the widget. See AskBimsPageContext for shape.
	 */
	pageContext?: AskBimsPageContext;
}

/**
 * Agent loop using Anthropic tool-use. Accepts conversation history + an optional model override.
 */
export async function askBims(history: AskBimsMessage[], opts: AskBimsOpts = {}): Promise<AskBimsResult> {
	const t0 = Date.now();
	const result = await runAgentLoop(history, opts);
	const durationMs = Date.now() - t0;

	// Log cost telemetry — fire-and-forget, never blocks response.
	if (opts.userId) {
		const model = result.model ?? (opts.model ?? DEFAULT_MODEL);
		const costUsd = result.usage?.estCostUsd ?? 0;
		void logCostTelemetry({
			userId: opts.userId,
			username: opts.username,
			model,
			usage: {
				inputTokens: result.usage?.inputTokens ?? 0,
				outputTokens: result.usage?.outputTokens ?? 0,
				cacheReadTokens: result.usage?.cacheReadTokens ?? 0,
				cacheWriteTokens: result.usage?.cacheWriteTokens ?? 0
			},
			costUsd,
			toolCallCount: result.toolCalls.length,
			uniqueToolCount: new Set(result.toolCalls.map(tc => tc.name)).size,
			durationMs,
			errorClass: result.error ? 'agent_error' : undefined
		});

		// Conversation telemetry — captures the actual question + answer + tool
		// trail. Joined to the cost log by responseId. redactPii is no-op pending
		// policy; raw text is stored so future ETL is clean.
		const lastUserMsg = [...history].reverse().find(m => m.role === 'user');
		if (lastUserMsg) {
			void logConversationTelemetry({
				responseId: result.responseId,
				userId: opts.userId,
				username: opts.username,
				model,
				question: lastUserMsg.content,
				answer: result.answer ?? '',
				toolCalls: result.toolCalls,
				costUsd,
				durationMs,
				errorClass: result.error ? 'agent_error' : undefined,
				confidence: result.confidence,
				confidenceReasons: result.confidenceReasons
			});
		}
	}

	return result;
}

async function runAgentLoop(history: AskBimsMessage[], opts: AskBimsOpts): Promise<AskBimsResult> {
	// Stable id for THIS answer. Surfaced in AskBimsResult.responseId so the
	// widget can pass it to /api/agent/ask/feedback when the operator clicks
	// thumbs up/down. Generated up front so every return path shares one id.
	const responseId = generateId();

	const client = getClient();
	if (!client) {
		return { responseId, answer: '', toolCalls: [], error: 'ANTHROPIC_API_KEY not configured on the server.' };
	}
	if (history.length === 0 || history[history.length - 1].role !== 'user') {
		return { responseId, answer: '', toolCalls: [], error: 'Last message must be from user.' };
	}

	const model: AskBimsModel = ALLOWED_MODELS.includes(opts.model as AskBimsModel)
		? (opts.model as AskBimsModel)
		: DEFAULT_MODEL;

	const messages: Anthropic.MessageParam[] = history.map(h => ({
		role: h.role,
		content: h.content
	}));

	// Prepend a small CURRENT PAGE block to the FINAL user message when pageContext
	// is supplied. Keeps the system prompt cacheable while still threading page
	// context into the turn. Validated shape: at minimum a path; entityType/Id are
	// optional. We bail silently on bad shapes (handled upstream too).
	if (opts.pageContext && typeof opts.pageContext.path === 'string' && opts.pageContext.path.length > 0) {
		const pc = opts.pageContext;
		const lines: string[] = ['## CURRENT PAGE', `path: ${pc.path}`];
		if (pc.title) lines.push(`title: ${pc.title}`);
		if (pc.entityType) lines.push(`entityType: ${pc.entityType}`);
		if (pc.entityId) lines.push(`entityId: ${pc.entityId}`);
		const block = lines.join('\n') + '\n\n';
		for (let i = messages.length - 1; i >= 0; i--) {
			if (messages[i].role === 'user' && typeof messages[i].content === 'string') {
				messages[i] = { role: 'user', content: block + (messages[i].content as string) };
				break;
			}
		}
	}

	// Filter out disabled tools (env-flag kill-switch — principle #11)
	const disabledTools = getDisabledTools();
	const activeTools = disabledTools.size > 0
		? TOOLS.filter(t => !disabledTools.has(t.name))
		: TOOLS;

	const toolCalls: AskBimsResult['toolCalls'] = [];
	// Per-turn tool-name dedup enforcement (Rule G). Tracks which tools have
	// already run in this turn so the loop can short-circuit a second call
	// with a synthetic refusal instead of re-executing.
	const calledToolNames = new Set<string>();
	const usage = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 };
	const MAX_ITERATIONS = 8;

	for (let i = 0; i < MAX_ITERATIONS; i++) {
		let response: Anthropic.Message;
		try {
			response = await client.messages.create({
				model,
				max_tokens: 4096,
				...(opts.temperature !== undefined ? { temperature: opts.temperature } : {}),
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
				return { responseId, answer: '', toolCalls, model, usage: { ...usage, estCostUsd: calcCost(model, usage) }, error: 'Anthropic rate limit hit. Please retry in a moment.' };
			}
			if (err instanceof Anthropic.AuthenticationError) {
				return { responseId, answer: '', toolCalls, model, error: 'ANTHROPIC_API_KEY is invalid.' };
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
					responseId,
					answer: '',
					toolCalls,
					model,
					usage: { ...usage, estCostUsd: costSoFar },
					confidence: 'degraded',
					confidenceReasons: ['Per-question Opus cost cap hit before the agent could finish.'],
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
			const conf = inferConfidence(toolCalls);
			return {
				responseId,
				answer: text,
				toolCalls,
				model,
				usage: { ...usage, estCostUsd: calcCost(model, usage) },
				confidence: conf.confidence,
				confidenceReasons: conf.reasons
			};
		}

		messages.push({ role: 'assistant', content: response.content });

		const toolResults: Anthropic.ToolResultBlockParam[] = [];
		for (const block of toolUseBlocks) {
			// Rule G enforcement — block second call to a tool already run this turn.
			// Synthetic refusal goes back to the model so it adapts instead of crashing.
			// We deliberately do NOT push refused attempts to `toolCalls` — they didn't
			// execute, and the public surface should reflect what actually ran.
			if (calledToolNames.has(block.name)) {
				const refusal = {
					error: `Anti-redundancy guard tripped: '${block.name}' was already called earlier in this turn. Per Rule G, do not re-call the same tool with different parameters. Return the prior result to the user, refine on the next user message, or pick a different tool.`,
					skipped: true,
					ruleViolation: 'anti-redundancy'
				};
				toolResults.push({
					type: 'tool_result',
					tool_use_id: block.id,
					content: JSON.stringify(refusal),
					is_error: true
				});
				continue;
			}
			calledToolNames.add(block.name);
			try {
				const out = await runTool(block.name, block.input ?? {}, {
					userId: opts.userId,
					username: opts.username,
					isAdmin: opts.isAdmin
				});
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
		responseId,
		answer: '',
		toolCalls,
		model,
		usage: { ...usage, estCostUsd: calcCost(model, usage) },
		confidence: 'degraded',
		confidenceReasons: [`Agent exhausted MAX_ITERATIONS=${MAX_ITERATIONS} without producing a final answer.`],
		error: 'Agent exceeded max iterations without a final answer.'
	};
}
