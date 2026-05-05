import Anthropic from '@anthropic-ai/sdk';
import { env } from '$env/dynamic/private';
import {
	connectDB, WaxBatch, WaxFillingRun, TemperatureAlert,
	PartDefinition, Equipment, CartridgeRecord, ReagentBatchRecord
} from './db';

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
	if (!env.ANTHROPIC_API_KEY) return null;
	_client = new Anthropic({ apiKey: env.ANTHROPIC_API_KEY });
	return _client;
}

const TOOLS: Anthropic.Tool[] = [
	{
		name: 'list_wax_batches',
		description: 'List wax batches with optional filter for low remaining volume. Use this to answer questions about wax supply.',
		input_schema: {
			type: 'object',
			properties: {
				maxRemainingUl: { type: 'number', description: 'Only return batches with remainingVolumeUl <= this value' },
				limit: { type: 'number', description: 'Max results (default 20)' }
			}
		}
	},
	{
		name: 'get_temperature_alerts',
		description: 'Recent temperature alerts (high_temp, low_temp, lost_connection) across all sensors.',
		input_schema: {
			type: 'object',
			properties: {
				sinceHours: { type: 'number', description: 'Only alerts from the last N hours (default 24)' },
				alertType: { type: 'string', description: 'One of: high_temp, low_temp, lost_connection' },
				onlyUnacknowledged: { type: 'boolean', description: 'Only unacknowledged alerts' },
				limit: { type: 'number' }
			}
		}
	},
	{
		name: 'get_current_temperatures',
		description: 'Current temperature reading for each sensor/equipment. Useful for "what is the temperature of X right now".',
		input_schema: {
			type: 'object',
			properties: {
				sensorName: { type: 'string', description: 'Optional filter by sensor/equipment name (case-insensitive partial match)' }
			}
		}
	},
	{
		name: 'list_recent_runs',
		description: 'Recent manufacturing runs (wax filling or reagent filling) with status, operator, cartridge count.',
		input_schema: {
			type: 'object',
			properties: {
				runType: { type: 'string', description: 'One of: wax_filling, reagent_filling, any (default)' },
				status: { type: 'string', description: 'Filter by status e.g. completed, aborted, running' },
				sinceHours: { type: 'number', description: 'Default 24' },
				limit: { type: 'number' }
			}
		}
	},
	{
		name: 'list_low_inventory_parts',
		description: 'Parts with inventory below their reorder threshold. Useful for "what do I need to order".',
		input_schema: {
			type: 'object',
			properties: {
				percentThreshold: { type: 'number', description: 'inventoryCount must be below minimumOrderQty * (1 + pct/100). Default 20%.' }
			}
		}
	},
	{
		name: 'find_part',
		description: 'Look up a part by partNumber, name, or barcode and return inventory, supplier, etc.',
		input_schema: {
			type: 'object',
			properties: {
				query: { type: 'string', description: 'partNumber, name fragment, or barcode' }
			},
			required: ['query']
		}
	},
	{
		name: 'find_cartridges',
		description: 'Look up cartridge records by status or ID.',
		input_schema: {
			type: 'object',
			properties: {
				cartridgeId: { type: 'string' },
				status: { type: 'string', description: 'e.g. backing, wax_filling, wax_stored, reagent_filled' },
				limit: { type: 'number' }
			}
		}
	},
	{
		name: 'list_equipment',
		description: 'All equipment (fridges, ovens, decks) with current status and temperature if available.',
		input_schema: {
			type: 'object',
			properties: {
				equipmentType: { type: 'string', description: 'fridge, oven, deck, etc.' }
			}
		}
	},
	{
		name: 'get_run_yield',
		description: 'Yield breakdown (accepted/scrapped/pending QC) for a specific wax filling run by runId. Use when the user asks about yield, scrap rate, or QC results for a particular run.',
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
		description: 'Full lineage trace for a single cartridge: backing lot, wax run, wax lot, QC outcome, storage location, reagent run if any. Use for any "where did this cartridge come from" or "what lots went into this" question.',
		input_schema: {
			type: 'object',
			properties: {
				cartridgeId: { type: 'string', description: 'CartridgeRecord _id' }
			},
			required: ['cartridgeId']
		}
	},
	{
		name: 'count_cartridges_by_status',
		description: 'Count cartridges grouped by status, optionally filtered to a recent time window. Use for "how many cartridges were made today" type questions.',
		input_schema: {
			type: 'object',
			properties: {
				sinceHours: { type: 'number', description: 'Only count cartridges created in the last N hours (default: all-time)' }
			},
			// cache_control on the last tool caches all tools + system together (when prefix ≥ 2048 tokens on Sonnet 4.6)
			cache_control: { type: 'ephemeral' }
		}
	}
];

async function runTool(name: string, input: any): Promise<any> {
	await connectDB();
	switch (name) {
		case 'list_wax_batches': {
			const filter: any = {};
			if (input.maxRemainingUl != null) filter.remainingVolumeUl = { $lte: input.maxRemainingUl };
			const limit = Math.min(input.limit ?? 20, 50);
			const batches = await WaxBatch.find(filter).sort({ remainingVolumeUl: 1 }).limit(limit).lean() as any[];
			return batches.map(b => ({
				lotNumber: b.lotNumber, lotBarcode: b.lotBarcode,
				remainingVolumeUl: b.remainingVolumeUl, initialVolumeUl: b.initialVolumeUl,
				fullTubeCount: b.fullTubeCount,
				createdAt: b.createdAt, createdBy: b.createdBy?.username
			}));
		}
		case 'get_temperature_alerts': {
			const filter: any = {};
			const sinceHours = input.sinceHours ?? 24;
			filter.timestamp = { $gte: new Date(Date.now() - sinceHours * 3600e3) };
			if (input.alertType) filter.alertType = input.alertType;
			if (input.onlyUnacknowledged) filter.acknowledged = false;
			const limit = Math.min(input.limit ?? 20, 100);
			const alerts = await TemperatureAlert.find(filter).sort({ timestamp: -1 }).limit(limit).lean() as any[];
			return alerts.map(a => ({
				sensorName: a.sensorName, alertType: a.alertType,
				threshold: a.threshold, actualValue: a.actualValue,
				equipmentName: a.equipmentName,
				acknowledged: a.acknowledged, timestamp: a.timestamp
			}));
		}
		case 'get_current_temperatures': {
			const eqFilter: any = { equipmentType: { $in: ['fridge', 'oven'] }, currentTemperatureC: { $exists: true } };
			if (input.sensorName) eqFilter.name = { $regex: input.sensorName, $options: 'i' };
			const eq = await Equipment.find(eqFilter).select('name currentTemperatureC lastTemperatureReadAt temperatureMinC temperatureMaxC').lean() as any[];
			return eq.map(e => ({
				name: e.name,
				currentTemperatureC: e.currentTemperatureC,
				lastReadAt: e.lastTemperatureReadAt,
				targetRange: e.temperatureMinC != null ? `${e.temperatureMinC} to ${e.temperatureMaxC}°C` : null
			}));
		}
		case 'list_recent_runs': {
			const sinceHours = input.sinceHours ?? 24;
			const since = new Date(Date.now() - sinceHours * 3600e3);
			const limit = Math.min(input.limit ?? 20, 50);
			const filter: any = { createdAt: { $gte: since } };
			if (input.status) filter.status = input.status;

			const waxRuns = input.runType === 'reagent_filling' ? [] : await WaxFillingRun.find(filter).sort({ createdAt: -1 }).limit(limit).lean();
			const reagentRuns = input.runType === 'wax_filling' ? [] : await ReagentBatchRecord.find(filter).sort({ createdAt: -1 }).limit(limit).lean().catch(() => []);
			return {
				waxFilling: (waxRuns as any[]).map(r => ({
					runId: r._id, status: r.status, robot: r.robot?.name,
					operator: r.operator?.username, cartridgeCount: r.cartridgeIds?.length ?? 0,
					runStartTime: r.runStartTime, runEndTime: r.runEndTime
				})),
				reagentFilling: (reagentRuns as any[]).map(r => ({
					runId: r._id, status: r.status, robot: r.robot?.name,
					operator: r.operator?.username
				}))
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
			return parts;
		}
		case 'find_part': {
			const q = input.query;
			const parts = await PartDefinition.find({
				$or: [
					{ partNumber: { $regex: q, $options: 'i' } },
					{ name: { $regex: q, $options: 'i' } },
					{ barcode: q }
				]
			}).limit(10).lean() as any[];
			return parts.map(p => ({
				partNumber: p.partNumber, name: p.name, inventoryCount: p.inventoryCount,
				unitOfMeasure: p.unitOfMeasure, supplier: p.supplier, minimumOrderQty: p.minimumOrderQty,
				barcode: p.barcode
			}));
		}
		case 'find_cartridges': {
			const filter: any = {};
			if (input.cartridgeId) filter._id = input.cartridgeId;
			if (input.status) filter.status = input.status;
			const limit = Math.min(input.limit ?? 20, 50);
			const carts = await CartridgeRecord.find(filter).sort({ createdAt: -1 }).limit(limit).lean() as any[];
			return carts.map(c => ({
				cartridgeId: c._id, status: c.status,
				backingLot: c.backing?.lotId,
				waxRunId: c.waxFilling?.runId,
				qcStatus: c.waxQc?.status,
				storageLocation: c.waxStorage?.location,
				createdAt: c.createdAt
			}));
		}
		case 'list_equipment': {
			const filter: any = {};
			if (input.equipmentType) filter.equipmentType = input.equipmentType;
			const eq = await Equipment.find(filter).select('name equipmentType status currentTemperatureC lastTemperatureReadAt').lean() as any[];
			return eq.map(e => ({
				name: e.name, type: e.equipmentType, status: e.status,
				currentTemperatureC: e.currentTemperatureC,
				lastTemperatureReadAt: e.lastTemperatureReadAt
			}));
		}
		case 'get_run_yield': {
			const run = await WaxFillingRun.findById(input.runId).lean() as any;
			if (!run) return { error: `Run not found: ${input.runId}` };
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
				runStartTime: run.runStartTime,
				runEndTime: run.runEndTime
			};
		}
		case 'trace_cartridge': {
			const cart = await CartridgeRecord.findById(input.cartridgeId).lean() as any;
			if (!cart) return { error: `Cartridge not found: ${input.cartridgeId}` };
			let waxRun: any = null;
			if (cart.waxFilling?.runId) {
				waxRun = await WaxFillingRun.findById(cart.waxFilling.runId)
					.select('_id status operator robot waxLotId waxBatchId runStartTime runEndTime').lean();
			}
			let waxBatch: any = null;
			if (waxRun?.waxBatchId) {
				waxBatch = await WaxBatch.findById(waxRun.waxBatchId)
					.select('lotNumber lotBarcode createdAt').lean();
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
					waxLot: waxBatch ? { lotNumber: waxBatch.lotNumber, lotBarcode: waxBatch.lotBarcode } : null
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
				} : null
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
				windowHours: input.sinceHours ?? 'all-time'
			};
		}
	}
	return { error: `Unknown tool: ${name}` };
}

const SYSTEM_PROMPT = `You are the Bioscale Internal Management System (BIMS) assistant. You answer questions about manufacturing operations at Bioscale — wax filling, reagent filling, temperature monitoring, inventory, and cartridge tracking.

You have tools to query the BIMS mongo database. Use them liberally to ground every answer in real data — never make up numbers, lot IDs, or statuses. If data is missing, say so.

Be concise and direct. Use bullet points or short tables when listing multiple items. If the user asks a vague question, ask a short clarifying question instead of guessing. Always include relevant IDs (lot numbers, run IDs, barcodes) so the user can follow up.

Temperatures are in Celsius. Wax volumes are in microliters (μL). Currency is USD.`;

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
				tools: TOOLS,
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
