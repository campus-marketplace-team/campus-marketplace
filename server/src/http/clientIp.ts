import { isIP } from "node:net";
import type { Request } from "express";

/**
 * The client's IP, for rate limits and scan logs. Render's edge sets True-Client-IP,
 * which doesn't depend on counting proxy hops. A value that isn't one valid IP is
 * ignored. Only trust this behind that edge: anywhere else a client can send the
 * header itself, so never use it to grant anything.
 */
export function getClientIp(req: Pick<Request, "ip" | "headers">): string | undefined {
  const header = req.headers["true-client-ip"];
  const value = typeof header === "string" ? header.trim() : "";
  return isIP(value) ? value : req.ip;
}
