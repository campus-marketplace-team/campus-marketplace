// What GET /api/health reports about the worker running in this process:
// whether it's running and when a job or relay pass last finished. No counts
// or anything else about users' data.

export type WorkerStatus = { enabled: boolean; lastTickAt: string | null };

let enabled = false;
let lastTickAt: Date | null = null;

export function setWorkerEnabled(value: boolean) {
  enabled = value;
}

/** Called after every pg-boss job and outbox relay pass that finished without an error. */
export function recordWorkerTick(at = new Date()) {
  lastTickAt = at;
}

export function getWorkerStatus(): WorkerStatus {
  return { enabled, lastTickAt: lastTickAt?.toISOString() ?? null };
}

/** For tests. */
export function resetWorkerStatus() {
  enabled = false;
  lastTickAt = null;
}
