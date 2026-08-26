import { NextRequest, NextResponse } from "next/server";
import { readJsonSafely, workerFetch } from "@/lib/worker";

export const dynamic = "force-dynamic";

export async function POST(_req: NextRequest, { params }: { params: { id: string } }) {
  try {
    const res = await workerFetch(`/jobs/${params.id}/retry`, { method: "POST" });
    const body = await readJsonSafely(res);
    return NextResponse.json(body, { status: res.status });
  } catch (error) {
    return NextResponse.json(
      { detail: error instanceof Error ? error.message : "재시도 요청 실패", code: "PROXY_ERROR" },
      { status: 502 },
    );
  }
}
