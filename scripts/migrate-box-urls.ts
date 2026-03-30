import mongoose from 'mongoose';
import * as dotenv from 'dotenv';
import { fileURLToPath } from 'url';
import { dirname, resolve } from 'path';
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
dotenv.config({ path: resolve(__dirname, '..', '.env') });
const MONGODB_URI = process.env.MONGODB_URI;
if (!MONGODB_URI) { console.error('MONGODB_URI not found'); process.exit(1); }
const BOX_RE = /app\.box\.com\/files?\/(\d+)/;
function norm(url: string): string {
	if (!url || url.startsWith('/api/')) return url;
	const m = url.match(BOX_RE);
	return m ? `/api/box/files/${m[1]}/view` : url;
}
async function main() {
	await mongoose.connect(MONGODB_URI!);
	const col = mongoose.connection.db!.collection('receiving_lots');
	const cursor = col.find({ $or: [
		{ cocDocumentUrl: { $regex: 'app\.box\.com' } },
		{ photos: { $elemMatch: { $regex: 'app\.box\.com' } } },
		{ additionalDocuments: { $elemMatch: { $regex: 'app\.box\.com' } } },
		{ 'cocPhotos.fileUrl': { $regex: 'app\.box\.com' } }
	]});
	let n = 0;
	for await (const doc of cursor) {
		const u: Record<string, any> = {};
		if (doc.cocDocumentUrl && BOX_RE.test(doc.cocDocumentUrl)) u.cocDocumentUrl = norm(doc.cocDocumentUrl);
		if (doc.photos?.length) { const p = doc.photos.map(norm); if (JSON.stringify(p) !== JSON.stringify(doc.photos)) u.photos = p; }
		if (doc.additionalDocuments?.length) { const d = doc.additionalDocuments.map(norm); if (JSON.stringify(d) !== JSON.stringify(doc.additionalDocuments)) u.additionalDocuments = d; }
		if (Object.keys(u).length) { await col.updateOne({ _id: doc._id }, { $set: u }); console.log('Updated', doc._id); n++; }
	}
	console.log(`Done. Updated: ${n}`);
	await mongoose.disconnect();
}
main().catch(e => { console.error(e); process.exit(1); });
