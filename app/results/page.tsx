"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { readJsonSafely } from "@/lib/http";
import type { Job } from "@/lib/worker";

const STATUS_LABEL: Record<string, string> = {
  validating: "파일 확인 중",
  queued: "대기 중",
  running: "조회 중",
  cancel_requested: "중지 처리 중",
  cancelled: "중지됨",
  completed: "완료",
  completed_with_errors: "일부 완료",
  needs_login: "로그인 필요",
  failed: "실패",
};

const ACTIVE = new Set(["validating", "queued", "running", "cancel_requested"]);
const PROFILE_LABEL: Record<string, string> = {
  US_CHROME: "Chrome · US",
  UK_CHROME: "Chrome · UK",
  US_EDGE: "Edge · US",
  UK_EDGE: "Edge · UK",
};

export default function ResultsPage() {
  const [jobs, setJobs] = useState<Job[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const response = await fetch("/api/jobs", { cache: "no-store" });
      setJobs(await readJsonSafely<Job[]>(response));
      setError(null);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "조회 결과를 불러오지 못했습니다.");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
    const timer = window.setInterval(() => {
      if (jobs.some((job) => ACTIVE.has(job.status))) void load();
    }, 1500);
    return () => window.clearInterval(timer);
  }, [jobs, load]);

  return (
    <>
      <section className="page-intro results-intro">
        <div>
          <span className="eyebrow">LOOKUP HISTORY</span>
          <h1>조회 결과</h1>
          <p className="sub">진행 중인 작업과 이전 조회 결과를 한곳에서 확인할 수 있습니다.</p>
        </div>
        <Link className="btn primary" href="/">새 작업 시작</Link>
      </section>
      {error && <p className="inline-alert error">{error}</p>}
      <section className="card scroll">
        {loading ? <p className="muted">조회 결과를 불러오는 중…</p> : jobs.length === 0 ? (
          <div className="empty-state">
            <strong>아직 조회 결과가 없습니다.</strong>
            <p>새 작업에서 Creator Excel을 올려 첫 조회를 시작해 주세요.</p>
            <Link className="btn secondary" href="/">새 작업 열기</Link>
          </div>
        ) : (
          <table>
            <thead><tr><th>파일명</th><th>환경</th><th>진행</th><th>성공</th><th>실패</th><th>상태</th><th aria-label="결과 열기" /></tr></thead>
            <tbody>{jobs.map((job) => {
              const processed = job.success + job.range_rows + job.failed;
              const total = job.unique_creators || job.total_rows || 0;
              return <tr key={job.id}>
                <td><strong>{job.original_filename}</strong></td>
                <td>{PROFILE_LABEL[job.selected_profile_code ?? ""] ?? job.selected_profile_code}</td>
                <td>{processed} / {total}</td><td>{job.success + job.range_rows}</td><td>{job.failed}</td>
                <td><span className={`status-pill ${job.status}`}>{STATUS_LABEL[job.status] ?? job.status}</span></td>
                <td><Link className="result-link" href={`/jobs/${job.id}`}>열기 →</Link></td>
              </tr>;
            })}</tbody>
          </table>
        )}
      </section>
    </>
  );
}
