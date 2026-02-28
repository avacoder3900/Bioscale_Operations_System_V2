import { json, error } from "@sveltejs/kit";
import { env } from "$env/dynamic/private";
import { connectDB } from "$lib/server/db";
import type { RequestHandler } from "./$types";

function requireApiKey(request: Request) {
  const key = request.headers.get("x-api-key") || request.headers.get("x-agent-api-key") || request.headers.get("authorization")?.replace("Bearer ", "");
  if (!env.AGENT_API_KEY || key !== env.AGENT_API_KEY) {
    throw error(401, "Invalid or missing API key");
  }
}

export const GET: RequestHandler = async () => {
  await connectDB();
  return json({ success: true, data: { status: "healthy", timestamp: new Date().toISOString(), version: "2.0.0" } });
};
