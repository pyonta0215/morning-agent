export interface RetryOptions {
  maxAttempts?: number;
  delayMs?: number;
  backoff?: 'fixed' | 'exponential';
}

export async function withRetry<T>(
  fn: () => Promise<T>,
  options?: RetryOptions
): Promise<T> {
  const maxAttempts = options?.maxAttempts ?? 3;
  const delayMs = options?.delayMs ?? 1000;
  const backoff = options?.backoff ?? 'exponential';

  let lastError: Error = new Error('Unknown error');

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastError = err instanceof Error ? err : new Error(String(err));

      if (attempt < maxAttempts) {
        const waitMs =
          backoff === 'exponential' ? delayMs * Math.pow(2, attempt - 1) : delayMs;
        console.warn(
          `[retry] attempt ${attempt}/${maxAttempts} failed: ${lastError.message}. Retrying in ${waitMs}ms...`
        );
        await new Promise((resolve) => setTimeout(resolve, waitMs));
      }
    }
  }

  throw lastError;
}
