import { parentPort } from "node:worker_threads";

if (!parentPort) throw new Error("Must be run as worker");

parentPort.on("message", (msg) => {
  // Deliberately reply with mismatched ID
  parentPort?.postMessage({
    id: (msg.id ?? 1) + 9999,
    ok: true,
    result: { limit: 10, primeCount: 4 },
  });
});
