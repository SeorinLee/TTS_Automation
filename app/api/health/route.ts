import { NextResponse } from "next/server";
import { workerFetch } from "@/lib/worker";

export const dynamic = "force-dynamic";

export async function GET() {
  try {
    const res = await workerFetch("/health");
    if (!res.ok) {
      return NextResponse.json(
        { ok: false, worker: "unavailable", detail: "Worker 서버에 연결할 수 없습니다." },
        { status: 502 },
      );
    }
    return NextResponse.json({ ok: true, worker: "connected" });
  } catch {
    return NextResponse.json(
      { ok: false, worker: "unavailable", detail: "Worker 서버에 연결할 수 없습니다." },
      { status: 502 },
    );
  }
}
