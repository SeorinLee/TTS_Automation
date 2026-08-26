// Client-safe response reading (spec §7). Browser components use this instead of
// `res.json()` directly, so an empty body, an HTML error page, or a non-JSON string never
// surfaces "Unexpected end of JSON input" (or raw HTML) to the user.

export interface ApiError {
  detail: string;
  code?: string;
}

/**
 * Read a fetch Response as JSON without ever throwing a low-level parse error at the user.
 *
 * - Empty body -> friendly message.
 * - HTML (error/proxy page) -> generic message, never the raw HTML.
 * - Non-JSON text -> generic message with the status.
 * - Valid JSON error ({detail, code}) -> preserved so the caller can show it.
 */
export async function readJsonSafely<T>(response: Response): Promise<T> {
  const text = await response.text();

  if (!text.trim()) {
    if (!response.ok) {
      throw asError({
        detail: "Worker 서버에 연결할 수 없습니다. Worker 실행 상태를 확인하세요.",
        code: "WORKER_UNAVAILABLE",
      });
    }
    throw asError({ detail: "서버 응답이 비어 있습니다.", code: "EMPTY_RESPONSE" });
  }

  const trimmed = text.trimStart();
  const looksJson = trimmed.startsWith("{") || trimmed.startsWith("[");
  if (!looksJson) {
    // HTML page or plain text — do not echo the technical body to the UI.
    throw asError({
      detail: `서버에서 올바르지 않은 응답을 받았습니다. (HTTP ${response.status})`,
      code: "BAD_RESPONSE",
    });
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw asError({
      detail: `서버 응답을 해석할 수 없습니다. (HTTP ${response.status})`,
      code: "BAD_RESPONSE",
    });
  }

  if (!response.ok) {
    const err = parsed as Partial<ApiError>;
    throw asError({
      detail: err?.detail ?? `요청이 실패했습니다. (HTTP ${response.status})`,
      code: err?.code,
    });
  }

  return parsed as T;
}

function asError(api: ApiError): Error & ApiError {
  const e = new Error(api.detail) as Error & ApiError;
  e.detail = api.detail;
  e.code = api.code;
  return e;
}
