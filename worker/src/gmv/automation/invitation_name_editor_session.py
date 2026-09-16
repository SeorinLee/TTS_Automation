"""Verified Target Invitation name editing built on the inspector navigation flow."""

from __future__ import annotations

import contextlib
import re
from collections import Counter
from dataclasses import dataclass

from gmv.automation import selectors
from gmv.automation.invitation_acceptor_session import (
    DetailFailedError,
    InvitationAcceptError,
    LoginRequiredError,
    SearchFailedError,
)
from gmv.automation.invitation_inspector_session import (
    MAX_SEARCH_PAGES,
    TikTokInvitationInspectorSession,
)
from gmv.invitation_acceptor import (
    InvitationNameEditSpec,
    invitation_number_for_base,
)

MAX_RENAMES_PER_GROUP = 10_000
SAVE_VERIFY_SCANS = 3
FULL_RESULT_PAGE_SIZE = 50
NAME_SEPARATOR = r"[\u200b\u200c\u200d\ufeff \t]*(?:\r?\n[\u200b\u200c\u200d\ufeff \t]*)?"


def invitation_names_from_text(text: str, base_name: str) -> tuple[str, ...]:
    """Extract canonical names even when TikTok splits the numeric suffix into another node."""
    pattern = re.compile(rf"{re.escape(base_name)}{NAME_SEPARATOR}([0-9]+)?", re.I)
    return tuple(f"{base_name}{match.group(1) or ''}" for match in pattern.finditer(text))


def is_unnumbered_invitation_text(text: str, base_name: str) -> bool:
    return any(
        name.casefold() == base_name.casefold()
        for name in invitation_names_from_text(text, base_name)
    )


def duplicate_invitation_numbers(names: tuple[str, ...], base_name: str) -> frozenset[int]:
    numbers = [invitation_number_for_base(name, base_name) for name in names]
    counts = Counter(number for number in numbers if number is not None and number > 0)
    return frozenset(number for number, count in counts.items() if count > 1)


def duplicate_invitation_count(names: tuple[str, ...], base_name: str) -> int:
    numbers = [invitation_number_for_base(name, base_name) for name in names]
    counts = Counter(number for number in numbers if number is not None and number > 0)
    return sum(count - 1 for count in counts.values() if count > 1)


def invitation_number_count(names: tuple[str, ...], base_name: str, number: int) -> int:
    return sum(invitation_number_for_base(name, base_name) == number for name in names)


class EditButtonNotFoundError(InvitationAcceptError):
    error_code = "EDIT_BUTTON_NOT_FOUND"


class NameInputNotFoundError(InvitationAcceptError):
    error_code = "NAME_INPUT_NOT_FOUND"


class SaveButtonNotFoundError(InvitationAcceptError):
    error_code = "SAVE_BUTTON_NOT_FOUND"


class RenameVerifyFailedError(InvitationAcceptError):
    error_code = "RENAME_VERIFY_FAILED"


@dataclass(frozen=True)
class InvitationNameSnapshot:
    names: tuple[str, ...]
    result_total: int
    used_numbers: frozenset[int]
    unnumbered_count: int
    numbered_count: int


@dataclass(frozen=True)
class RenameOutcome:
    original_name: str
    new_name: str
    number: int
    remaining_count: int
    discovered_total: int
    completed_count: int = 0
    snapshot: InvitationNameSnapshot | None = None
    status: str = "VERIFIED"
    message: str = "저장 후 목록 재검색으로 이름 변경을 확인했습니다."


class TikTokInvitationNameEditorSession(TikTokInvitationInspectorSession):
    """Rename one exact unnumbered invitation and verify the mutation from a fresh list."""

    # TikTok keeps analytics requests open, so a full 15-second network-idle wait adds delay
    # without improving result accuracy. Element/signature checks below remain authoritative.
    _list_network_idle_timeout_ms = 2_500
    _list_settle_timeout_ms = 300
    _pagination_settle_timeout_ms = 500

    async def scan_group(self, spec: InvitationNameEditSpec, progress_cb=None) -> InvitationNameSnapshot:
        await self._prepare_search(spec, progress_cb)
        names: list[str] = []
        visited: set[str] = set()
        result_total = 0
        pages_scanned = 0
        for page_number in range(1, MAX_SEARCH_PAGES + 1):
            self._check_cancel()
            await self._emit(progress_cb, "scan", f"검색 결과 {page_number}페이지 확인", page_number)
            signature = await self._search_result_signature()
            if signature in visited:
                break
            visited.add(signature)
            pages_scanned += 1
            page_names = await self._names_on_current_page(spec.base_name)
            names.extend(page_names)
            page_row_count = await self._result_row_count_on_current_page(page_names)
            result_total += page_row_count
            if not await self._advance_scan_page(page_number, page_row_count):
                break
        # A single-page result remains on the first page and can be used immediately by the
        # next edit. Multi-page counting ends on the last page and must be searched again.
        self._name_edit_search_ready = pages_scanned == 1
        numbers = [invitation_number_for_base(name, spec.base_name) for name in names]
        return InvitationNameSnapshot(
            names=tuple(names),
            result_total=result_total,
            used_numbers=frozenset(number for number in numbers if number and number > 0),
            unnumbered_count=sum(number == 0 for number in numbers),
            numbered_count=sum(number is not None and number > 0 for number in numbers),
        )

    async def rename_next(
        self,
        spec: InvitationNameEditSpec,
        progress_cb=None,
        snapshot: InvitationNameSnapshot | None = None,
        number: int | None = None,
    ) -> RenameOutcome | None:
        # The service supplies the latest verified snapshot. A fresh scan is needed only after a
        # browser/session restart, so normal iterations do not count the whole group twice.
        before = snapshot or await self.scan_group(spec, progress_cb)
        duplicate_count = duplicate_invitation_count(before.names, spec.base_name)
        if before.unnumbered_count == 0 and duplicate_count == 0:
            return RenameOutcome(
                original_name="",
                new_name="",
                number=0,
                remaining_count=0,
                discovered_total=before.result_total,
                completed_count=before.numbered_count,
                snapshot=before,
                status="NO_CHANGES",
                message="모든 초대장에 이미 번호가 있습니다.",
            )
        if len(before.used_numbers) >= MAX_RENAMES_PER_GROUP:
            raise RenameVerifyFailedError("한 입력에서 500개를 초과하여 안전하게 중단했습니다.")
        next_after_visible_max = max(before.used_numbers, default=0) + 1
        if number is None:
            number = next_after_visible_max
        else:
            # A partial page scan can omit an older suffix. Never fill a perceived gap: after
            # 57 the next safe value is 58 even if 2 or 8 was absent from this render.
            number = max(number, next_after_visible_max)
        new_name = f"{spec.base_name}{number}"
        if len(new_name) > 30:
            raise NameInputNotFoundError(f"새 이름이 TikTok 30자 제한을 넘습니다: {new_name}")

        if not (snapshot is not None and getattr(self, "_name_edit_search_ready", False)):
            await self._prepare_search(spec, progress_cb)
        original_name = spec.base_name
        editing_unnumbered = before.unnumbered_count > 0
        if editing_unnumbered:
            exact = await self._find_unnumbered(spec, progress_cb)
        else:
            duplicates = duplicate_invitation_numbers(before.names, spec.base_name)
            exact, original_name = await self._find_duplicate(spec, duplicates, progress_cb)
        await self._emit(progress_cb, "detail", f"{original_name} 상세 페이지 열기")
        await self._open_candidate(exact, original_name)
        self._name_edit_search_ready = False
        self._needs_list_reset = True
        await self._verify_detail_name(original_name)
        await self._open_edit_form()
        await self._fill_name(original_name, new_name)
        save = await self._save_button()
        await self._emit(progress_cb, "save", f"{original_name} → {new_name} 저장")
        await save.click()
        await self._wait_for_human_verification(progress_cb)
        await self._wait_after_save(new_name)

        after = None
        save_verified = False
        for verify_attempt in range(1, SAVE_VERIFY_SCANS + 1):
            after = await self.scan_group(spec, progress_cb)
            number_is_unique = invitation_number_count(after.names, spec.base_name, number) == 1
            total_is_stable = after.result_total == before.result_total
            if editing_unnumbered:
                target_was_updated = (
                    after.numbered_count >= before.numbered_count + 1
                    and after.unnumbered_count <= before.unnumbered_count - 1
                )
            else:
                target_was_updated = duplicate_invitation_count(
                    after.names, spec.base_name
                ) <= max(0, duplicate_count - 1)
            # A successful save must preserve the complete result set, add exactly one unique
            # suffix, and reduce the live remaining work. A partial page render is retried.
            if total_is_stable and number_is_unique and target_was_updated:
                save_verified = True
                break
            if verify_attempt < SAVE_VERIFY_SCANS:
                await self._emit(
                    progress_cb,
                    "verify",
                    f"저장 결과 재확인 {verify_attempt}/{SAVE_VERIFY_SCANS}",
                )
                await self._page.wait_for_timeout(1_500)
        if not save_verified:
            raise RenameVerifyFailedError(
                f"목록 재검색에서 새 이름을 확인하지 못했습니다: {new_name}"
            )
        return RenameOutcome(
            original_name=original_name,
            new_name=new_name,
            number=number,
            remaining_count=after.unnumbered_count
            + duplicate_invitation_count(after.names, spec.base_name),
            discovered_total=after.result_total,
            completed_count=after.result_total
            - after.unnumbered_count
            - duplicate_invitation_count(after.names, spec.base_name),
            snapshot=after,
        )

    async def _prepare_search(self, spec: InvitationNameEditSpec, progress_cb=None) -> None:
        self._check_cancel()
        # Always re-enter the list. TikTok can retain the previous pagination cursor even when
        # Enter is pressed with the same query, which would otherwise skip earlier result pages.
        await self._return_to_invitation_list()
        if selectors.is_affiliate_login_redirect(self._page.url):
            raise LoginRequiredError("TikTok 로그인이 만료되었습니다.")
        if not await self._select_invitation_tab("Ongoing"):
            raise SearchFailedError("Ongoing 탭을 선택하지 못했습니다.")
        search = await self._find_search()
        await self._emit(progress_cb, "search", f"{spec.search_query} 검색")
        await self._submit_name_search(search, spec.search_query)
        self._name_edit_search_ready = True

    async def _submit_name_search(self, search, query: str) -> None:
        """Submit a repeatable query after a fresh list load and wait for stable results."""
        await search.fill(query)
        if (await search.input_value()).strip() != query:
            raise SearchFailedError(f"검색어 입력에 실패했습니다: {query}")
        for attempt in range(2):
            await search.press("Enter")
            with contextlib.suppress(Exception):
                await self._page.wait_for_load_state("networkidle", timeout=2_500)
            last_signature = ""
            stable_samples = 0
            for _ in range(80):
                self._check_cancel()
                signature = await self._search_result_signature()
                folded = signature.casefold()
                settled = (
                    query.casefold() in folded
                    or "no results found" in folded
                    or "검색 결과가 없습니다" in folded
                    or "검색 결과 없음" in folded
                )
                if settled:
                    stable_samples = stable_samples + 1 if signature == last_signature else 1
                    if stable_samples >= 3:
                        return
                else:
                    stable_samples = 0
                last_signature = signature
                await self._page.wait_for_timeout(250)
            if attempt == 0:
                search = await self._find_search()
                await search.fill(query)
        raise SearchFailedError(f"검색 결과가 갱신되지 않았습니다: {query}")

    async def _names_on_current_page(self, base_name: str) -> list[str]:
        names: list[str] = []
        rows = self._page.locator("tbody tr")
        if await rows.count() == 0:
            rows = self._page.locator("[role='row']")
        for index in range(await rows.count()):
            row = rows.nth(index)
            if not await row.is_visible():
                continue
            text = (await row.inner_text()).strip()
            matches = invitation_names_from_text(text, base_name)
            if matches:
                names.append(matches[0])
        if names:
            return names
        body = await self._page.locator("body").inner_text()
        return list(invitation_names_from_text(body, base_name))

    async def _result_row_count_on_current_page(self, fallback_names: list[str]) -> int:
        """Count every visible invitation row returned by the Product_Date search."""
        rows = self._page.locator("table tbody tr")
        if await rows.count() == 0:
            rows = self._page.locator("[role='rowgroup'] [role='row']")
        count = 0
        for index in range(await rows.count()):
            row = rows.nth(index)
            if not await row.is_visible():
                continue
            cells = row.locator("td, [role='cell'], [role='gridcell']")
            if await cells.count() == 0:
                continue
            if (await row.inner_text()).strip():
                count += 1
        # Some TikTok releases render invitation cards instead of a semantic table. In that
        # layout each extracted invitation name corresponds to one visible search result.
        return count if count else len(fallback_names)

    async def _advance_scan_page(self, page_number: int, visible_name_count: int) -> bool:
        """Advance a 50-row result page, tolerating TikTok's late pagination mount."""
        before_signature = await self._search_result_signature()
        attempts = 20 if visible_name_count >= FULL_RESULT_PAGE_SIZE else 2
        for attempt in range(attempts):
            if await self._advance_next(self._page):
                return True

            # Some Seller Center builds expose only numbered page controls, without an
            # accessible Next label. Restrict the fallback to pagination containers so a count
            # elsewhere on the page can never be clicked.
            paginations = self._page.locator(
                "nav[aria-label*='pagination' i], ul[class*='pagination' i], "
                "[class*='pagination-wrapper' i], [class*='pagination-list' i]"
            )
            for index in range(await paginations.count()):
                pagination = paginations.nth(index)
                if not await pagination.is_visible():
                    continue
                target = pagination.get_by_text(str(page_number + 1), exact=True)
                for target_index in range(await target.count()):
                    page_button = target.nth(target_index)
                    if not await page_button.is_visible():
                        continue
                    classes = (await page_button.get_attribute("class")) or ""
                    if (
                        await page_button.is_disabled()
                        or (await page_button.get_attribute("aria-disabled")) == "true"
                        or "disabled" in classes.casefold()
                    ):
                        continue
                    await page_button.click(force=True)
                    for _ in range(40):
                        self._check_cancel()
                        await self._page.wait_for_timeout(250)
                        if await self._search_result_signature() != before_signature:
                            await self._page.wait_for_timeout(self._pagination_settle_timeout_ms)
                            return True
            if attempt + 1 < attempts:
                await self._page.wait_for_timeout(250)
        return False

    async def _find_unnumbered(self, spec: InvitationNameEditSpec, progress_cb=None):
        visited: set[str] = set()
        for page_number in range(1, MAX_SEARCH_PAGES + 1):
            self._check_cancel()
            await self._emit(progress_cb, "search", f"미번호 초대장 {page_number}페이지 확인", page_number)
            candidate = await self._visible_exact_invitation(spec.base_name)
            if candidate is None:
                candidate = await self._visible_unnumbered_row(spec.base_name)
            if candidate is not None:
                return candidate
            signature = await self._search_result_signature()
            if signature in visited:
                break
            visited.add(signature)
            page_row_count = await self._result_row_count_on_current_page([])
            if not await self._advance_scan_page(page_number, page_row_count):
                break
        raise SearchFailedError(f"이름을 변경할 미번호 초대장을 찾지 못했습니다: {spec.base_name}")

    async def _visible_unnumbered_row(self, base_name: str):
        """Find an unnumbered result by row when no exact standalone text node exists."""
        rows = self._page.locator("table tbody tr")
        if await rows.count() == 0:
            rows = self._page.locator("[role='rowgroup'] [role='row']")
        if await rows.count() == 0:
            rows = self._page.locator("[role='row']")
        for index in range(await rows.count()):
            row = rows.nth(index)
            if not await row.is_visible():
                continue
            if is_unnumbered_invitation_text(await row.inner_text(), base_name):
                return row
        return None

    async def _find_duplicate(self, spec, duplicate_numbers, progress_cb=None):
        if not duplicate_numbers:
            raise SearchFailedError(f"중복 번호 초대장을 찾을 수 없습니다: {spec.base_name}")
        visited: set[str] = set()
        for page_number in range(1, MAX_SEARCH_PAGES + 1):
            self._check_cancel()
            await self._emit(
                progress_cb,
                "search",
                f"중복 번호 초대장 {page_number}페이지 확인",
                page_number,
            )
            rows = self._page.locator("table tbody tr")
            if await rows.count() == 0:
                rows = self._page.locator("[role='rowgroup'] [role='row']")
            for index in range(await rows.count()):
                row = rows.nth(index)
                if not await row.is_visible():
                    continue
                for name in invitation_names_from_text(await row.inner_text(), spec.base_name):
                    number = invitation_number_for_base(name, spec.base_name)
                    if number in duplicate_numbers:
                        return row, name
            signature = await self._search_result_signature()
            if signature in visited:
                break
            visited.add(signature)
            page_row_count = await self._result_row_count_on_current_page([])
            if not await self._advance_scan_page(page_number, page_row_count):
                break
        raise SearchFailedError(f"중복 번호 초대장을 찾을 수 없습니다: {spec.base_name}")

    async def _verify_detail_name(self, requested: str) -> None:
        for _ in range(80):
            if selectors.is_affiliate_login_redirect(self._page.url):
                raise LoginRequiredError("TikTok 로그인이 만료되었습니다.")
            exact = self._page.get_by_text(requested, exact=True)
            if await self._any_visible(exact):
                return
            body = await self._page.locator("body").inner_text()
            if is_unnumbered_invitation_text(body, requested):
                return
            await self._page.wait_for_timeout(250)
        raise DetailFailedError(f"상세 페이지에서 초대장 이름을 확인하지 못했습니다: {requested}")

    async def _open_edit_form(self) -> None:
        pattern = re.compile(r"^\s*(Edit invitation|초대장 수정)\s*$", re.I)
        for _ in range(80):
            candidates = self._page.get_by_text(pattern)
            for index in range(await candidates.count()):
                node = candidates.nth(index)
                if not await node.is_visible():
                    continue
                clickable = node.locator("xpath=ancestor-or-self::*[self::button or self::a][1]")
                await (clickable.first if await clickable.count() else node).click()
                await self._page.wait_for_timeout(500)
                return
            await self._page.wait_for_timeout(250)
        raise EditButtonNotFoundError("상세 페이지에서 Edit invitation 버튼을 찾지 못했습니다.")

    async def _name_input(self, current_name: str):
        selectors_text = (
            'input[name*="invitation" i], input[aria-label*="Invitation name" i], '
            'input[placeholder*="Invitation name" i]'
        )
        for _ in range(80):
            # The edit form can contain other invitation-related inputs. The current exact value
            # is the strongest identity and prevents a date/search field from being selected.
            inputs = self._page.locator("input")
            for index in range(await inputs.count()):
                field = inputs.nth(index)
                if not await field.is_visible() or not await field.is_editable():
                    continue
                if (await field.input_value()).strip() == current_name:
                    return field
            labels = self._page.get_by_text(re.compile(r"^\s*(Invitation name|초대장 이름)\s*$", re.I))
            for index in range(await labels.count()):
                label = labels.nth(index)
                if not await label.is_visible():
                    continue
                field = label.locator(
                    "xpath=ancestor::*[self::label or self::div or self::section][.//input][1]//input"
                )
                if await field.count() and await field.first.is_visible() and await field.first.is_editable():
                    return field.first
            candidates = self._page.locator(selectors_text)
            for index in range(await candidates.count()):
                field = candidates.nth(index)
                if await field.is_visible() and await field.is_editable():
                    return field
            await self._page.wait_for_timeout(250)
        raise NameInputNotFoundError("Edit invitation 화면에서 Invitation name 입력칸을 찾지 못했습니다.")

    async def _fill_name(self, current_name: str, new_name: str) -> None:
        """Set a React-controlled name field with bounded fallback input methods."""
        for attempt in range(3):
            field = await self._name_input(current_name)
            await field.click()
            if attempt == 0:
                await field.fill(new_name)
            else:
                await field.press("Control+A")
                await field.type(new_name, delay=25)
            await self._page.wait_for_timeout(250)
            if (await field.input_value()).strip() == new_name:
                return
        raise NameInputNotFoundError("초대장 이름 입력값이 정확히 반영되지 않았습니다.")

    async def _save_button(self):
        buttons = self._page.get_by_role(
            "button", name=re.compile(r"^\s*(Save|Confirm|저장|확인)\s*$", re.I)
        )
        for _ in range(80):
            for index in range(await buttons.count()):
                button = buttons.nth(index)
                if await button.is_visible() and not await button.is_disabled():
                    return button
            await self._page.wait_for_timeout(250)
        raise SaveButtonNotFoundError("활성화된 Save 버튼을 찾지 못했습니다.")

    async def _wait_after_save(self, new_name: str) -> None:
        for _ in range(80):
            self._check_cancel()
            if selectors.is_affiliate_login_redirect(self._page.url):
                raise LoginRequiredError("TikTok 로그인이 만료되었습니다.")
            success = self._page.get_by_text(re.compile(r"success|saved|updated|저장.*완료", re.I))
            if await self._any_visible(success):
                return
            exact = self._page.get_by_text(new_name, exact=True)
            if await self._any_visible(exact):
                return
            await self._page.wait_for_timeout(250)
        # The list verification is authoritative; continue even if TikTok showed no toast.
