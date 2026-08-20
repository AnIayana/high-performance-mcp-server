import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { Worker } from "node:worker_threads";
import { log } from "../core/logger.js";
import type {
  CountPrimesPayload,
  CountPrimesResult,
  WorkerRequest,
  WorkerResponse,
} from "./types.js";

export interface WorkerPoolStats {
  initialized: boolean;
  configuredWorkers: number;
  totalWorkers: number;
  busyWorkers: number;
  idleWorkers: number;
  queuedTasks: number;
  completedTasks: number;
  failedTasks: number;
  timedOutTasks: number;
  restartedWorkers: number;
}

export interface WorkerPoolOptions {
  workerCount?: number;
  workerScriptPath?: string;
  taskTimeoutMs?: number;
  maxQueueSize?: number;
}

interface QueuedTask {
  id: number;
  request: WorkerRequest;
  resolve: (res: CountPrimesResult) => void;
  reject: (err: Error) => void;
}

interface ManagedWorker {
  id: number;
  worker: Worker;
  currentTask?: QueuedTask;
  timeoutHandle?: NodeJS.Timeout;
}

const DEFAULT_MAX_QUEUE_SIZE = 50;
const DEFAULT_TASK_TIMEOUT_MS = 30_000;

export class WorkerPool {
  private isInitialized = false;
  private isClosing = false;
  private configuredWorkerCount: number;
  private customWorkerScriptPath?: string;
  private taskTimeoutMs: number;
  private maxQueueSize: number;

  private workerIdCounter = 0;
  private taskIdCounter = 0;

  private idleWorkers: ManagedWorker[] = [];
  private busyWorkers = new Map<number, ManagedWorker>();
  private taskQueue: QueuedTask[] = [];

  private completedTasksCount = 0;
  private failedTasksCount = 0;
  private timedOutTasksCount = 0;
  private restartedWorkersCount = 0;

  constructor(options?: WorkerPoolOptions) {
    this.configuredWorkerCount = options?.workerCount ?? this.determineWorkerCount();
    this.customWorkerScriptPath = options?.workerScriptPath;
    this.taskTimeoutMs = options?.taskTimeoutMs ?? DEFAULT_TASK_TIMEOUT_MS;
    this.maxQueueSize = options?.maxQueueSize ?? DEFAULT_MAX_QUEUE_SIZE;
  }

  private determineWorkerCount(): number {
    const rawEnv = process.env.MCP_WORKER_COUNT;
    if (rawEnv) {
      const parsed = Number.parseInt(rawEnv, 10);
      if (Number.isInteger(parsed) && parsed >= 1 && parsed <= 16) {
        return parsed;
      }
      log("warn", "invalid_worker_count_override", {
        provided: rawEnv,
        message: "MCP_WORKER_COUNT must be an integer between 1 and 16. Using default.",
      });
    }

    const available = typeof os.availableParallelism === "function" ? os.availableParallelism() : os.cpus().length;
    return Math.min(4, Math.max(1, available - 1));
  }

  private resolveWorkerScriptPath(): string {
    if (this.customWorkerScriptPath) {
      return this.customWorkerScriptPath;
    }

    const currentDir = path.dirname(fileURLToPath(import.meta.url));

    // When running from bundled dist/index.js -> dist/workers/compute.worker.js
    const candidate1 = path.join(currentDir, "workers", "compute.worker.js");
    if (fs.existsSync(candidate1)) return candidate1;

    // When running from dist/workers/...
    const candidate2 = path.join(currentDir, "compute.worker.js");
    if (fs.existsSync(candidate2)) return candidate2;

    // Relative to workspace
    const candidate3 = path.resolve(process.cwd(), "dist/workers/compute.worker.js");
    if (fs.existsSync(candidate3)) return candidate3;

    return candidate1;
  }

  public initialize(): void {
    if (this.isInitialized || this.isClosing) return;
    this.isInitialized = true;

    for (let i = 0; i < this.configuredWorkerCount; i++) {
      this.spawnWorker();
    }
  }

  private spawnWorker(): ManagedWorker | null {
    const currentTotal = this.idleWorkers.length + this.busyWorkers.size;
    if (currentTotal >= this.configuredWorkerCount) {
      log("warn", "worker_spawn_skipped_capacity", {
        currentTotal,
        configuredWorkerCount: this.configuredWorkerCount,
      });
      return null;
    }

    const workerId = ++this.workerIdCounter;
    const scriptPath = this.resolveWorkerScriptPath();

    const worker = new Worker(scriptPath, {
      name: `mcp-compute-worker-${workerId}`,
    });

    // Unref worker so idle pool does not block process exit on stdio close
    worker.unref();

    const managed: ManagedWorker = {
      id: workerId,
      worker,
    };

    worker.on("message", (response: WorkerResponse) => {
      this.handleWorkerMessage(managed, response);
    });

    worker.on("error", (error: Error) => {
      this.handleWorkerError(managed, error);
    });

    worker.on("exit", (code: number) => {
      this.handleWorkerExit(managed, code);
    });

    this.idleWorkers.push(managed);
    log("info", "worker_spawned", { workerId, totalWorkers: this.idleWorkers.length + this.busyWorkers.size });

    return managed;
  }

  private handleWorkerMessage(managed: ManagedWorker, response: WorkerResponse): void {
    if (managed.timeoutHandle) {
      clearTimeout(managed.timeoutHandle);
      managed.timeoutHandle = undefined;
    }

    const currentTask = managed.currentTask;
    if (!currentTask) {
      // Received response without active task
      return;
    }

    // Response ID validation
    if (response.id !== currentTask.id) {
      log("error", "worker_response_id_mismatch", {
        workerId: managed.id,
        expectedTaskId: currentTask.id,
        receivedTaskId: response.id,
      });

      this.failedTasksCount++;
      currentTask.reject(
        new Error(`Worker response ID mismatch: expected task ${currentTask.id}, received ${response.id}`)
      );
      managed.currentTask = undefined;
      this.busyWorkers.delete(managed.id);

      // Terminate unreliable worker; exit event will handle replacement cleanly
      managed.worker.terminate().catch((err) => {
        log("warn", "worker_terminate_error", { workerId: managed.id, error: String(err) });
      });
      return;
    }

    managed.currentTask = undefined;
    this.busyWorkers.delete(managed.id);

    if (response.ok) {
      this.completedTasksCount++;
      currentTask.resolve(response.result);
    } else {
      this.failedTasksCount++;
      const error = new Error(response.error.message);
      error.name = response.error.name;
      if (response.error.stack) error.stack = response.error.stack;
      currentTask.reject(error);
    }

    if (!this.isClosing) {
      this.idleWorkers.push(managed);
      this.dispatchNext();
    }
  }

  private handleWorkerError(managed: ManagedWorker, error: Error): void {
    log("error", "worker_error", { workerId: managed.id, error: error.message });

    if (managed.timeoutHandle) {
      clearTimeout(managed.timeoutHandle);
      managed.timeoutHandle = undefined;
    }

    // Remove from active collections idempotently
    this.busyWorkers.delete(managed.id);
    const idleIndex = this.idleWorkers.indexOf(managed);
    if (idleIndex !== -1) {
      this.idleWorkers.splice(idleIndex, 1);
    }

    // Reject active task once (exit event won't double-fail it because currentTask is cleared)
    if (managed.currentTask) {
      this.failedTasksCount++;
      managed.currentTask.reject(new Error(`Worker ${managed.id} encountered an unhandled error: ${error.message}`));
      managed.currentTask = undefined;
    }

    // NOTE: DO NOT call replaceWorker() here.
    // Unhandled worker error leads to worker termination, which emits the 'exit' event.
    // The 'exit' event is the single canonical replacement point.
  }

  private handleTaskTimeout(managed: ManagedWorker): void {
    this.timedOutTasksCount++;
    this.failedTasksCount++;

    log("error", "worker_task_timeout", {
      workerId: managed.id,
      timeoutMs: this.taskTimeoutMs,
    });

    if (managed.currentTask) {
      managed.currentTask.reject(new Error(`Task timed out after ${this.taskTimeoutMs}ms`));
      managed.currentTask = undefined;
    }

    this.busyWorkers.delete(managed.id);

    // Safely terminate worker; replacement will be handled by the 'exit' event
    managed.worker.terminate().catch((err) => {
      log("warn", "worker_terminate_error", { workerId: managed.id, error: String(err) });
    });

    // NOTE: DO NOT call replaceWorker() here to prevent double-replacement on exit.
  }

  private handleWorkerExit(managed: ManagedWorker, code: number): void {
    if (managed.timeoutHandle) {
      clearTimeout(managed.timeoutHandle);
      managed.timeoutHandle = undefined;
    }

    // Idempotent removal from collections
    this.busyWorkers.delete(managed.id);
    const idleIndex = this.idleWorkers.indexOf(managed);
    if (idleIndex !== -1) {
      this.idleWorkers.splice(idleIndex, 1);
    }

    // If worker exited unexpectedly without prior error/timeout handler, fail task once
    if (managed.currentTask) {
      this.failedTasksCount++;
      managed.currentTask.reject(new Error(`Worker ${managed.id} exited unexpectedly with code ${code}`));
      managed.currentTask = undefined;
    }

    log("warn", "worker_exited", { workerId: managed.id, code });

    // CANONICAL SINGLE POINT OF REPLACEMENT
    if (!this.isClosing) {
      this.restartedWorkersCount++;
      log("info", "worker_replaced", { oldWorkerId: managed.id });
      this.spawnWorker();
      this.dispatchNext();
    }
  }

  private dispatchNext(): void {
    if (this.isClosing || this.idleWorkers.length === 0 || this.taskQueue.length === 0) {
      return;
    }

    const managed = this.idleWorkers.pop();
    const task = this.taskQueue.shift();

    if (!managed || !task) return;

    managed.currentTask = task;
    this.busyWorkers.set(managed.id, managed);

    managed.timeoutHandle = setTimeout(() => {
      this.handleTaskTimeout(managed);
    }, this.taskTimeoutMs);

    managed.worker.postMessage(task.request);
  }

  public async execute(type: "count_primes", payload: CountPrimesPayload): Promise<CountPrimesResult> {
    if (this.isClosing) {
      throw new Error("Worker pool is shutting down and cannot accept new tasks.");
    }

    if (!this.isInitialized) {
      this.initialize();
    }

    if (this.taskQueue.length >= this.maxQueueSize) {
      throw new Error(`Worker pool task queue is full (max ${this.maxQueueSize} tasks queued).`);
    }

    const taskId = ++this.taskIdCounter;
    const request: WorkerRequest = {
      id: taskId,
      type,
      payload,
    };

    return new Promise<CountPrimesResult>((resolve, reject) => {
      this.taskQueue.push({
        id: taskId,
        request,
        resolve,
        reject,
      });
      this.dispatchNext();
    });
  }

  public getStats(): WorkerPoolStats {
    return {
      initialized: this.isInitialized,
      configuredWorkers: this.configuredWorkerCount,
      totalWorkers: this.idleWorkers.length + this.busyWorkers.size,
      busyWorkers: this.busyWorkers.size,
      idleWorkers: this.idleWorkers.length,
      queuedTasks: this.taskQueue.length,
      completedTasks: this.completedTasksCount,
      failedTasks: this.failedTasksCount,
      timedOutTasks: this.timedOutTasksCount,
      restartedWorkers: this.restartedWorkersCount,
    };
  }

  public async close(): Promise<void> {
    if (this.isClosing) return;
    this.isClosing = true;

    // Reject queued tasks
    while (this.taskQueue.length > 0) {
      const task = this.taskQueue.shift();
      task?.reject(new Error("Worker pool is closing."));
    }

    // Terminate all workers
    const allWorkers = [...this.idleWorkers, ...Array.from(this.busyWorkers.values())];
    const terminationPromises = allWorkers.map(async (mw) => {
      if (mw.timeoutHandle) clearTimeout(mw.timeoutHandle);
      if (mw.currentTask) {
        mw.currentTask.reject(new Error("Worker pool terminated."));
      }
      try {
        await mw.worker.terminate();
      } catch {
        // ignore termination errors on closing
      }
    });

    await Promise.all(terminationPromises);
    this.idleWorkers = [];
    this.busyWorkers.clear();
  }
}

// Module-scope singleton worker pool
const poolInstance = new WorkerPool();

export function executeWorkerTask(type: "count_primes", payload: CountPrimesPayload): Promise<CountPrimesResult> {
  return poolInstance.execute(type, payload);
}

export function getWorkerPoolStats(): WorkerPoolStats {
  return poolInstance.getStats();
}

export async function closeWorkerPool(): Promise<void> {
  await poolInstance.close();
}
