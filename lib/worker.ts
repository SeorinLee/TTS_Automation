// Server-side helpers to reach the Python Worker API (spec §8: automation runs there).

export const WORKER_BASE_URL =
  process.env.WORKER_BASE_URL ?? "http://127.0.0.1:8000";

export type RowStatus = "PENDING" | "RUNNING" | "SUCCESS" | "RANGE" | "FAILED";

export interface WorkerErrorShape {
  detail: string;
  code: string;
}

export interface JobRow {
  sheet_name: string;
  excel_row_number: number;
  creator: string;
  normalized_username: string | null;
  account_code: string | null;
  status: RowStatus | string;
  raw_gmv: string | null;
  gmv_value: number | null;
  gmv_type: string | null;
  items_sold: number | null;
  error_code: string | null;
  error_message: string | null;
  current_stage: string | null;
  source: string | null;
  display_name: string | null;
  pps: string | null;
  category: string | null;
  audience: string | null;
  status_badge: string | null;
  items_sold_raw: string | null;
}

export interface Job {
  id: string;
  original_filename: string;
  selected_profile_code: string | null;
  concurrency: number;
  status: string;
  total_rows: number;
  unique_creators: number;
  processed: number;
  success: number;
  range_rows: number;
  failed: number;
  current: string | null;
  output_filename: string | null;
  created_at: string;
  started_at: string | null;
  finished_at: string | null;
  rows: JobRow[];
}

// The single default profile (browser_channel/market are operator-only and NOT exposed by
// the singular /profile endpoint — spec §10 — so they are optional here).
export interface Profile {
  profile_code: string;
  display_name: string;
  status: string;
  last_login_at: string | null;
  last_verified_at: string | null;
  last_used_at: string | null;
  last_error: string | null;
  browser_channel?: string;
  market?: string;
}

export class WorkerUnavailableError extends Error {
  code = "WORKER_UNAVAILABLE";
}

const WORKER_TIMEOUT_MS = 8000;

/**
 * Fetch the Worker with a timeout. On a connection failure or timeout it returns a synthetic
 * 502 JSON Response (never throws), so proxy routes always have a well-formed body to relay.
 * The Worker URL is never placed into the error surfaced to the client (spec §7).
 */
export async function workerFetch(path: string, init?: RequestInit): Promise<Response> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), WORKER_TIMEOUT_MS);
  try {
    return await fetch(`${WORKER_BASE_URL}${path}`, {
      cache: "no-store",
      signal: controller.signal,
      ...init,
      headers: {
        "ngrok-skip-browser-warning": "true",
        ...(init?.headers ?? {}),
      },
    });
  } catch {
    return new Response(
      JSON.stringify({
        detail: "Worker 서버에 연결할 수 없습니다. Worker 실행 상태를 확인하세요.",
        code: "WORKER_UNAVAILABLE",
      }),
      { status: 502, headers: { "content-type": "application/json" } },
    );
  } finally {
    clearTimeout(timeout);
  }
}

export async function readJsonSafely(response: Response): Promise<any> {
  const text = await response.text();
  if (!text) {
    throw new Error("Worker 응답이 비어 있습니다.");
  }
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`Worker 응답 형식이 올바르지 않습니다. (${response.status})`);
  }
}
