import { NextRequest, NextResponse } from "next/server";
import { readJsonSafely, workerFetch } from "@/lib/worker";

export const dynamic = "force-dynamic";

export async function POST(req: NextRequest) {
  try {
    const form = await req.formData();
    const res = await workerFetch("/jobs", { method: "POST", body: form });
    const body = await readJsonSafely(res);
    return NextResponse.json(body, { status: res.status });
  } catch (error) {
    return NextResponse.json(
      { detail: error instanceof Error ? error.message : "업로드 실패", code: "PROXY_ERROR" },
      { status: 502 },
    );
  }
}

export async function GET() {
  try {
    const res = await workerFetch("/jobs");
    const body = await readJsonSafely(res);
    return NextResponse.json(body, { status: res.status });
  } catch (error) {
    return NextResponse.json(
      { detail: error instanceof Error ? error.message : "작업 목록 조회 실패", code: "PROXY_ERROR" },
      { status: 502 },
    );
  }
}
