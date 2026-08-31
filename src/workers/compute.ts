import type { CountPrimesResult } from "./types.js";

const PROGRESS_CHUNK_SIZE = 50_000;
const PROGRESS_MIN_INTERVAL_MS = 80;

/**
 * Pure and deterministic CPU-intensive prime counting workload.
 * Counts all prime numbers between 2 and limit (inclusive).
 * Optionally invokes onProgress with processed candidate count and total limit.
 */
export function countPrimes(
  limit: number,
  onProgress?: (progress: number, total: number) => void
): CountPrimesResult {
  if (limit < 2) {
    if (onProgress) {
      onProgress(Math.max(0, limit), Math.max(0, limit));
    }
    return { limit, primeCount: 0 };
  }

  let count = 1; // 2 is prime
  let lastReportTime = Date.now();
  let lastReportedProgress = 0;

  for (let i = 3; i <= limit; i += 2) {
    if (onProgress && i % PROGRESS_CHUNK_SIZE === 1) {
      const now = Date.now();
      if (now - lastReportTime >= PROGRESS_MIN_INTERVAL_MS) {
        lastReportTime = now;
        lastReportedProgress = i;
        onProgress(i, limit);
      }
    }

    let isPrime = true;
    const sqrt = Math.floor(Math.sqrt(i));
    for (let d = 3; d <= sqrt; d += 2) {
      if (i % d === 0) {
        isPrime = false;
        break;
      }
    }
    if (isPrime) {
      count++;
    }
  }

  // Ensure final progress (limit, limit) is reported before returning
  if (onProgress && lastReportedProgress !== limit) {
    onProgress(limit, limit);
  }

  return { limit, primeCount: count };
}
