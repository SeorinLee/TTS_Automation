import { NextResponse } from "next/server";
import { readJsonSafely, workerFetch } from "@/lib/worker";

export const dynamic = "force-dynamic";

export async function POST() {
  try {
    const res = await workerFetch("/profile/verify", { method: "POST" });
    const body = await readJsonSafely(res);
    return NextResponse.json(body, { status: res.status });
  } catch (error) {
    return NextResponse.json(
      { detail: error instanceof Error ? error.message : "연결 확인 실패", code: "PROXY_ERROR" },
      { status: 502 },
    );
  }
}
