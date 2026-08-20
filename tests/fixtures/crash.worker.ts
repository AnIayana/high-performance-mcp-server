import { parentPort } from "node:worker_threads";

if (!parentPort) throw new Error("Must be run as worker");

parentPort.on("message", (msg) => {
  // Simulate unexpected uncaught error / crash
  throw new Error("Simulated worker uncaught exception");
});
