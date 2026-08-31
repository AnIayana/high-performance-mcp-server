/**
 * Message protocol between the Main thread and Worker threads.
 */

export interface CountPrimesPayload {
  limit: number;
  enableProgress?: boolean;
}

export interface CountPrimesResult {
  limit: number;
  primeCount: number;
}

export interface WorkerRequest {
  id: number;
  type: "count_primes";
  payload: CountPrimesPayload;
}

export interface WorkerProgressMessage {
  id: number;
  type: "progress";
  progress: number;
  total: number;
}

export interface WorkerSuccessResponse {
  id: number;
  ok: true;
  result: CountPrimesResult;
}

export interface WorkerErrorResponse {
  id: number;
  ok: false;
  error: {
    name: string;
    message: string;
    stack?: string;
  };
}

export type WorkerResponse = WorkerSuccessResponse | WorkerErrorResponse;
export type WorkerMessage = WorkerResponse | WorkerProgressMessage;
