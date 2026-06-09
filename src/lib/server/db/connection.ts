import mongoose from 'mongoose';

// Use process.env directly so this module can be imported from non-SvelteKit
// contexts (test scripts, CLI tools). In SvelteKit production runtime,
// process.env is populated identically to $env/dynamic/private — both are
// thin wrappers over Node's process.env on Vercel.

// Cache the connection PROMISE, not a boolean. On a cold serverless start a
// single page refresh fires several requests in parallel (layout load + page
// load + any API calls); caching the in-flight promise makes them all await the
// SAME mongoose.connect() instead of each racing their own. The cache survives
// module reuse across warm invocations.
let connPromise: Promise<typeof mongoose> | null = null;

const CONNECT_OPTS: mongoose.ConnectOptions = {
	// Atlas SRV DNS lookup + cold TLS handshake can exceed 5s on a cold start;
	// 5s produced intermittent "Server selection timed out" 500s.
	serverSelectionTimeoutMS: 15000,
	connectTimeoutMS: 15000,
	// Was 10000 — far too aggressive. A socket idle >10s between serverless
	// invocations got killed mid-use, surfacing as "connection closed" 500s.
	socketTimeoutMS: 45000,
	maxPoolSize: 10,
	// Serverless: don't pin idle sockets open (Atlas reaps them, leaving a stale
	// pool entry). Recycle anything idle past a minute.
	minPoolSize: 0,
	maxIdleTimeMS: 60000
};

// Register once at module load (not per-connect) to avoid a listener leak.
// If the connection drops or errors, clear the cached promise so the next
// connectDB() reconnects instead of reusing a dead handle / awaiting a settled
// promise forever.
mongoose.connection.on('disconnected', () => {
	connPromise = null;
});
mongoose.connection.on('error', () => {
	connPromise = null;
});

export async function connectDB(): Promise<typeof mongoose> {
	// 1 = connected → reuse immediately, no await.
	if (mongoose.connection.readyState === 1) return mongoose;

	// A connect is already in flight (this request or a concurrent one) →
	// await the same promise rather than starting another.
	if (connPromise) return connPromise;

	const uri = process.env.MONGODB_URI;
	if (!uri) {
		throw new Error('MONGODB_URI is not set');
	}

	connPromise = mongoose
		.connect(uri, CONNECT_OPTS)
		.then((m) => {
			console.log('MongoDB connected');
			return m;
		})
		.catch((err) => {
			// Reset so the NEXT request retries from scratch instead of every
			// future caller awaiting this one rejected promise.
			connPromise = null;
			throw err;
		});

	return connPromise;
}

export { mongoose };
