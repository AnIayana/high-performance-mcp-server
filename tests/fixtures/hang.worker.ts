import { parentPort } from "node:worker_threads";

if (!parentPort) throw new Error("Must be run as worker");

parentPort.on("message", () => {
  // Deliberately do not reply to trigger timeout
});
