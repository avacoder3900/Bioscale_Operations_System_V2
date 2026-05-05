import Anthropic from '@anthropic-ai/sdk';
import {
	connectDB, WaxBatch, WaxFillingRun, TemperatureAlert,
	PartDefinition, Equipment, CartridgeRecord, ReagentBatchRecord,
	ReceivingLot, CalibrationRecord, ServiceTicket, TemperatureReading,
	WorkInstruction, LotRecord
} from './db';

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

export type AskBimsModel = 'claude-haiku-4-5' | 'claude-sonnet-4-6' | 'claude-opus-4-7';

export const ALLOWED_MODELS: AskBimsModel[] = ['claude-haiku-4-5', 'claude-sonnet-4-6', 'claude-opus-4-7'];
export const DEFAULT_MODEL: AskBimsModel = 'claude-sonnet-4-6';

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

Use when: "recent runs", "what ran today", "show aborted runs", "what's running right now".`,
		input_schema: {
			type: 'object',
			properties: {
				runType: { type: 'string', description: 'wax_filling | reagent_filling | any (default)' },
				status: { type: 'string', description: 'completed | aborted | running | etc' },
				sinceHours: { type: 'number', description: 'Default 24' },
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
			required: ['equipmentName'],
			cache_control: { type: 'ephemeral' }
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
			const sinceHours = input.sinceHours ?? 24;
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
			const carts = await CartridgeRecord.find({ _id: { $in: cartridgeIds } })
				.select('_id status waxQc.status').lean() as any[];
			const counts: Record<string, number> = {};
			let accepted = 0, scrapped = 0, pendingQc = 0;
			for (const c of carts) {
				const s = c.status ?? 'unknown';
				counts[s] = (counts[s] ?? 0) + 1;
				const qc = c.waxQc?.status;
				if (qc === 'accepted') accepted++;
				else if (qc === 'scrapped' || qc === 'rejected') scrapped++;
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

G. **NEVER re-call the same tool in one turn.** Before calling a tool, check whether you've already called it in this conversation turn — even with slightly different parameters. If yes, USE THE PRIOR RESULT. If you genuinely need a refined query, you have one shot to get the parameters right; calling list_recent_runs twice in a row is a bug.

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
}

/**
 * Agent loop using Anthropic tool-use. Accepts conversation history + an optional model override.
 */
export async function askBims(history: AskBimsMessage[], opts: AskBimsOpts = {}): Promise<AskBimsResult> {
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
