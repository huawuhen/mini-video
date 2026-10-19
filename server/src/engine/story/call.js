// Shared LLM call-loop helpers for story/ modules: usage accounting, deadline merging,
// caller cancellation and repair-review messages. Injected llm keeps tests provider-free.
export const MAX_REPAIR_ATTEMPTS = 2;
export const DEFAULT_TIMEOUT_MS = 90_000;
export const MAX_REVIEW_CHARS = 2000;

export function usageOf(result) {
  return { inputTokens: Number.isSafeInteger(result?.usage?.inputTokens) ? result.usage.inputTokens : 0,
    outputTokens: Number.isSafeInteger(result?.usage?.outputTokens) ? result.usage.outputTokens : 0 };
}

export function addUsage(total, result) {
  const usage = usageOf(result);
  total.inputTokens += usage.inputTokens;
  total.outputTokens += usage.outputTokens;
}

/** Merge caller cancellation with a per-call timeout; the abort reason becomes the failure. */
export function deadlineSignal({ signal, timeoutMs }) {
  const controller = new AbortController();
  const onAbort = () => controller.abort(signal.reason ?? new Error('LLM 调用已取消'));
  if (signal?.aborted) onAbort(); // addEventListener never fires for an already-aborted signal
  else signal?.addEventListener('abort', onAbort, { once: true });
  const timer = setTimeout(() => controller.abort(new Error(`LLM 调用超过 ${timeoutMs} 毫秒限制`)), timeoutMs);
  return {
    signal: controller.signal,
    dispose() { clearTimeout(timer); signal?.removeEventListener('abort', onAbort); },
  };
}

/**
 * Caller cancellation: the caller's signal aborted, whatever the reason text is.
 * Timeouts and provider failures (deadline fired without the caller aborting) go
 * through repair/fallback instead; never classify by error message strings.
 */
export function throwIfCallerCancelled(signal) {
  if (!signal?.aborted) return;
  throw signal.reason instanceof Error ? signal.reason
    : Object.assign(new Error(String(signal.reason ?? 'LLM 调用已取消')), { name: 'AbortError' });
}

/** Feed the failed output back to the model (truncated) together with the validation error. */
export function reviewMessages(messages, lastText, error) {
  const review = [
    { role: 'user', content: `上一版校验失败：${String(error.message).slice(0, 160)}。请重新输出符合约束的 JSON，禁止解释。` },
  ];
  if (lastText) review.unshift({ role: 'assistant', content: String(lastText).slice(0, MAX_REVIEW_CHARS) });
  return [...messages, ...review];
}
