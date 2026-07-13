import mongoose from 'mongoose';
import { env } from '$env/dynamic/private';

type MongooseCache = {
	conn: typeof mongoose | null;
	promise: Promise<typeof mongoose> | null;
};

const globalWithMongoose = globalThis as typeof globalThis & { __mongoose?: MongooseCache };

const cached: MongooseCache = globalWithMongoose.__mongoose ?? { conn: null, promise: null };
globalWithMongoose.__mongoose = cached;

export async function connectDB() {
	if (cached.conn) return;
	if (mongoose.connection.readyState >= 1) {
		cached.conn = mongoose;
		return;
	}
	if (!env.MONGODB_URI) {
		throw new Error('MONGODB_URI is not set');
	}
	if (!cached.promise) {
		cached.promise = mongoose
			.connect(env.MONGODB_URI, {
				serverSelectionTimeoutMS: 5000,
				connectTimeoutMS: 5000,
				socketTimeoutMS: 10000,
				maxPoolSize: 10,
				minPoolSize: 0
			})
			.then((m) => {
				console.log('MongoDB connected');
				return m;
			});
	}
	try {
		cached.conn = await cached.promise;
	} catch (err) {
		cached.promise = null;
		throw err;
	}
}

export { mongoose };
