import "server-only";
import { createGateway } from "../../../lib/gateway";

export const runtime = "nodejs";
export const maxDuration = 180;
const handler = (request: Request) => createGateway({
  apiKey: process.env.TOKPORT_API_KEY,
  password: process.env.STARTER_PASSWORD,
  baseUrl: process.env.TOKPORT_BASE_URL,
  imageModel: process.env.TOKPORT_IMAGE_MODEL,
  videoModel: process.env.TOKPORT_VIDEO_MODEL,
})(request);
export const POST = handler;
export const GET = handler;
