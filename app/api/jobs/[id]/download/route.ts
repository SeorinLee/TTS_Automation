import { NextRequest, NextResponse } from "next/server";
import { workerFetch } from "@/lib/worker";

export const dynamic = "force-dynamic";

export async function GET(_req: NextRequest, { params }: { params: { id: string } }) {
  try {
    const res = await workerFetch(`/jobs/${params.id}/download`);
    if (!res.ok || !res.body) {
      // Never return a fake .xlsx on failure — relay a clean JSON error (spec §8).
      const text = await res.text();
      let detail = "다운로드를 준비할 수 없습니다.";
      let code = "DOWNLOAD_ERROR";
      try {
        const parsed = JSON.parse(text) as { detail?: string; code?: string };
        if (parsed.detail) detail = parsed.detail;
        if (parsed.code) code = parsed.code;
      } catch {
        /* non-JSON body (e.g. plain text) — keep the generic message */
      }
      return NextResponse.json({ detail, code }, { status: res.status });
    }
    return new NextResponse(res.body, {
      status: 200,
      headers: {
        "content-type":
          res.headers.get("content-type") ??
          "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        "content-disposition": res.headers.get("content-disposition") ?? "attachment",
      },
    });
  } catch (error) {
    return NextResponse.json(
      { detail: error instanceof Error ? error.message : "다운로드 실패", code: "PROXY_ERROR" },
      { status: 502 },
    );
  }
}
