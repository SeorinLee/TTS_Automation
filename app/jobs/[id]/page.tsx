"use client";

import { useCallback, useEffect, useState } from "react";
import { useParams } from "next/navigation";
import Link from "next/link";
import { readJsonSafely } from "@/lib/http";
import type { Job } from "@/lib/worker";

const TERMINAL = new Set([
  "completed",
  "completed_with_errors",
  "failed",
  "needs_login",
  "cancelled",
]);

// States whose finished output workbook can be downloaded (cancelled = partial results, §7,§10).
const DOWNLOADABLE = new Set(["completed", "completed_with_errors", "cancelled"]);

// States where the job is still going and can be stopped.
const STOPPABLE = new Set(["running", "queued"]);

export default function JobPage() {
  const { id } = useParams<{ id: string }>();
  const [job, setJob] = useState<Job | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [retrying, setRetrying] = useState(false);
  const [cancelling, setCancelling] = useState(false);

  const load = useCallback(async () => {
    try {
      const res = await fetch(`/api/jobs/${id}`, { cache: "no-store" });
      const data = await readJsonSafely<Job>(res);
      setJob(data);
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : "진행 상태를 불러오지 못했습니다.");
    }
  }, [id]);

  useEffect(() => {
    void load();
    const t = setInterval(() => {
      setJob((cur) => {
        if (cur && TERMINAL.has(cur.status)) return cur;
        void load();
        return cur;
      });
    }, 1500);
    return () => clearInterval(t);
  }, [load]);

  if (!job) {
    if (error) {
      return (
        <>
          <p className="err">{error}</p>
          <button className="btn" onClick={() => void load()}>다시 불러오기</button>
        </>
      );
    }
    return <p className="muted">불러오는 중…</p>;
  }

  const done = job.success + job.range_rows + job.failed;
  const denom = job.unique_creators || job.total_rows || 1;
  const pct = Math.min(100, Math.round((done / denom) * 100));
  const isTerminal = TERMINAL.has(job.status);
  const canDownload = DOWNLOADABLE.has(job.status) && !!job.output_filename;
  const isStoppable = STOPPABLE.has(job.status);
  const isCancelRequested = job.status === "cancel_requested";
  const isCancelled = job.status === "cancelled";

  async function retry() {
    setRetrying(true);
    await fetch(`/api/jobs/${id}/retry`, { method: "POST" });
    setTimeout(() => {
      setRetrying(false);
      void load();
    }, 800);
  }

  async function cancel() {
    if (cancelling) return; // send the stop request only once (spec §11)
    setCancelling(true);
    try {
      const res = await fetch(`/api/jobs/${id}/cancel`, { method: "POST" });
      await readJsonSafely(res).catch(() => null);
    } finally {
      setTimeout(() => void load(), 500);
    }
  }

  function downloadErrorsCsv() {
    const rows = job!.rows.filter((r) => r.status === "FAILED");
    const header = ["sheet", "row", "creator", "error_code", "error_message"];
    const lines = [header.map(csvField).join(",")];
    for (const r of rows) {
      lines.push(
        [
          r.sheet_name,
          String(r.excel_row_number),
          r.creator,
          r.error_code ?? "",
          r.error_message ?? "",
        ]
          .map(csvField)
          .join(","),
      );
    }
    const blob = new Blob(["﻿" + lines.join("\r\n")], { type: "text/csv;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `${job!.original_filename}_errors.csv`;
    a.click();
    URL.revokeObjectURL(url);
  }

  return (
    <>
      <h1>{job.original_filename}</h1>
      <p className="sub">
        상태 <span className="status-pill">{job.status}</span>
        {job.selected_profile_code && (
          <> · 환경: {job.selected_profile_code === "UK_EDGE" ? "Edge · UK" : "Chrome · US"}</>
        )}
        {job.current && !isTerminal && <> · 현재: {job.current}</>}
      </p>

      {error && <p className="err">진행 상태 갱신에 실패했습니다: {error}</p>}

      {isCancelRequested && (
        <p className="muted">작업 중지를 요청했습니다. 현재 처리 중인 항목을 정리한 후 중지됩니다.</p>
      )}
      {isCancelled && (
        <p className="muted">
          작업이 중지되었습니다. 완료된 데이터가 포함된 부분 결과를 다운로드할 수 있습니다.
          {` (완료 ${done} / 전체 ${job.unique_creators})`}
        </p>
      )}

      <div className="stats">
        <div className="stat"><div className="n">{job.total_rows}</div><div className="l">전체 행</div></div>
        <div className="stat"><div className="n">{job.unique_creators}</div><div className="l">고유 크리에이터</div></div>
        <div className="stat"><div className="n">{job.success}</div><div className="l">성공</div></div>
        <div className="stat"><div className="n">{job.range_rows}</div><div className="l">범위형</div></div>
        <div className="stat"><div className="n">{job.failed}</div><div className="l">실패</div></div>
      </div>

      <div className="bar"><span style={{ width: `${pct}%` }} /></div>

      <div className="row">
        {isStoppable && (
          <button className="btn danger" onClick={cancel} disabled={cancelling}>
            {cancelling ? "중지 요청 중…" : "작동 중지"}
          </button>
        )}
        {isCancelRequested && (
          <button className="btn danger" disabled>중지 처리 중…</button>
        )}
        {job.status === "needs_login" && (
          <span className="err">로그인 세션이 만료되었습니다. TikTok 로그인에서 다시 로그인한 뒤 재시도하세요.</span>
        )}
        {canDownload && (
          <a className="btn" href={`/api/jobs/${id}/download`}>
            {isCancelled ? "부분 결과 다운로드" : "완료된 Excel 다운로드"}
          </a>
        )}
        {isTerminal && job.failed > 0 && (
          <button className="btn secondary" onClick={retry} disabled={retrying}>
            {retrying ? "재시도 중…" : "실패한 행만 재시도"}
          </button>
        )}
        {job.failed > 0 && (
          <button className="btn ghost" onClick={downloadErrorsCsv}>오류 목록 CSV</button>
        )}
        <Link className="btn ghost" href="/">새 파일 업로드</Link>
      </div>

      <h2>조회 결과</h2>
      <div className="card scroll">
        <table>
          <thead>
            <tr>
              <th>Creator Name</th><th>GMV</th><th>Items sold</th>
            </tr>
          </thead>
          <tbody>
            {job.rows.map((r) => (
              <tr key={`${r.sheet_name}-${r.excel_row_number}`}>
                <td>{r.creator}</td>
                <td>{r.gmv_value ?? ""}</td>
                <td>{r.items_sold ?? ""}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </>
  );
}

// RFC 4180: wrap in double quotes and double any embedded quote when the field contains a
// comma, quote, CR or LF (spec §17).
function csvField(value: string): string {
  if (/[",\r\n]/.test(value)) {
    return `"${value.replace(/"/g, '""')}"`;
  }
  return value;
}
