import mongoose from 'mongoose';
import { MONGODB_URI } from '$env/static/private';

let connected = false;

export async function connectDB() {
	if (connected) return;
	if (mongoose.connection.readyState >= 1) {
		connected = true;
		return;
	}
	await mongoose.connect(MONGODB_URI);
	connected = true;
	console.log('MongoDB connected');
}

export { mongoose };
