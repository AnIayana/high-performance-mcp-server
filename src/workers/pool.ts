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

export interface ExecuteWorkerOptions {
  signal?: AbortSignal;
}

interface QueuedTask {
  id: number;
  request: WorkerRequest;
  signal?: AbortSignal;
  abortListener?: () => void;
  isSettled: boolean;
  resolve: (res: CountPrimesResult) => void;
  reject: (err: Error) => void;
}

interface ManagedWorker {
  id: number;
  worker: Worker;
  currentTask?: QueuedTask;
  timeoutHandle?: NodeJS.Timeout;
  isTerminatedForCancellation?: boolean;
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
  private terminatingWorkers = new Set<ManagedWorker>();
  private terminationPromises = new Map<number, Promise<number>>();
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

    const candidates = [
      // When running from src/workers/pool.ts (development / tests under tsx)
      path.join(currentDir, "compute.worker.ts"),
      // When running from dist/workers/compute.worker.js
      path.join(currentDir, "compute.worker.js"),
      // When running from src/index.ts (development under tsx)
      path.join(currentDir, "workers", "compute.worker.ts"),
      // When running from dist/index.js (production bundle)
      path.join(currentDir, "workers", "compute.worker.js"),
      // Relative to workspace root
      path.resolve(process.cwd(), "dist/workers/compute.worker.js"),
      path.resolve(process.cwd(), "src/workers/compute.worker.ts"),
    ];

    for (const candidate of candidates) {
      if (fs.existsSync(candidate)) return candidate;
    }

    return candidates[0];
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

  private handleTaskAbort(task: QueuedTask): void {
    if (task.isSettled) return;
    task.isSettled = true;

    if (task.signal && task.abortListener) {
      task.signal.removeEventListener("abort", task.abortListener);
      task.abortListener = undefined;
    }

    // 1. Check if task is still in queue
    const queueIndex = this.taskQueue.indexOf(task);
    if (queueIndex !== -1) {
      this.taskQueue.splice(queueIndex, 1);
      log("info", "worker_queued_task_aborted", { taskId: task.id });
      task.reject(new DOMException("Worker task was aborted", "AbortError"));
      return;
    }

    // 2. Check if task is actively running on a busy worker
    for (const [workerId, managed] of this.busyWorkers.entries()) {
      if (managed.currentTask === task) {
        log("info", "worker_running_task_aborted", { taskId: task.id, workerId });

        if (managed.timeoutHandle) {
          clearTimeout(managed.timeoutHandle);
          managed.timeoutHandle = undefined;
        }

        managed.currentTask = undefined;
        this.busyWorkers.delete(workerId);
        managed.isTerminatedForCancellation = true;
        this.terminatingWorkers.add(managed);

        task.reject(new DOMException("Worker task was aborted", "AbortError"));

        // Terminate worker to stop CPU-bound compute loop immediately
        const termPromise = managed.worker.terminate().catch((err) => {
          log("warn", "worker_terminate_error", { workerId, error: String(err) });
          return 1;
        });
        this.terminationPromises.set(managed.id, termPromise);

        return;
      }
    }

    // If not found in queue or busy workers, reject anyway for safety
    task.reject(new DOMException("Worker task was aborted", "AbortError"));
  }

  private handleWorkerMessage(managed: ManagedWorker, response: WorkerResponse): void {
    if (managed.timeoutHandle) {
      clearTimeout(managed.timeoutHandle);
      managed.timeoutHandle = undefined;
    }

    const currentTask = managed.currentTask;
    if (!currentTask) {
      // Received response without active task (e.g. from cancelled worker before termination completed)
      return;
    }

    // Clean up abort listener
    if (currentTask.signal && currentTask.abortListener) {
      currentTask.signal.removeEventListener("abort", currentTask.abortListener);
      currentTask.abortListener = undefined;
    }

    // Response ID validation
    if (response.id !== currentTask.id) {
      log("error", "worker_response_id_mismatch", {
        workerId: managed.id,
        expectedTaskId: currentTask.id,
        receivedTaskId: response.id,
      });

      this.failedTasksCount++;
      if (!currentTask.isSettled) {
        currentTask.isSettled = true;
        currentTask.reject(
          new Error(`Worker response ID mismatch: expected task ${currentTask.id}, received ${response.id}`)
        );
      }
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

    if (!currentTask.isSettled) {
      currentTask.isSettled = true;
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

    const currentTask = managed.currentTask;
    if (currentTask) {
      if (currentTask.signal && currentTask.abortListener) {
        currentTask.signal.removeEventListener("abort", currentTask.abortListener);
        currentTask.abortListener = undefined;
      }
      if (!currentTask.isSettled) {
        currentTask.isSettled = true;
        this.failedTasksCount++;
        currentTask.reject(new Error(`Worker ${managed.id} encountered an unhandled error: ${error.message}`));
      }
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

    const currentTask = managed.currentTask;
    if (currentTask) {
      if (currentTask.signal && currentTask.abortListener) {
        currentTask.signal.removeEventListener("abort", currentTask.abortListener);
        currentTask.abortListener = undefined;
      }
      if (!currentTask.isSettled) {
        currentTask.isSettled = true;
        currentTask.reject(new Error(`Task timed out after ${this.taskTimeoutMs}ms`));
      }
      managed.currentTask = undefined;
    }

    this.busyWorkers.delete(managed.id);
    this.terminatingWorkers.add(managed);

    // Safely terminate worker; replacement will be handled by the 'exit' event
    const termPromise = managed.worker.terminate().catch((err) => {
      log("warn", "worker_terminate_error", { workerId: managed.id, error: String(err) });
      return 1;
    });
    this.terminationPromises.set(managed.id, termPromise);

    // NOTE: DO NOT call replaceWorker() here to prevent double-replacement on exit.
  }

  private handleWorkerExit(managed: ManagedWorker, code: number): void {
    if (managed.timeoutHandle) {
      clearTimeout(managed.timeoutHandle);
      managed.timeoutHandle = undefined;
    }

    // Idempotent removal from collections
    this.busyWorkers.delete(managed.id);
    this.terminatingWorkers.delete(managed);
    this.terminationPromises.delete(managed.id);
    const idleIndex = this.idleWorkers.indexOf(managed);
    if (idleIndex !== -1) {
      this.idleWorkers.splice(idleIndex, 1);
    }

    const currentTask = managed.currentTask;
    if (currentTask) {
      if (currentTask.signal && currentTask.abortListener) {
        currentTask.signal.removeEventListener("abort", currentTask.abortListener);
        currentTask.abortListener = undefined;
      }
      if (!currentTask.isSettled) {
        currentTask.isSettled = true;
        this.failedTasksCount++;
        currentTask.reject(new Error(`Worker ${managed.id} exited unexpectedly with code ${code}`));
      }
      managed.currentTask = undefined;
    }

    log("warn", "worker_exited", {
      workerId: managed.id,
      code,
      isCancellation: Boolean(managed.isTerminatedForCancellation),
    });

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

    // Check if task was aborted just before dispatch
    if (task.signal?.aborted) {
      this.idleWorkers.push(managed);
      this.handleTaskAbort(task);
      this.dispatchNext();
      return;
    }

    managed.currentTask = task;
    this.busyWorkers.set(managed.id, managed);

    managed.timeoutHandle = setTimeout(() => {
      this.handleTaskTimeout(managed);
    }, this.taskTimeoutMs);

    managed.worker.postMessage(task.request);
  }

  public async execute(
    type: "count_primes",
    payload: CountPrimesPayload,
    options?: ExecuteWorkerOptions
  ): Promise<CountPrimesResult> {
    if (this.isClosing) {
      throw new Error("Worker pool is shutting down and cannot accept new tasks.");
    }

    if (options?.signal?.aborted) {
      throw new DOMException("Worker task was aborted", "AbortError");
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
      const task: QueuedTask = {
        id: taskId,
        request,
        signal: options?.signal,
        isSettled: false,
        resolve,
        reject,
      };

      if (options?.signal) {
        task.abortListener = () => {
          this.handleTaskAbort(task);
        };
        options.signal.addEventListener("abort", task.abortListener, { once: true });
      }

      this.taskQueue.push(task);
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
      if (task) {
        if (task.signal && task.abortListener) {
          task.signal.removeEventListener("abort", task.abortListener);
          task.abortListener = undefined;
        }
        if (!task.isSettled) {
          task.isSettled = true;
          task.reject(new Error("Worker pool is closing."));
        }
      }
    }

    // Terminate all active workers and await all terminations
    const activeWorkers = [...this.idleWorkers, ...Array.from(this.busyWorkers.values())];
    const terminationPromises = activeWorkers.map(async (mw) => {
      if (mw.timeoutHandle) clearTimeout(mw.timeoutHandle);
      const currentTask = mw.currentTask;
      if (currentTask) {
        if (currentTask.signal && currentTask.abortListener) {
          currentTask.signal.removeEventListener("abort", currentTask.abortListener);
          currentTask.abortListener = undefined;
        }
        if (!currentTask.isSettled) {
          currentTask.isSettled = true;
          currentTask.reject(new Error("Worker pool terminated."));
        }
        mw.currentTask = undefined;
      }
      try {
        await mw.worker.terminate();
      } catch {
        // ignore termination errors on closing
      }
    });

    const pendingTerminatingPromises = Array.from(this.terminationPromises.values());
    await Promise.all([...terminationPromises, ...pendingTerminatingPromises]);
    this.idleWorkers = [];
    this.busyWorkers.clear();
    this.terminatingWorkers.clear();
    this.terminationPromises.clear();
  }
}

// Module-scope singleton worker pool
let poolInstance = new WorkerPool();

function getActivePool(): WorkerPool {
  if ((poolInstance as any).isClosing) {
    poolInstance = new WorkerPool();
  }
  return poolInstance;
}

export function executeWorkerTask(
  type: "count_primes",
  payload: CountPrimesPayload,
  options?: ExecuteWorkerOptions
): Promise<CountPrimesResult> {
  return getActivePool().execute(type, payload, options);
}

export function getWorkerPoolStats(): WorkerPoolStats {
  return getActivePool().getStats();
}

export async function closeWorkerPool(): Promise<void> {
  await poolInstance.close();
}
