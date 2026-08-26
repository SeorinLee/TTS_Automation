import { NextResponse } from "next/server";
import { readJsonSafely, workerFetch } from "@/lib/worker";

export const dynamic = "force-dynamic";

export async function GET() {
  try {
    const res = await workerFetch("/profile");
    const body = await readJsonSafely(res);
    return NextResponse.json(body, { status: res.status });
  } catch (error) {
    return NextResponse.json(
      { detail: error instanceof Error ? error.message : "프로필 조회 실패", code: "PROXY_ERROR" },
      { status: 502 },
    );
  }
}
