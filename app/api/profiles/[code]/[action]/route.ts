import { NextRequest, NextResponse } from "next/server";
import { readJsonSafely, workerFetch } from "@/lib/worker";

export const dynamic = "force-dynamic";

const ALLOWED = new Set(["login", "verify", "reset"]);

export async function POST(
  _req: NextRequest,
  { params }: { params: { code: string; action: string } },
) {
  if (!ALLOWED.has(params.action)) {
    return NextResponse.json({ detail: "unknown action" }, { status: 400 });
  }
  try {
    const res = await workerFetch(`/profiles/${params.code}/${params.action}`, { method: "POST" });
    const body = await readJsonSafely(res);
    return NextResponse.json(body, { status: res.status });
  } catch (error) {
    return NextResponse.json(
      { detail: error instanceof Error ? error.message : "프로필 액션 실패", code: "PROXY_ERROR" },
      { status: 502 },
    );
  }
}
