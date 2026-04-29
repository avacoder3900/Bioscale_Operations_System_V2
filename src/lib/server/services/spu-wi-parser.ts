import mammoth from 'mammoth';
import type { FieldDefinition, ParsedStep } from './spu-work-instruction';

export const PARSER_VERSION = '1.1.0';

const PRIMARY_PART_RE = /\bPT-SPU-(\d{3,})\b/g;
const ALT_PART_RE = /\b(SBA-SPU|IFU-SPU)-(\d{3,})\b/g;
const QTY_RE = /qty\s*=\s*(\d+)/i;

const STEP_HEADING_RE = /^\s*(?:#+\s*)?(?:step\s*)?(\d{1,3})[\).:\-\s]+(.{0,200})$/i;
const NUMBERED_LINE_RE = /^\s*(\d{1,3})[\).:]\s+(.{1,200})$/;

export type ParsedWorkInstruction = {
	title?: string;
	rawContent: string;
	steps: ParsedStep[];
	totalRequiredScans: number;
	parserVersion: string;
	warnings: string[];
};

export async function parseSpuWorkInstruction(file: {
	buffer: Buffer;
	mimeType: string;
	originalName: string;
}): Promise<ParsedWorkInstruction> {
	const warnings: string[] = [];
	const text = await extractText(file, warnings);
	const steps = segmentSteps(text);
	const parsedSteps: ParsedStep[] = steps.map((s, idx) => buildStep(s, idx + 1));

	let runningSort = 0;
	for (const step of parsedSteps) {
		for (const f of step.fieldDefinitions) f.sortOrder = ++runningSort;
	}

	const totalRequiredScans = parsedSteps.reduce((n, s) => n + s.fieldDefinitions.length, 0);

	return {
		title: deriveTitle(text, file.originalName),
		rawContent: text,
		steps: parsedSteps,
		totalRequiredScans,
		parserVersion: PARSER_VERSION,
		warnings
	};
}

async function extractText(
	file: { buffer: Buffer; mimeType: string; originalName: string },
	warnings: string[]
): Promise<string> {
	const lowerName = file.originalName.toLowerCase();
	const isDocx =
		file.mimeType === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' ||
		lowerName.endsWith('.docx');
	const isPdf = file.mimeType === 'application/pdf' || lowerName.endsWith('.pdf');

	if (isDocx) {
		const result = await mammoth.extractRawText({ buffer: file.buffer });
		if (result.messages?.length) {
			for (const m of result.messages) warnings.push(`mammoth: ${m.message}`);
		}
		return result.value ?? '';
	}

	if (isPdf) {
		const mod: any = await import('pdf-parse');
		const PDFParse = mod.PDFParse ?? mod.default?.PDFParse ?? mod.default;
		const data = new Uint8Array(file.buffer);
		const parser = new PDFParse({ data });
		const result: any = await parser.getText();
		const pages: number | undefined = result?.numpages ?? result?.total ?? result?.pages?.length;
		if (pages != null) warnings.push(`pdf: ${pages} page(s) parsed`);
		const text: string = result?.text ?? '';
		return text.replace(/\r\n/g, '\n');
	}

	warnings.push(
		`Unsupported file type (${file.mimeType || file.originalName}); treating as plain text`
	);
	return file.buffer.toString('utf8');
}

function deriveTitle(text: string, fallback: string): string {
	const firstNonEmpty = text.split(/\r?\n/).find((l) => l.trim().length > 0);
	if (firstNonEmpty && firstNonEmpty.trim().length < 120) return firstNonEmpty.trim();
	return fallback.replace(/\.[a-z]+$/i, '');
}

type RawStep = { number: number; title: string; content: string };

function segmentSteps(text: string): RawStep[] {
	const lines = text.split(/\r?\n/);
	const steps: RawStep[] = [];
	let current: RawStep | null = null;

	for (const raw of lines) {
		const line = raw.replace(/ /g, ' ').trimEnd();
		if (!line.trim()) {
			if (current) current.content += '\n';
			continue;
		}

		const heading = matchStepHeading(line);
		if (heading) {
			if (current) steps.push(current);
			current = { number: heading.number, title: heading.title.trim(), content: '' };
			continue;
		}

		if (current) current.content += line + '\n';
	}
	if (current) steps.push(current);

	if (steps.length === 0) {
		steps.push({ number: 1, title: 'Step 1', content: text });
	}

	steps.forEach((s, i) => (s.number = i + 1));
	return steps;
}

function matchStepHeading(line: string): { number: number; title: string } | null {
	const t = line.trim();
	if (/^step\s+\d+/i.test(t)) {
		const m = t.match(/^step\s+(\d+)[\).:\-\s]+(.*)$/i);
		if (m) return { number: parseInt(m[1], 10), title: m[2] || `Step ${m[1]}` };
	}
	if (/^#+\s+/.test(t)) {
		const m = t.match(/^#+\s+(?:step\s*)?(\d+)?[\).:\-\s]*(.*)$/i);
		if (m) return { number: parseInt(m[1] ?? '0', 10) || 0, title: m[2] || t };
	}
	const numbered = t.match(NUMBERED_LINE_RE);
	if (numbered) return { number: parseInt(numbered[1], 10), title: numbered[2] };
	return null;
}

function buildStep(raw: RawStep, fallbackNumber: number): ParsedStep {
	const stepNumber = raw.number > 0 ? raw.number : fallbackNumber;
	const content = raw.content.trim();
	const warnings: string[] = [];

	const partsMap = new Map<string, number>();
	const haystack = `${raw.title}\n${content}`;

	for (const m of haystack.matchAll(PRIMARY_PART_RE)) {
		const pn = `PT-SPU-${m[1]}`;
		const qty = extractAdjacentQty(haystack, m.index ?? 0) ?? 1;
		partsMap.set(pn, (partsMap.get(pn) ?? 0) + qty);
	}

	for (const m of haystack.matchAll(ALT_PART_RE)) {
		warnings.push(`Non-PT-SPU reference found: ${m[0]} — confirm if part of build`);
	}

	const partRequirements = [...partsMap.entries()].map(([partNumber, quantity]) => ({
		partNumber,
		quantity
	}));

	const fieldDefinitions: FieldDefinition[] = [];
	for (const { partNumber, quantity } of partRequirements) {
		for (let n = 1; n <= quantity; n++) {
			fieldDefinitions.push({
				fieldName: `${partNumber}_scan_${n}`.replace(/[^A-Za-z0-9_]/g, '_'),
				fieldLabel: `Scan ${partNumber} (${n} of ${quantity})`,
				fieldType: 'barcode_scan',
				isRequired: true,
				barcodeFieldMapping: partNumber,
				sortOrder: 0
			});
		}
	}

	return {
		stepNumber,
		title: raw.title || `Step ${stepNumber}`,
		content,
		partRequirements,
		fieldDefinitions,
		warnings
	};
}

function extractAdjacentQty(haystack: string, partIndex: number): number | null {
	const window = haystack.slice(Math.max(0, partIndex - 80), Math.min(haystack.length, partIndex + 120));
	const m = window.match(QTY_RE);
	if (!m) return null;
	const n = parseInt(m[1], 10);
	if (Number.isNaN(n) || n < 1 || n > 999) return null;
	return n;
}
