import mammoth from 'mammoth';
import { nanoid } from 'nanoid';
import { uploadToR2 } from './r2';
import type { FieldDefinition, ParsedStep } from './spu-work-instruction';

export const PARSER_VERSION = '1.2.0';

const PRIMARY_PART_RE = /\bPT-SPU-(\d{3,})\b/g;
const ALT_PART_RE = /\b(SBA-SPU|IFU-SPU)-(\d{3,})\b/g;
const QTY_RE = /qty\s*=\s*(\d+)/i;

const STEP_HEADING_RE = /^\s*(?:#+\s*)?(?:step\s*)?(\d{1,3})[\).:\-\s]+(.{0,200})$/i;
const NUMBERED_LINE_RE = /^\s*(\d{1,3})[\).:]\s+(.{1,200})$/;
const IMG_MARKER_RE = /^\[\[IMG:(.+?)\]\]$/;

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
		const parseId = nanoid(8);
		let imgIndex = 0;
		const failed: string[] = [];

		const result = await mammoth.convertToHtml(
			{ buffer: file.buffer },
			{
				convertImage: mammoth.images.imgElement(async (image: any) => {
					try {
						const buf = await image.read();
						const ct: string = image.contentType || 'image/png';
						const ext = (ct.split('/')[1] || 'png').toLowerCase().replace(/[^a-z0-9]/g, '') || 'png';
						const idx = ++imgIndex;
						const key = `wi/${parseId}/img-${String(idx).padStart(3, '0')}.${ext}`;
						const url = await uploadToR2(Buffer.from(buf), key, ct);
						return { src: url, alt: `image-${idx}` };
					} catch (err: any) {
						failed.push(err?.message ?? 'unknown');
						return { src: '', alt: 'failed' };
					}
				})
			}
		);
		if (result.messages?.length) {
			for (const m of result.messages) warnings.push(`mammoth: ${m.message}`);
		}
		if (failed.length) warnings.push(`r2 upload failures: ${failed.length} (${failed[0]})`);
		return htmlToTextWithImageMarkers(result.value ?? '');
	}

	if (isPdf) {
		const mod: any = await import('pdf-parse');
		const PDFParse = mod.PDFParse ?? mod.default?.PDFParse ?? mod.default;
		const data = new Uint8Array(file.buffer);
		const parser = new PDFParse({ data });
		const result: any = await parser.getText();
		const pages: number | undefined = result?.numpages ?? result?.total ?? result?.pages?.length;
		if (pages != null) warnings.push(`pdf: ${pages} page(s) parsed`);
		warnings.push('pdf: image extraction not supported — use .docx if you need photos per step');
		const text: string = result?.text ?? '';
		return text.replace(/\r\n/g, '\n');
	}

	warnings.push(
		`Unsupported file type (${file.mimeType || file.originalName}); treating as plain text`
	);
	return file.buffer.toString('utf8');
}

function htmlToTextWithImageMarkers(html: string): string {
	let text = html;
	text = text.replace(/<img\b[^>]*\bsrc="([^"]+)"[^>]*\/?>/gi, '\n[[IMG:$1]]\n');
	text = text.replace(/<\/?(?:p|h[1-6]|li|tr|td|th|br|div)[^>]*>/gi, '\n');
	text = text.replace(/<[^>]+>/g, '');
	text = text
		.replace(/&nbsp;/g, ' ')
		.replace(/&amp;/g, '&')
		.replace(/&lt;/g, '<')
		.replace(/&gt;/g, '>')
		.replace(/&quot;/g, '"')
		.replace(/&#39;/g, "'");
	text = text.replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
	return text;
}

function deriveTitle(text: string, fallback: string): string {
	const firstNonEmpty = text
		.split(/\r?\n/)
		.find((l) => l.trim().length > 0 && !IMG_MARKER_RE.test(l.trim()));
	if (firstNonEmpty && firstNonEmpty.trim().length < 120) return firstNonEmpty.trim();
	return fallback.replace(/\.[a-z]+$/i, '');
}

type RawStep = { number: number; title: string; content: string; images: string[] };

function segmentSteps(text: string): RawStep[] {
	const lines = text.split(/\r?\n/);
	const steps: RawStep[] = [];
	let current: RawStep | null = null;
	let preStepImages: string[] = [];

	for (const raw of lines) {
		const line = raw.replace(/ /g, ' ').trimEnd();
		const trimmed = line.trim();

		const imgMatch = trimmed.match(IMG_MARKER_RE);
		if (imgMatch) {
			const url = imgMatch[1];
			if (!url) continue;
			if (current) current.images.push(url);
			else preStepImages.push(url);
			continue;
		}

		if (!trimmed) {
			if (current) current.content += '\n';
			continue;
		}

		const heading = matchStepHeading(line);
		if (heading) {
			if (current) steps.push(current);
			current = { number: heading.number, title: heading.title.trim(), content: '', images: [] };
			continue;
		}

		if (current) current.content += line + '\n';
	}
	if (current) steps.push(current);

	if (steps.length === 0) {
		steps.push({ number: 1, title: 'Step 1', content: text, images: preStepImages });
	} else if (preStepImages.length) {
		steps[0].images = [...preStepImages, ...steps[0].images];
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
		images: raw.images.length > 0 ? raw.images : undefined,
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
