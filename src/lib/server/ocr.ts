/**
 * OCR / text-extraction utilities for COC photo processing.
 *
 * Extracts lot numbers (format: L-YYYY-MM-DD-XX) from images.
 * Uses the configured OCR_API_URL (e.g. a Tesseract microservice or
 * Azure/Google Vision endpoint). Falls back to a regex-only approach
 * if the OCR service already returns raw text.
 */
import { env } from '$env/dynamic/private';

/** The lot-number pattern we look for on COC photos */
const LOT_NUMBER_REGEX = /L-\d{4}-\d{2}-\d{2}-\d{2,}/g;

export interface OcrResult {
	rawText: string;
	lotNumbers: string[];
}

/**
 * Send an image buffer to the OCR service and return extracted text.
 * Env vars:
 *   OCR_API_URL  — base URL of the OCR service  (e.g. http://localhost:9000)
 *   OCR_API_KEY  — optional API key header
 *
 * The service is expected to accept a multipart POST at /ocr with a `file`
 * field and return JSON: { text: string }.
 *
 * If no OCR service is configured, the function returns empty text and the
 * caller can fall back to manual lot-number entry.
 */
export async function extractText(
	fileBuffer: ArrayBuffer,
	fileName: string
): Promise<OcrResult> {
	const ocrUrl = env.OCR_API_URL;
	if (!ocrUrl) {
		console.warn('[ocr] OCR_API_URL not set — returning empty result');
		return { rawText: '', lotNumbers: [] };
	}

	const formData = new FormData();
	formData.append('file', new Blob([fileBuffer]), fileName);

	const headers: Record<string, string> = {};
	if (env.OCR_API_KEY) {
		headers['X-API-Key'] = env.OCR_API_KEY;
	}

	const res = await fetch(`${ocrUrl}/ocr`, {
		method: 'POST',
		headers,
		body: formData
	});

	if (!res.ok) {
		const body = await res.text().catch(() => '');
		throw new Error(`OCR service error ${res.status}: ${body}`);
	}

	const data = (await res.json()) as { text: string };
	const rawText = data.text ?? '';
	const lotNumbers = parseLotNumbers(rawText);

	return { rawText, lotNumbers };
}

/** Pull all lot numbers matching L-YYYY-MM-DD-XX from arbitrary text. */
export function parseLotNumbers(text: string): string[] {
	const matches = text.match(LOT_NUMBER_REGEX);
	if (!matches) return [];
	// De-duplicate while preserving order
	return [...new Set(matches)];
}
