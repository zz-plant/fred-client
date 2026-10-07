/** Anything callable like `fetch` for a string or URL target. Bun's `typeof fetch` also carries `preconnect`, which a stub has no reason to implement. */
export type FetchLike = (input: string | URL, init?: RequestInit) => Promise<Response>;

/** `fetch` with an abort after `timeoutMs`, composed with any signal the caller already passed. */
export const fetchWithTimeout = async (
  fetcher: FetchLike,
  input: string | URL,
  init: RequestInit | undefined,
  timeoutMs: number,
): Promise<Response> => {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(new DOMException(`Timed out after ${timeoutMs}ms`, "TimeoutError")), timeoutMs);

  const upstreamSignal = init?.signal;
  if (upstreamSignal) {
    if (upstreamSignal.aborted) {
      controller.abort(upstreamSignal.reason);
    } else {
      upstreamSignal.addEventListener("abort", () => controller.abort(upstreamSignal.reason), { once: true });
    }
  }

  try {
    return await fetcher(input, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timeout);
  }
};
