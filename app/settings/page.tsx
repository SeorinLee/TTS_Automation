"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { readJsonSafely } from "@/lib/http";
import type { Profile } from "@/lib/worker";

const PROFILE_META = {
  US_CHROME: { browser: "Chrome", market: "United States", code: "US", host: "seller-us.tiktok.com" },
  UK_CHROME: { browser: "Chrome", market: "United Kingdom", code: "UK", host: "seller-uk.tiktok.com" },
  US_EDGE: { browser: "Edge", market: "United States", code: "US", host: "seller-us.tiktok.com" },
  UK_EDGE: { browser: "Edge", market: "United Kingdom", code: "UK", host: "seller-uk.tiktok.com" },
} as const;

export default function SettingsPage() {
  const [profiles, setProfiles] = useState<Profile[]>([]);
  const [pending, setPending] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const res = await fetch("/api/profiles", { cache: "no-store" });
      setProfiles(await readJsonSafely<Profile[]>(res));
    } catch {
      setProfiles([]);
    }
  }, []);

  useEffect(() => {
    void load();
    const timer = setInterval(() => void load(), 3000);
    return () => clearInterval(timer);
  }, [load]);

  async function act(code: string, action: "login" | "verify" | "reset") {
    const key = `${code}:${action}`;
    setPending(key);
    setNotice(null);
    try {
      const res = await fetch(`/api/profiles/${code}/${action}`, { method: "POST" });
      if (!res.ok) {
        const data = await readJsonSafely<{ detail: string }>(res).catch(() => ({
          detail: "현재 다른 TikTok 작업이 실행 중입니다.",
        }));
        setNotice(data.detail);
      }
    } catch {
      setNotice("요청을 처리하지 못했습니다. Worker 실행 상태를 확인하세요.");
    } finally {
      setTimeout(() => {
        setPending(null);
        void load();
      }, 800);
    }
  }

  return (
    <>
      <section className="page-intro">
        <span className="eyebrow">ACCOUNT SESSIONS</span>
        <h1>TikTok 로그인 관리</h1>
        <p className="sub">Chrome과 Edge에서 US/UK를 각각 선택할 수 있으며 로그인은 조합별로 저장됩니다.</p>
      </section>

      <div className="info-banner">
        Chrome과 Edge를 모두 로그인할 필요는 없습니다. 실제로 사용할 브라우저 하나만 로그인하세요.
        로그인 단계에서는 퍼즐 인증을 진행하지 않습니다. 보안 인증은 GMV 조회 시작을 누른 뒤 열린 창에서 완료하세요.
      </div>

      {notice && <p className="inline-alert error">{notice}</p>}
      {profiles.length === 0 && (
        <p className="inline-alert error">Worker에 연결할 수 없습니다. Worker 실행 상태를 확인하세요.</p>
      )}

      <div className="settings-grid">
        {profiles.map((profile) => {
          const meta = PROFILE_META[profile.profile_code as keyof typeof PROFILE_META];
          if (!meta) return null;
          return (
            <section className="account-card" key={profile.profile_code}>
              <div className="account-card-head">
                <span className={`market-mark ${profile.profile_code.startsWith("UK_") ? "cyan" : "blue"}`}>
                  {meta.code}
                </span>
                <div>
                  <h2>{meta.browser} · {meta.market}</h2>
                  <p>{meta.host}</p>
                </div>
                <span className={`status-pill ${profile.status}`}>{profile.status}</span>
              </div>

              <div className="account-times">
                <div><span>마지막 로그인</span><strong>{profile.last_login_at ?? "-"}</strong></div>
                <div><span>마지막 확인</span><strong>{profile.last_verified_at ?? "-"}</strong></div>
              </div>

              {profile.last_error && <p className="inline-alert error">{profile.last_error}</p>}

              <div className="row">
                <button
                  className="btn primary"
                  disabled={!!pending}
                  onClick={() => act(profile.profile_code, "login")}
                >
                  {pending === `${profile.profile_code}:login` ? "브라우저 여는 중…" : `${meta.browser} 로그인`}
                </button>
                <button
                  className="btn secondary"
                  disabled={!!pending}
                  onClick={() => act(profile.profile_code, "verify")}
                >
                  연결 확인
                </button>
                <button
                  className="btn ghost"
                  disabled={!!pending}
                  onClick={() => act(profile.profile_code, "reset")}
                >
                  세션 초기화
                </button>
              </div>
            </section>
          );
        })}
      </div>

      <Link className="text-link" href="/">← GMV 조회로 돌아가기</Link>
    </>
  );
}
