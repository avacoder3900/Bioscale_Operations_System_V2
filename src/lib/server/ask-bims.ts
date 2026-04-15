import Anthropic from '@anthropic-ai/sdk';
import { env } from '$env/dynamic/private';
import {
	connectDB, WaxBatch, WaxFillingRun, TemperatureAlert, TemperatureReading,
	PartDefinition, ReceivingLot, Equipment, CartridgeRecord, ReagentBatchRecord
} from './db';

let _anthropic: Anthropic | null = null;
function getAnthropic(): Anthropic | null {
	if (_anthropic) return _anthropic;
	if (!env.ANTHROPIC_API_KEY) return null;
	_anthropic = new Anthropic({ apiKey: env.ANTHROPIC_API_KEY });
	return _anthropic;
}

// Tool definitions: each maps to a mongo query function below
const TOOLS: Anthropic.Messages.Tool[] = [
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
				alertType: { type: 'string', enum: ['high_temp', 'low_temp', 'lost_connection'], description: 'Optional filter' },
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
				runType: { type: 'string', enum: ['wax_filling', 'reagent_filling', 'any'], description: 'Default any' },
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

export interface AskBimsResult {
	answer: string;
	toolCalls: Array<{ name: string; input: any; result: any }>;
	error?: string;
}

/**
 * Run an agent loop with Claude using tool use. Accepts conversation history
 * so the caller can maintain a chat session.
 */
export async function askBims(history: AskBimsMessage[]): Promise<AskBimsResult> {
	const anthropic = getAnthropic();
	if (!anthropic) {
		return { answer: '', toolCalls: [], error: 'ANTHROPIC_API_KEY not configured on the server.' };
	}
	if (history.length === 0 || history[history.length - 1].role !== 'user') {
		return { answer: '', toolCalls: [], error: 'Last message must be from user.' };
	}

	// Build message array for Claude. Tool-use results need to be nested into
	// assistant/user turns by content blocks, so we track blocks internally.
	const messages: Anthropic.Messages.MessageParam[] = history.map(h => ({
		role: h.role,
		content: h.content
	}));

	const toolCalls: AskBimsResult['toolCalls'] = [];
	const MAX_ITERATIONS = 8;

	for (let i = 0; i < MAX_ITERATIONS; i++) {
		const response = await anthropic.messages.create({
			model: 'claude-sonnet-4-6',
			max_tokens: 2048,
			system: SYSTEM_PROMPT,
			tools: TOOLS,
			messages
		});

		// If Claude returned text and no tool use, we're done
		const hasToolUse = response.content.some(b => b.type === 'tool_use');
		if (!hasToolUse) {
			const textBlocks = response.content.filter((b): b is Anthropic.Messages.TextBlock => b.type === 'text');
			const answer = textBlocks.map(b => b.text).join('\n\n').trim();
			return { answer, toolCalls };
		}

		// Append the assistant's mixed content (text + tool_use) as a message
		messages.push({ role: 'assistant', content: response.content });

		// Execute every tool_use block and package the results
		const toolResults: Anthropic.Messages.ToolResultBlockParam[] = [];
		for (const block of response.content) {
			if (block.type !== 'tool_use') continue;
			try {
				const result = await runTool(block.name, block.input);
				toolCalls.push({ name: block.name, input: block.input, result });
				toolResults.push({
					type: 'tool_result',
					tool_use_id: block.id,
					content: JSON.stringify(result).slice(0, 12000)
				});
			} catch (err: any) {
				toolResults.push({
					type: 'tool_result',
					tool_use_id: block.id,
					is_error: true,
					content: err?.message ?? String(err)
				});
			}
		}
		messages.push({ role: 'user', content: toolResults });
	}

	return { answer: '', toolCalls, error: 'Agent exceeded max iterations without a final answer.' };
}
