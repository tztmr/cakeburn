export type JSONFetchOptions = RequestInit & { timeoutMs?: number; request?: typeof fetch };

// The deadline covers headers AND body decoding, even if an upstream ignores abort.
export async function fetchJSON<T = unknown>(url: string, options: JSONFetchOptions = {}): Promise<T> {
  const host = url.startsWith("/") ? "本站数据服务" : new URL(url).hostname;
  const { timeoutMs = 8_000, request = fetch, signal: external, ...init } = options;
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let rejectDeadline: ((error: Error) => void) | undefined;
  const abort = () => {
    controller.abort();
    rejectDeadline?.(new Error("请求已取消"));
  };
  if (external?.aborted) throw new Error("请求已取消");
  external?.addEventListener("abort", abort, { once: true });
  try {
    const deadline = new Promise<never>((_, reject) => {
      rejectDeadline = reject;
      timer = setTimeout(() => {
        controller.abort();
        reject(new Error(`公开数据接口超时：${host}`));
      }, timeoutMs);
    });
    const operation = (async () => {
      const response = await request(url, { ...init, signal: controller.signal });
      if (!response.ok) throw new Error(`公开数据接口返回 ${response.status}：${host}`);
      return await response.json() as T;
    })();
    return await Promise.race([operation, deadline]);
  } finally {
    clearTimeout(timer);
    external?.removeEventListener("abort", abort);
    controller.abort();
  }
}

export async function bounded<T>(operation: Promise<T>, timeoutMs: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([operation, new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error("数据读取超时")), timeoutMs);
    })]);
  } finally { clearTimeout(timer); }
}
