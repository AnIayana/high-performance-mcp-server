import { parentPort } from "node:worker_threads";
import { countPrimes } from "./compute.js";
import type { WorkerRequest, WorkerResponse } from "./types.js";

if (!parentPort) {
  throw new Error("compute.worker.ts must be spawned as a Worker Thread");
}

parentPort.on("message", (request: WorkerRequest) => {
  if (!parentPort) return;

  const { id, type, payload } = request;

  try {
    if (type === "count_primes") {
      const result = countPrimes(payload.limit);
      const response: WorkerResponse = {
        id,
        ok: true,
        result,
      };
      parentPort.postMessage(response);
    } else {
      const response: WorkerResponse = {
        id,
        ok: false,
        error: {
          name: "UnknownTaskError",
          message: `Unknown worker task type: ${String(type)}`,
        },
      };
      parentPort.postMessage(response);
    }
  } catch (err) {
    const errorObj = err instanceof Error ? err : new Error(String(err));
    const response: WorkerResponse = {
      id,
      ok: false,
      error: {
        name: errorObj.name,
        message: errorObj.message,
        stack: errorObj.stack,
      },
    };
    parentPort.postMessage(response);
  }
});
