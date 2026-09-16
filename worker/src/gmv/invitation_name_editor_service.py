"""Durable, resumable runner for verified invitation name edits."""

from __future__ import annotations

import asyncio
import contextlib
import re
from datetime import UTC, datetime

from gmv.automation.human_verification import await_with_human_verification_pause
from gmv.automation.invitation_name_editor_session import duplicate_invitation_count
from gmv.config import ProfileStatus
from gmv.invitation_acceptor import InvitationNameEditSpec, write_invitation_name_edit_results
from gmv.models import JobCancelledError
from gmv.store import InvitationNameEditRecord, JobLogRecord, JobStatus, JobStore

ITEM_RETRIES = 2
ITEM_WATCHDOG_SECONDS = 600.0
MAX_CONSECUTIVE_FAILED_CYCLES = 3


def now() -> str:
    return datetime.now(UTC).isoformat(timespec="seconds")


def append_log(record, message: str, status: str = "INFO") -> None:
    record.logs.append(JobLogRecord(time=now(), message=str(message), status=status))
    record.logs = record.logs[-500:]


def checkpoint(store: JobStore, record) -> None:
    verified = [row for row in record.invitation_name_edit_rows if row.status == "VERIFIED"]
    failed = [row for row in record.invitation_name_edit_rows if row.status == "FAILED"]
    record.processed = len(verified) + len(failed)
    record.success = len(verified)
    record.failed = len(failed)
    write_invitation_name_edit_results(
        record.invitation_name_edit_groups,
        record.invitation_name_edit_rows,
        str(store.output_path(record.id)),
    )
    store.save(record)


def spec_from_group(group) -> InvitationNameEditSpec:
    return InvitationNameEditSpec(
        order=group.order,
        base_name=group.base_name,
        owner=group.owner,
        product=group.product,
        date=group.date,
    )


async def close_session(session) -> None:
    if session is not None:
        with contextlib.suppress(Exception):
            await asyncio.wait_for(session.close(), timeout=10)


async def process_invitation_name_edit_job(
    store: JobStore,
    session_factory,
    profile,
    job_id: str,
    *,
    cancel_event=None,
    pause_event=None,
) -> None:
    record = store.get(job_id)
    if record is None:
        raise KeyError(job_id)
    record.status = JobStatus.RUNNING
    record.started_at = record.started_at or now()
    append_log(record, "초대장 이름 수정 작업을 시작했습니다.", "PROCESSING")
    checkpoint(store, record)
    session = None
    cancelled = False
    try:
        for group in sorted(record.invitation_name_edit_groups, key=lambda item: item.order):
            if group.status == "COMPLETED":
                continue
            spec = spec_from_group(group)
            group.status = "PROCESSING"
            group.message = None
            record.current = group.base_name
            record.current_number = None
            record.current_original_name = group.base_name
            record.current_new_name = None
            checkpoint(store, record)

            async def progress(phase, message, page=0, total=0):
                previous_phase = record.current_phase
                record.current_phase = phase
                record.search_page = page
                record.search_total_pages = total
                log_status = "PROCESSING"
                if phase == "human_verification":
                    record.status = JobStatus.PAUSED
                    log_status = "VERIFICATION_REQUIRED"
                elif phase == "human_verification_resolved" and (
                    previous_phase == "human_verification"
                    and (pause_event is None or pause_event.is_set())
                ):
                    record.status = JobStatus.RUNNING
                if phase == "save" and "→" in message:
                    before, after = (part.strip() for part in message.rsplit(" 저장", 1)[0].split("→", 1))
                    number_match = re.search(r"(\d+)$", after)
                    record.current_original_name = before
                    record.current_new_name = after
                    record.current_number = int(number_match.group(1)) if number_match else None
                append_log(record, message, log_status)
                store.save(record)

            snapshot = None
            initial_error = None
            for attempt in range(ITEM_RETRIES + 1):
                try:
                    if session is None:
                        session = session_factory(profile)
                        with contextlib.suppress(Exception):
                            session.set_human_verification_callback(progress)
                        status = await await_with_human_verification_pause(
                            session.start(), session=session, timeout_seconds=90
                        )
                        if status in {ProfileStatus.LOGIN_REQUIRED, ProfileStatus.EXPIRED}:
                            group.status = "QUEUED"
                            group.message = "TikTok 로그인이 필요합니다. 로그인 후 작업 계속을 눌러주세요."
                            record.status = JobStatus.NEEDS_LOGIN
                            append_log(record, group.message, "LOGIN_REQUIRED")
                            checkpoint(store, record)
                            return
                        if status is not ProfileStatus.CONNECTED:
                            raise RuntimeError(f"browser start status: {status}")
                    snapshot = await await_with_human_verification_pause(
                        session.scan_group(spec, progress),
                        session=session,
                        timeout_seconds=ITEM_WATCHDOG_SECONDS,
                    )
                    break
                except JobCancelledError:
                    cancelled = True
                    break
                except Exception as exc:  # noqa: BLE001
                    initial_error = exc
                    if getattr(exc, "error_code", "") == "LOGIN_REQUIRED":
                        group.status = "QUEUED"
                        group.message = str(exc)
                        record.status = JobStatus.NEEDS_LOGIN
                        append_log(record, group.message, "LOGIN_REQUIRED")
                        checkpoint(store, record)
                        return
                    wait_verification = getattr(session, "_wait_for_human_verification", None)
                    if wait_verification is not None and await wait_verification(progress):
                        append_log(record, "인증 완료 · 현재 초대장부터 다시 확인", "RETRY")
                        continue
                    await close_session(session)
                    session = None
                    if attempt < ITEM_RETRIES:
                        append_log(record, f"초기 검색 재시도 {attempt + 1}/{ITEM_RETRIES}", "RETRY")
            if cancelled:
                break
            if snapshot is None:
                group.status = "FAILED"
                group.failed_count += 1
                group.message = str(initial_error or "초기 검색 결과를 확인하지 못했습니다.")[:500]
                group.processed_at = now()
                record.invitation_name_edit_rows.append(
                    InvitationNameEditRecord(
                        group_order=group.order,
                        base_name=group.base_name,
                        original_name=group.base_name,
                        new_name="",
                        number=0,
                        status="FAILED",
                        message=group.message,
                        attempts=ITEM_RETRIES + 1,
                    )
                )
                append_log(record, f"{group.base_name} 초기 검색 실패: {group.message}", "ERROR")
                checkpoint(store, record)
                continue

            # "Discovered" is the complete Product_Date search result count from the initial
            # scan. Exact base-name matches remain separate for safe numbering and resumption.
            fixed_total = snapshot.result_total
            known_numbers = set(snapshot.used_numbers)
            planned_renames = snapshot.unnumbered_count + duplicate_invitation_count(
                snapshot.names, spec.base_name
            )
            next_number = max(known_numbers, default=0) + 1 if planned_renames else None
            renamed_this_run = 0
            consecutive_failed_cycles = 0
            group.discovered_total = fixed_total
            group.completed_count = fixed_total - planned_renames
            group.remaining_count = planned_renames
            append_log(
                record,
                f"초기 검색 완료 · 전체 {fixed_total}개 · 번호 기입 {snapshot.numbered_count}개 · "
                f"수정 대상 {planned_renames}개 · 마지막 번호 "
                f"{max(known_numbers, default=0) or '-'} · 다음 번호 {next_number or '-'}",
                "COUNTED",
            )
            checkpoint(store, record)
            if planned_renames == 0:
                group.status = "COMPLETED"
                group.processed_at = now()
                group.message = "모든 초대장에 이미 번호가 있습니다."
                append_log(record, f"{group.base_name} · {group.message}", "COMPLETED")
                checkpoint(store, record)
                continue

            while renamed_this_run < planned_renames:
                if cancel_event is not None and cancel_event.is_set():
                    cancelled = True
                    break
                if pause_event is not None:
                    if not pause_event.is_set():
                        record.status = JobStatus.PAUSED
                        append_log(record, "작업을 일시정지했습니다.", "PAUSED")
                        checkpoint(store, record)
                    await pause_event.wait()
                    if record.status == JobStatus.PAUSED:
                        record.status = JobStatus.RUNNING
                        append_log(record, "작업을 계속합니다.", "PROCESSING")
                        checkpoint(store, record)
                last_error = None
                outcome = None
                for attempt in range(ITEM_RETRIES + 1):
                    try:
                        if session is None:
                            session = session_factory(profile)
                            status = await asyncio.wait_for(session.start(), timeout=90)
                            if status in {ProfileStatus.LOGIN_REQUIRED, ProfileStatus.EXPIRED}:
                                group.status = "QUEUED"
                                group.message = "TikTok 로그인이 필요합니다. 로그인 후 작업 계속을 눌러주세요."
                                record.status = JobStatus.NEEDS_LOGIN
                                append_log(record, group.message, "LOGIN_REQUIRED")
                                checkpoint(store, record)
                                return
                            if status is not ProfileStatus.CONNECTED:
                                raise RuntimeError(f"browser start status: {status}")
                        outcome = await asyncio.wait_for(
                            session.rename_next(
                                spec,
                                progress,
                                snapshot=snapshot,
                                number=next_number,
                            ),
                            timeout=ITEM_WATCHDOG_SECONDS,
                        )
                        break
                    except JobCancelledError:
                        cancelled = True
                        break
                    except Exception as exc:  # noqa: BLE001
                        last_error = exc
                        code = getattr(exc, "error_code", "UNKNOWN_ERROR")
                        if code == "LOGIN_REQUIRED":
                            group.status = "QUEUED"
                            group.message = str(exc)
                            record.status = JobStatus.NEEDS_LOGIN
                            append_log(record, group.message, "LOGIN_REQUIRED")
                            checkpoint(store, record)
                            return
                        await close_session(session)
                        session = None
                        # A save may have reached TikTok before a connection error. Force a live
                        # recount on retry instead of trusting the pre-error numbering snapshot.
                        snapshot = None
                        if attempt < ITEM_RETRIES:
                            append_log(record, f"브라우저 재연결 {attempt + 1}/{ITEM_RETRIES}", "RETRY")
                if cancelled:
                    break
                if outcome is not None and outcome.status == "NO_CHANGES":
                    group.completed_count = outcome.completed_count
                    group.remaining_count = 0
                    group.status = "COMPLETED"
                    group.processed_at = now()
                    group.message = outcome.message
                    append_log(record, f"{group.base_name} · {outcome.message}", "COMPLETED")
                    checkpoint(store, record)
                    break
                if outcome is None and last_error is None:
                    group.status = "COMPLETED"
                    group.remaining_count = 0
                    group.processed_at = now()
                    group.message = "변경할 미번호 초대장이 없습니다."
                    append_log(record, f"{group.base_name} 완료", "COMPLETED")
                    checkpoint(store, record)
                    break
                if outcome is None:
                    consecutive_failed_cycles += 1
                    message = str(last_error or "알 수 없는 오류")[:500]
                    if consecutive_failed_cycles < MAX_CONSECUTIVE_FAILED_CYCLES:
                        snapshot = None
                        append_log(
                            record,
                            f"{group.base_name} 처리 오류: {message} · 목록 재검색 후 계속",
                            "RETRY",
                        )
                        checkpoint(store, record)
                        continue
                    group.status = "FAILED"
                    group.failed_count += 1
                    group.message = message
                    group.processed_at = now()
                    record.invitation_name_edit_rows.append(
                        InvitationNameEditRecord(
                            group_order=group.order,
                            base_name=group.base_name,
                            original_name=group.base_name,
                            new_name="",
                            number=0,
                            status="FAILED",
                            message=group.message,
                            attempts=(ITEM_RETRIES + 1) * consecutive_failed_cycles,
                        )
                    )
                    append_log(record, f"{group.base_name} 실패: {group.message}", "ERROR")
                    checkpoint(store, record)
                    break

                record.invitation_name_edit_rows.append(
                    InvitationNameEditRecord(
                        group_order=group.order,
                        base_name=group.base_name,
                        original_name=outcome.original_name,
                        new_name=outcome.new_name,
                        number=outcome.number,
                        status=outcome.status,
                        message=outcome.message,
                        attempts=1,
                        saved_at=now(),
                        verified_at=now(),
                    )
                )
                renamed_this_run += 1
                consecutive_failed_cycles = 0
                snapshot = outcome.snapshot
                known_numbers.add(outcome.number)
                if snapshot is not None:
                    known_numbers.update(snapshot.used_numbers)
                group.remaining_count = outcome.remaining_count
                group.completed_count = outcome.completed_count
                # Reconcile the loop with the complete post-save scan instead of assuming that
                # the initial page state stayed unchanged throughout a long 100+ item run.
                planned_renames = renamed_this_run + group.remaining_count
                next_number = (
                    max(max(known_numbers, default=0) + 1, outcome.number + 1)
                    if group.remaining_count
                    else None
                )
                group.discovered_total = fixed_total
                append_log(
                    record,
                    f"{outcome.original_name} → {outcome.new_name} 확인 완료 · "
                    f"전체 {outcome.discovered_total}개 · 번호 기입 {outcome.completed_count}개 · "
                    f"남음 {outcome.remaining_count}개 · 마지막 번호 "
                    f"{max(known_numbers, default=outcome.number)}",
                    "SUCCESS",
                )
                checkpoint(store, record)
                if group.remaining_count == 0:
                    group.status = "COMPLETED"
                    group.message = f"{group.completed_count}개 이름 수정 완료"
                    group.processed_at = now()
                    checkpoint(store, record)
                    break
            if (
                not cancelled
                and group.status == "PROCESSING"
                and renamed_this_run >= planned_renames
            ):
                if group.remaining_count == 0:
                    group.status = "COMPLETED"
                    group.message = f"{planned_renames}개 이름 수정 완료"
                else:
                    group.status = "FAILED"
                    group.failed_count += 1
                    group.message = (
                        f"초기 수정 대상 {planned_renames}개를 처리했지만 "
                        f"미번호 초대장 {group.remaining_count}개가 남아 안전하게 중단했습니다."
                    )
                    append_log(record, group.message, "ERROR")
                group.processed_at = now()
                checkpoint(store, record)
            if cancelled:
                break
    finally:
        await close_session(session)

    if cancelled:
        for group in record.invitation_name_edit_groups:
            if group.status in {"QUEUED", "PROCESSING"}:
                group.status = "CANCELLED"
                group.message = "사용자가 작업을 중지했습니다."
        record.status = JobStatus.CANCELLED
        append_log(record, "작업을 중지했습니다.", "CANCELLED")
    else:
        record.status = (
            JobStatus.COMPLETED
            if all(group.status == "COMPLETED" for group in record.invitation_name_edit_groups)
            else JobStatus.COMPLETED_WITH_ERRORS
        )
        append_log(record, "초대장 이름 수정 작업이 종료되었습니다.", "COMPLETED")
    record.current = None
    record.current_original_name = None
    record.current_new_name = None
    record.current_phase = None
    record.finished_at = now()
    record.output_filename = "invitation_name_edit_results.xlsx"
    checkpoint(store, record)
