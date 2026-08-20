import type { CountPrimesResult } from "./types.js";

/**
 * Pure and deterministic CPU-intensive prime counting workload.
 * Counts all prime numbers between 2 and limit (inclusive).
 */
export function countPrimes(limit: number): CountPrimesResult {
  if (limit < 2) {
    return { limit, primeCount: 0 };
  }

  let count = 1; // 2 is prime

  for (let i = 3; i <= limit; i += 2) {
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

  return { limit, primeCount: count };
}
