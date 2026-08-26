"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { readJsonSafely } from "@/lib/http";
import type { Profile } from "@/lib/worker";

const POLL_MS = 5000;
const DEFAULT_PROFILE = "US_CHROME";

type WorkerState = "checking" | "connected" | "unavailable";
type TikTokState = "checking" | "login_required" | "connected" | "error" | "running";

const PROFILE_META = {
  US_CHROME: { browser: "Chrome", market: "United States", code: "US", accent: "blue", destination: "affiliate-us.tiktok.com" },
  UK_CHROME: { browser: "Chrome", market: "United Kingdom", code: "UK", accent: "cyan", destination: "affiliate.tiktok.com" },
  US_EDGE: { browser: "Edge", market: "United States", code: "US", accent: "blue", destination: "affiliate-us.tiktok.com" },
  UK_EDGE: { browser: "Edge", market: "United Kingdom", code: "UK", accent: "cyan", destination: "affiliate.tiktok.com" },
} as const;

const WORKER_LABEL: Record<WorkerState, string> = {
  checking: "확인 중",
  connected: "Worker 연결됨",
  unavailable: "Worker 연결 안 됨",
};

const TIKTOK_LABEL: Record<TikTokState, string> = {
  checking: "확인 중",
  login_required: "로그인 필요",
  connected: "로그인 연결됨",
  error: "연결 오류",
  running: "작업 중",
};

function toTikTokState(status: string | undefined): TikTokState {
  switch (status) {
    case "connected":
      return "connected";
    case "running":
    case "connecting":
      return "running";
    case "error":
      return "error";
    case undefined:
      return "checking";
    default:
      return "login_required";
  }
}

export default function HomePage() {
  const router = useRouter();
  const [file, setFile] = useState<File | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [worker, setWorker] = useState<WorkerState>("checking");
  const [profiles, setProfiles] = useState<Profile[]>([]);
  const [selectedProfile, setSelectedProfile] = useState(DEFAULT_PROFILE);

  useEffect(() => {
    let alive = true;

    async function poll() {
      let workerUp = false;
      try {
        const res = await fetch("/api/health", { cache: "no-store" });
        const data = await readJsonSafely<{ ok?: boolean }>(res).catch(() => ({ ok: false }));
        workerUp = res.ok && !!data.ok;
      } catch {
        workerUp = false;
      }
      if (!alive) return;
      setWorker(workerUp ? "connected" : "unavailable");

      if (!workerUp) {
        setProfiles([]);
        return;
      }
      try {
        const res = await fetch("/api/profiles", { cache: "no-store" });
        const data = await readJsonSafely<Profile[]>(res);
        if (alive) setProfiles(data);
      } catch {
        if (alive) setProfiles([]);
      }
    }

    void poll();
    const timer = setInterval(() => void poll(), POLL_MS);
    return () => {
      alive = false;
      clearInterval(timer);
    };
  }, []);

  const selected = profiles.find((profile) => profile.profile_code === selectedProfile);
  const tiktok = worker === "connected" ? toTikTokState(selected?.status) : "checking";
  const canStart = worker === "connected" && tiktok === "connected" && !!file && !busy;

  async function start() {
    if (!file) return;
    setBusy(true);
    setError(null);
    try {
      const form = new FormData();
      form.append("file", file);
      form.append("profile_code", selectedProfile);
      const res = await fetch("/api/jobs", { method: "POST", body: form });
      const data = await readJsonSafely<{ job_id: string }>(res);
      router.push(`/jobs/${data.job_id}`);
    } catch (e) {
      setError(e instanceof Error ? e.message : "오류가 발생했습니다");
      setBusy(false);
    }
  }

  return (
    <>
      <section className="hero">
        <div>
          <span className="eyebrow">TikTok Shop Affiliate</span>
          <h1>Creator GMV를 더 빠르고 간단하게</h1>
          <p className="sub">
            브라우저와 마켓을 선택하고 Creator Name이 담긴 Excel을 업로드하세요.
            <br />GMV와 Items sold를 자동으로 숫자 변환해 정리합니다.
          </p>
        </div>
        <div className="hero-badge">
          <span>OUTPUT</span>
          <strong>Creator · GMV · Items</strong>
        </div>
      </section>

      <div className="status-strip">
        <div>
          <span className={`status-dot ${worker}`} />
          <span>{WORKER_LABEL[worker]}</span>
        </div>
        <div>
          <span className={`status-dot ${tiktok}`} />
          <span>{TIKTOK_LABEL[tiktok]}</span>
        </div>
      </div>

      <section className="step-card">
        <div className="step-heading">
          <span className="step-number">01</span>
          <div>
            <h2>브라우저와 마켓 선택</h2>
            <p>Chrome 또는 Edge를 고른 뒤 US/UK 국가를 선택하세요.</p>
          </div>
        </div>

        <div className="profile-grid">
          {Object.entries(PROFILE_META).map(([code, meta]) => {
            const profile = profiles.find((item) => item.profile_code === code);
            const state = toTikTokState(profile?.status);
            const active = selectedProfile === code;
            return (
              <button
                type="button"
                key={code}
                className={`profile-option ${active ? "selected" : ""}`}
                onClick={() => setSelectedProfile(code)}
              >
                <span className={`market-mark ${meta.accent}`}>{meta.code}</span>
                <span className="profile-copy">
                  <strong>{meta.browser}</strong>
                  <small>{meta.market} · {meta.destination}</small>
                </span>
                <span className={`status-pill ${state}`}>
                  {active && state === "connected" ? `${meta.code} 선택됨` : TIKTOK_LABEL[state]}
                </span>
              </button>
            );
          })}
        </div>

        {worker === "unavailable" && <p className="inline-alert error">Worker를 먼저 실행해 주세요.</p>}
        {worker === "connected" && tiktok === "login_required" && (
          <p className="inline-alert">
            선택한 마켓의 로그인이 필요합니다. <Link href="/settings">로그인 관리 열기 →</Link>
          </p>
        )}
      </section>

      <section className="step-card">
        <div className="step-heading">
          <span className="step-number">02</span>
          <div>
            <h2>Creator Excel 업로드</h2>
            <p>입력 파일에는 Creator Name 열 하나만 있으면 됩니다.</p>
          </div>
        </div>

        <div className="upload-layout">
          <div className="template-panel">
            <span className="mini-label">STARTER FILE</span>
            <strong>GMV Excel 템플릿</strong>
            <p>Creator Name 형식이 준비된 기본 파일입니다.</p>
            <a className="btn secondary" href="/gmv_upload_template.xlsx" download>
              템플릿 다운로드
            </a>
          </div>

          <label className={`upload-zone ${file ? "has-file" : ""}`}>
            <input
              type="file"
              accept=".xlsx"
              onChange={(event) => setFile(event.target.files?.[0] ?? null)}
            />
            <span className="upload-icon">↑</span>
            <strong>{file ? file.name : "Excel 파일을 선택하세요"}</strong>
            <small>{file ? "파일 선택 완료" : ".xlsx 파일만 지원합니다"}</small>
          </label>
        </div>
      </section>

      {error && <p className="inline-alert error">{error}</p>}

      <div className="action-bar">
        <div>
          <span>선택한 환경</span>
          <strong>
            {PROFILE_META[selectedProfile as keyof typeof PROFILE_META].browser} · {PROFILE_META[selectedProfile as keyof typeof PROFILE_META].code}
          </strong>
        </div>
        <button className="btn primary large" disabled={!canStart} onClick={start}>
          {busy ? "작업 생성 중…" : "GMV 조회 시작"}
        </button>
      </div>
    </>
  );
}
