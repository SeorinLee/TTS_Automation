"""Target Invitation discovery and Creator details extraction."""

from __future__ import annotations

import asyncio
import contextlib
import re
from dataclasses import dataclass, field
from urllib.parse import parse_qsl, urlencode, urljoin, urlparse, urlunparse

from gmv.automation import selectors
from gmv.automation.human_verification import HumanVerificationMixin
from gmv.automation.invitation_acceptor_session import (
    InvitationAcceptError,
    InvitationNotFoundError,
    LoginRequiredError,
    MarketMismatchError,
    SearchFailedError,
)
from gmv.config import BrowserProfile, ProfileStatus
from gmv.invitation_acceptor import InvitationSpec, is_exact_invitation_match
from gmv.models import JobCancelledError

MAX_SEARCH_PAGES = 100
MAX_CREATOR_PAGES = 200
INVITATION_SEARCH_LIMIT = 10
INVITATION_SEARCH_TABS = ("Ongoing",)
TARGET_PATH = "/affiliate/collaboration/target-invitation"


class CreatorDetailsLoadError(InvitationAcceptError):
    error_code = "CREATOR_DETAILS_FAILED"


class InvitedCreatorsLoadError(InvitationAcceptError):
    error_code = "INVITED_CREATORS_FAILED"


class AddedProductsLoadError(InvitationAcceptError):
    error_code = "ADDED_PRODUCTS_FAILED"


class PostedContentLoadError(InvitationAcceptError):
    error_code = "POSTED_CONTENT_FAILED"


class SampleRequestsLoadError(InvitationAcceptError):
    error_code = "SAMPLE_REQUESTS_FAILED"


@dataclass(frozen=True)
class CreatorDetails:
    creator: str
    nickname: str = ""
    creator_id: str = ""
    region: str = ""
    added_products: bool = False
    posted_content: bool = False

    @property
    def identity(self) -> str:
        if self.creator_id.strip():
            return f"id:{self.creator_id.strip().casefold()}"
        return f"creator:{self.creator.strip().lstrip('@').casefold()}"

    @property
    def keys(self) -> set[str]:
        keys = {f"creator:{self.creator.strip().lstrip('@').casefold()}"}
        if self.creator_id.strip():
            keys.add(f"id:{self.creator_id.strip().casefold()}")
        return {key for key in keys if not key.endswith(":")}


@dataclass
class InvitationInspection:
    creators: list[CreatorDetails] = field(default_factory=list)
    added_creators: list[CreatorDetails] = field(default_factory=list)
    posted_creators: list[CreatorDetails] = field(default_factory=list)
    sample_creators: list[CreatorDetails] = field(default_factory=list)
    added_product_keys: set[str] = field(default_factory=set)
    posted_content_keys: set[str] = field(default_factory=set)
    sample_request_keys: set[str] = field(default_factory=set)
    status: str = "SUCCESS"
    message: str = "Creator details 추출 완료"


def merge_creator_pages(pages: list[list[CreatorDetails]]) -> list[CreatorDetails]:
    output: list[CreatorDetails] = []
    seen: set[str] = set()
    for creator in (item for page in pages for item in page):
        if not creator.creator.strip() or creator.identity in seen:
            continue
        seen.add(creator.identity)
        output.append(creator)
    return output


def creator_count_warning(expected_count: int | None, extracted_count: int) -> str | None:
    """Return a non-fatal warning when TikTok's badge and readable rows disagree."""
    if expected_count is None or extracted_count == 0 or expected_count == extracted_count:
        return None
    return f"경고: 카드 {expected_count} / 실제 {extracted_count}"


def inspect_json_for_creators(value) -> list[CreatorDetails]:
    """Read creator identity fields only from JSON responses observed on the live page."""
    output: list[CreatorDetails] = []
    stack = [value]
    while stack:
        item = stack.pop()
        if isinstance(item, list):
            stack.extend(item)
            continue
        if not isinstance(item, dict):
            continue
        folded = {re.sub(r"[^a-z0-9]", "", str(key).casefold()): child for key, child in item.items()}

        def first(keys, data=folded):
            for key in keys:
                candidate = data.get(key)
                if isinstance(candidate, (str, int)) and str(candidate).strip():
                    return str(candidate).strip()
            return ""

        creator = first(("uniqueid", "creatorusername", "username", "handle", "creatorname"))
        creator_id = first(("creatorid", "authorid", "userid", "uid"))
        nickname = first(("nickname", "displayname", "creatornickname"))
        region = first(("region", "regioncode", "countrycode", "market"))
        if creator and (creator_id or nickname):
            output.append(CreatorDetails(creator.lstrip("@"), nickname, creator_id, region))
        stack.extend(child for child in item.values() if isinstance(child, (dict, list)))
    return merge_creator_pages([output])


def creator_activity_flags(values: list[str]) -> tuple[bool, bool]:
    """Return added-product and posted-content flags from an invited-creator row."""
    counts: list[int] = []
    for value in values:
        match = re.fullmatch(
            r"\s*(\d+)\s*(?:products?|contents?|videos?|posts?)\s*",
            value,
            re.I,
        )
        if match:
            counts.append(int(match.group(1)))
    return (
        len(counts) >= 1 and counts[0] > 0,
        len(counts) >= 2 and counts[1] > 0,
    )


def creator_identity_lines(raw_values: list[str]) -> list[str]:
    """Return identity lines from the first populated table cell.

    Sample Requests prepends a zero-width expand cell and an invisible ``.`` timing marker
    before its creator cell. Creator details does not, so this normalization supports both tables.
    """
    for value in raw_values:
        lines = [
            line.strip()
            for line in value.splitlines()
            if line.strip() and not re.fullmatch(r"[^\w@]+", line.strip())
        ]
        if lines:
            return lines
    return []


def invitation_suffix_query(full_name: str, limit: int = INVITATION_SEARCH_LIMIT) -> str:
    """Build ``product-last-letter_date_number`` within TikTok's search limit."""
    normalized = full_name.strip()
    parts = normalized.rsplit("_", 3)
    if len(parts) == 4 and parts[1]:
        normalized = f"{parts[1][-1]}_{parts[2]}_{parts[3]}"
    return normalized[-limit:] if limit > 0 else ""


def is_invitation_suffix_match(text: str, suffix_query: str) -> bool:
    """Match the submitted suffix inside one rendered invitation name/card.

    TikTok can split an invitation name across nested spans, so the locator's ``inner_text``
    may contain whitespace even though the visible name is continuous. The suffix must still
    end at a non-name boundary so ``B_0707_22`` never accepts ``B_0707_220``.
    """
    normalized = (text or "").casefold()
    suffix = re.sub(r"\s+", "", suffix_query or "").casefold()
    flexible_suffix = r"\s*".join(re.escape(character) for character in suffix)
    return bool(suffix) and re.search(rf"{flexible_suffix}(?![a-z0-9_])", normalized) is not None


def invitation_tab_pattern(tab_name: str):
    """Match TikTok status tabs with or without their live result count."""
    return re.compile(rf"^\s*{re.escape(tab_name)}(?:\s*\(?\d+\)?)?\s*$", re.I)


def target_url_from_authenticated_page(
    profile: BrowserProfile,
    current_url: str,
    discovered_href: str = "",
) -> str:
    """Build the new collaboration route while preserving TikTok's real shop parameters."""
    candidate = urljoin(current_url, discovered_href) if discovered_href else current_url
    parsed = urlparse(candidate)
    host = parsed.netloc.casefold()
    if "affiliate" not in host:
        fallback = urlparse(profile.affiliate_entry_url)
        parsed = parsed._replace(scheme=fallback.scheme, netloc=fallback.netloc)
        host = parsed.netloc.casefold()
    if profile.market.upper() == "US" and host != "affiliate-us.tiktok.com":
        parsed = parsed._replace(scheme="https", netloc="affiliate-us.tiktok.com")
    elif profile.market.upper() == "UK" and ("affiliate" not in host or host == "affiliate-us.tiktok.com"):
        raise MarketMismatchError("로그인된 UK TikTok Affiliate origin을 확인할 수 없습니다.")
    query = dict(parse_qsl(parsed.query, keep_blank_values=True))
    query["shop_region"] = profile.shop_region
    query.setdefault("route_migration", "1")
    query["tab"] = "1"
    return urlunparse((parsed.scheme or "https", parsed.netloc, TARGET_PATH, "", urlencode(query), ""))


class TikTokInvitationInspectorSession(HumanVerificationMixin):
    """One job, one page: search exact invitations and extract three Creator detail tabs."""

    def __init__(self, profile: BrowserProfile, *, headless: bool = False, cancel_event=None):
        self.profile = profile
        self.headless = headless
        self.cancel_event = cancel_event
        self._pw = None
        self._context = None
        self._page = None
        self._return_page = None
        self._target_url = ""
        self._needs_list_reset = False
        self._network_creators: dict[str, CreatorDetails] = {}
        self.security_challenge_active = False
        self._init_human_verification()

    def _check_cancel(self) -> None:
        if self.cancel_event is not None and self.cancel_event.is_set():
            raise JobCancelledError

    async def start(self) -> ProfileStatus:
        from playwright.async_api import async_playwright

        self._check_cancel()
        self._pw = await async_playwright().start()
        self._context = await self._pw.chromium.launch_persistent_context(
            user_data_dir=self.profile.storage_root,
            channel=self.profile.browser_channel,
            headless=self.headless,
            chromium_sandbox=True,
        )
        self._context.on(
            "response",
            lambda response: asyncio.create_task(self._capture_response(response)),
        )
        self._page = self._context.pages[0] if self._context.pages else await self._context.new_page()
        await self._open_target_page()
        if selectors.is_affiliate_login_redirect(self._page.url):
            return ProfileStatus.LOGIN_REQUIRED
        self._verify_market()
        return ProfileStatus.CONNECTED

    async def close(self) -> None:
        if self._context is not None:
            with contextlib.suppress(Exception):
                await self._context.close()
        if self._pw is not None:
            with contextlib.suppress(Exception):
                await self._pw.stop()
        self._context = None
        self._pw = None
        self._page = None
        self._return_page = None

    async def _capture_response(self, response) -> None:
        with contextlib.suppress(Exception):
            content_type = (await response.header_value("content-type") or "").casefold()
            if "json" not in content_type:
                return
            for creator in inspect_json_for_creators(await response.json()):
                self._network_creators[creator.creator.casefold()] = creator

    def _verify_market(self) -> None:
        host = urlparse(self._page.url).netloc.casefold()
        if self.profile.market.upper() == "US" and host != "affiliate-us.tiktok.com":
            raise MarketMismatchError(f"US 작업이 다른 Market 페이지에서 열렸습니다: {host}")
        if self.profile.market.upper() == "UK" and ("affiliate" not in host or host == "affiliate-us.tiktok.com"):
            raise MarketMismatchError(f"UK 작업이 다른 Market 페이지에서 열렸습니다: {host}")

    async def _open_target_page(self) -> None:
        """Seller Affiliate landing -> authenticated Affiliate link -> new target route."""
        self._check_cancel()
        await self._page.goto(self.profile.login_success_url, wait_until="domcontentloaded")
        await self._wait_for_human_verification()
        if selectors.is_affiliate_login_redirect(self._page.url):
            return
        await self._page.wait_for_timeout(500)

        href = await self._target_href_from_page()
        if href:
            self._target_url = target_url_from_authenticated_page(
                self.profile, self._page.url, href
            )
        else:
            await self._page.goto(self.profile.affiliate_entry_url, wait_until="domcontentloaded")
            await self._wait_for_human_verification()
            if selectors.is_affiliate_login_redirect(self._page.url):
                return
            with contextlib.suppress(Exception):
                await self._page.wait_for_url(
                    "**/affiliate/collaboration/target-invitation**", timeout=5_000
                )
            await self._page.wait_for_timeout(500)
            href = await self._target_href_from_page()
            self._target_url = target_url_from_authenticated_page(
                self.profile, self._page.url, href
            )
        await self._page.goto(self._target_url, wait_until="domcontentloaded")
        await self._wait_for_human_verification()
        # The collaboration bundle often renders several seconds after DOMContentLoaded.
        # A cloned profile has a cold cache, so the former 700 ms delay could reach the
        # search lookup while the page still contained only TikTok's loading shell.
        with contextlib.suppress(Exception):
            await self._page.wait_for_load_state("networkidle", timeout=15_000)
        await self._page.wait_for_timeout(1_000)
        if selectors.is_affiliate_login_redirect(self._page.url):
            return
        await self._dismiss_tour_overlay()
        self._verify_market()

    async def _dismiss_tour_overlay(self) -> None:
        """TikTok's Reactour coach-mark can cover tabs without changing account data."""
        with contextlib.suppress(Exception):
            await self._page.keyboard.press("Escape")
        with contextlib.suppress(Exception):
            await self._page.evaluate(
                "document.querySelector('#___reactour')?.remove()"
            )

    async def _target_href_from_page(self) -> str:
        for scope in self._scopes():
            links = scope.locator(
                'a[href*="/affiliate/collaboration/target-invitation"], '
                'a[href*="target-invitation"]'
            )
            for index in range(await links.count()):
                link = links.nth(index)
                if await link.is_visible():
                    return (await link.get_attribute("href")) or ""
        return ""

    def _scopes(self):
        # The current collaboration UI renders in the main document. TikTok also creates short-
        # lived helper frames during navigation; querying those can race with frame detachment.
        return [self._page]

    async def inspect_invitation(self, spec: InvitationSpec, progress_cb=None) -> InvitationInspection:
        self._check_cancel()
        if self._needs_list_reset:
            await self._return_to_invitation_list()
        elif TARGET_PATH not in urlparse(self._page.url).path:
            await self._open_target_page()
        if selectors.is_affiliate_login_redirect(self._page.url):
            raise LoginRequiredError("TikTok 로그인이 만료되었습니다.")
        await self._emit(progress_cb, "search", f"{spec.product} 검색 시작")
        exact = await self._find_exact_invitation(spec, progress_cb)
        await self._emit(progress_cb, "detail", f"{spec.full_name} Exact Match · 상세 페이지")
        await self._open_candidate(exact, spec.full_name)
        self._needs_list_reset = True
        scope = await self._open_creator_details(spec.full_name)

        invited, invited_count_warning = await self._collect_tab(
            scope, "Invited creators", InvitedCreatorsLoadError, progress_cb
        )
        # The Invited creators table already contains per-creator product and content counts.
        # Reading those two columns directly avoids racing TikTok's radio-card filters and keeps
        # the O markers tied to the exact invited row/Creator ID.
        added = [creator for creator in invited if creator.added_products]
        posted = [creator for creator in invited if creator.posted_content]
        added_keys = {key for creator in added for key in creator.keys}
        posted_keys = {key for creator in posted for key in creator.keys}
        sample_warning = None
        try:
            samples = await self._collect_sample_requests(progress_cb)
        except (JobCancelledError, LoginRequiredError, MarketMismatchError):
            raise
        except Exception as exc:  # keep Creator details when TikTok's sample page is unavailable
            samples = []
            sample_warning = f"Sample Requests 조회 실패: {str(exc)[:240]}"
            await self._emit(progress_cb, "warning", sample_warning)
        sample_keys = {key for creator in samples for key in creator.keys}
        await self._emit(
            progress_cb,
            "complete",
            f"Invited {len(invited)}명 · Added products {len(added)}명 · "
            f"Posted content {len(posted)}명 · Sample sent {len(samples)}명",
        )
        await self._return_to_invitation_list()
        await self._emit(progress_cb, "return", "Ongoing 초대장 목록으로 복귀")
        result_message = f"Invited creators {len(invited)}명 추출 완료"
        if invited_count_warning:
            result_message = f"{result_message} · {invited_count_warning}"
        if sample_warning:
            result_message = f"{result_message} · 경고: {sample_warning}"
        return InvitationInspection(
            creators=invited,
            added_creators=added,
            posted_creators=posted,
            sample_creators=samples,
            added_product_keys=added_keys,
            posted_content_keys=posted_keys,
            sample_request_keys=sample_keys,
            message=result_message,
        )

    async def _find_search(self):
        await self._wait_for_human_verification()
        selectors_text = (
            'input[placeholder="Search invitation by name" i], '
            'input[placeholder*="Search invitation" i], '
            'input[placeholder*="Invitation" i], input[placeholder*="초대"], '
            'input[aria-label*="Invitation" i], input[type="search"]'
        )
        fallback = None
        # Target Invitation is a large client-rendered page. Allow a cold disposable profile
        # up to 30 seconds to finish rendering before classifying the lookup as SEARCH_FAILED.
        for _ in range(120):
            self._check_cancel()
            for scope in self._scopes():
                candidates = scope.locator(selectors_text)
                for index in range(await candidates.count()):
                    candidate = candidates.nth(index)
                    if await candidate.is_visible() and await candidate.is_editable():
                        return candidate
                textboxes = scope.get_by_role("textbox")
                for index in range(await textboxes.count()):
                    candidate = textboxes.nth(index)
                    placeholder = (await candidate.get_attribute("placeholder")) or ""
                    if (
                        await candidate.is_visible()
                        and await candidate.is_editable()
                        and "creator's username" not in placeholder.casefold()
                    ):
                        fallback = fallback or candidate
            await self._page.wait_for_timeout(250)
        if fallback is not None:
            return fallback
        raise SearchFailedError(f"Target Invitation 검색창을 찾지 못했습니다: {self._page.url}")

    async def _find_exact_invitation(self, spec: InvitationSpec, progress_cb):
        for tab_name in INVITATION_SEARCH_TABS:
            tab_found = await self._select_invitation_tab(tab_name)
            if not tab_found:
                raise SearchFailedError("Ongoing 탭을 선택하지 못했습니다.")
            search = await self._find_search()
            await self._submit_invitation_search(search, spec.product, spec.full_name)
            visited: set[str] = set()
            for page_number in range(1, MAX_SEARCH_PAGES + 1):
                self._check_cancel()
                await self._emit(
                    progress_cb,
                    "search",
                    f"{tab_name} · Search Page {page_number} 확인",
                    page_number,
                )
                exact = await self._visible_exact_invitation(spec.full_name)
                if exact is not None:
                    return exact
                # Invitation cards are near the top of the document while pagination and
                # fixed footer text occupy the tail. Comparing only the last 4,000 characters
                # therefore treated different result pages as duplicates and stopped early.
                signature = " ".join(
                    (await self._page.locator("body").inner_text()).split()
                )
                if signature in visited:
                    break
                visited.add(signature)
                if not await self._advance_next(self._page):
                    break
        # TikTok's broad invitation-name search is eventually consistent and can return a
        # different subset/page count for the same product keyword. The search input accepts at
        # most 10 characters, so retry with product-last-letter/date/number (for example
        # A_0814_59), while
        # still requiring the complete invitation name to match before opening a result.
        suffix_query = invitation_suffix_query(spec.full_name)
        for tab_name in INVITATION_SEARCH_TABS:
            tab_found = await self._select_invitation_tab(tab_name)
            if not tab_found:
                raise SearchFailedError("보조 검색 전에 Ongoing 탭을 선택하지 못했습니다.")
            search = await self._find_search()
            await self._emit(
                progress_cb,
                "search",
                f"{suffix_query} 보조 검색 · Enter 제출 후 초대장 확인",
            )
            await self._submit_invitation_search(search, suffix_query, spec.full_name)
            visited: set[str] = set()
            for page_number in range(1, MAX_SEARCH_PAGES + 1):
                self._check_cancel()
                await self._emit(
                    progress_cb,
                    "search",
                    f"{tab_name} · Suffix {suffix_query} · Search Page {page_number}",
                    page_number,
                )
                candidate = await self._visible_exact_invitation(spec.full_name)
                matched_by = "전체 이름"
                if candidate is None:
                    candidate = await self._visible_suffix_invitation(suffix_query)
                    matched_by = f"마지막 검색어 {suffix_query}"
                if candidate is not None:
                    await self._emit(
                        progress_cb,
                        "search",
                        f"{matched_by} 일치 · {spec.full_name} 초대장 상세 열기",
                        page_number,
                    )
                    return candidate
                signature = " ".join(
                    (await self._page.locator("body").inner_text()).split()
                )
                if signature in visited:
                    break
                visited.add(signature)
                if not await self._advance_next(self._page):
                    break
        raise InvitationNotFoundError(
            f"{spec.product} 전체 페이지와 {suffix_query} 10자 제한 보조 검색에서도 "
            f"정확한 초대장을 찾지 못했습니다: {spec.full_name}"
        )

    async def _visible_exact_invitation(self, requested: str):
        """Return only a visible, full-name exact invitation from the current result page."""
        for scope in self._scopes():
            exact = scope.get_by_text(requested, exact=True)
            for index in range(await exact.count()):
                node = exact.nth(index)
                if not await node.is_visible():
                    continue
                actual = (await node.inner_text()).strip()
                if is_exact_invitation_match(actual, requested):
                    return node
        return None

    async def _visible_suffix_invitation(self, suffix_query: str, scope=None):
        """Return a visible result whose rendered name/card contains the submitted suffix."""
        scopes = [scope] if scope is not None else self._scopes()
        for current_scope in scopes:
            candidates = current_scope.get_by_text(suffix_query, exact=False)
            for index in range(await candidates.count()):
                node = candidates.nth(index)
                if not await node.is_visible():
                    continue
                actual = (await node.inner_text()).strip()
                if is_invitation_suffix_match(actual, suffix_query):
                    return node
        return None

    async def _search_result_signature(self) -> str:
        """Return visible page text; an input's typed value is not part of ``inner_text``."""
        return " ".join((await self._page.locator("body").inner_text()).split())

    async def _submit_invitation_search(self, search, query: str, requested: str) -> None:
        """Press Enter and wait until TikTok has replaced and settled the result surface.

        TikTok can leave the previous search page visible while the suffix request is in flight.
        Merely sleeping, or observing an unrelated JSON response, can therefore make the job
        inspect the stale last page and close.  We require either the exact invitation to become
        visible or the visible result DOM to change and remain stable.  If neither happens, Enter
        is retried once instead of silently treating the invitation as absent.
        """
        previous_signature = await self._search_result_signature()
        await search.fill(query)
        if (await search.input_value()).strip() != query:
            raise SearchFailedError(f"검색어 입력에 실패했습니다: {query}")

        for attempt in range(2):
            await search.press("Enter")
            with contextlib.suppress(Exception):
                await self._page.wait_for_load_state("networkidle", timeout=15_000)

            last_signature = ""
            stable_samples = 0
            query_key = query.casefold()
            for _ in range(80):
                self._check_cancel()
                if await self._visible_exact_invitation(requested) is not None:
                    return
                signature = await self._search_result_signature()
                folded = signature.casefold()
                result_content_visible = (
                    query_key in folded
                    or "no results found" in folded
                    or "검색 결과가 없습니다" in folded
                )
                if signature != previous_signature and result_content_visible:
                    stable_samples = stable_samples + 1 if signature == last_signature else 1
                    # Three equal samples ensure cards (or the final no-results message) have
                    # settled. A generic changed/loading DOM is never accepted as a result.
                    if stable_samples >= 3:
                        return
                else:
                    stable_samples = 0
                last_signature = signature
                await self._page.wait_for_timeout(250)

            if attempt == 0:
                # Reacquire the SPA input before retrying because the first Enter can rerender it.
                search = await self._find_search()
                await search.fill(query)
                if (await search.input_value()).strip() != query:
                    raise SearchFailedError(f"보조 검색어 재입력에 실패했습니다: {query}")

        raise SearchFailedError(
            f"Enter 제출 뒤 검색 결과가 갱신되지 않아 초대장 확인을 중단했습니다: {query}"
        )

    async def _select_invitation_tab(self, tab_name: str) -> bool:
        pattern = invitation_tab_pattern(tab_name)
        # A cold cloned profile can show the page shell before status tabs render. Wait up to
        # 30 seconds and accept labels such as "Ongoing 1" as well as plain "Ongoing".
        for _ in range(120):
            self._check_cancel()
            for scope in self._scopes():
                candidates = scope.get_by_text(pattern)
                for index in range(await candidates.count()):
                    candidate = candidates.nth(index)
                    if await candidate.is_visible():
                        await self._dismiss_tour_overlay()
                        clickable = candidate.locator(
                            "xpath=ancestor-or-self::*[@role='tab' or contains(@class,'tab')][1]"
                        )
                        if await clickable.count():
                            await clickable.click(force=True)
                        else:
                            await candidate.click(force=True)
                        await self._page.wait_for_timeout(750)
                        return True
            await self._page.wait_for_timeout(250)
        return False

    async def _open_candidate(self, exact_node, requested: str) -> None:
        actual = (await exact_node.inner_text()).strip()
        row = exact_node.locator(
            "xpath=ancestor-or-self::*[self::tr or @role='row' or contains(@class,'card')][1]"
        )
        candidate_text = (await row.inner_text()).strip() if await row.count() else actual
        suffix_query = invitation_suffix_query(requested)
        if not is_exact_invitation_match(actual, requested) and not is_invitation_suffix_match(
            candidate_text, suffix_query
        ):
            raise InvitationNotFoundError(
                f"검색 결과가 전체 초대장명 또는 마지막 검색어와 일치하지 않습니다: {suffix_query}"
            )
        previous_page = self._page
        previous_pages = list(self._context.pages) if self._context is not None else []
        if await row.count():
            actions = row.get_by_role("button", name=re.compile(r"View|Details|보기|상세", re.I))
            if await actions.count() and await actions.first.is_visible():
                await actions.first.click()
            else:
                await exact_node.click()
        else:
            await exact_node.click()
        with contextlib.suppress(Exception):
            await previous_page.wait_for_timeout(500)
        await self._adopt_opened_detail_page(previous_pages, previous_page)

    async def _adopt_opened_detail_page(self, previous_pages, previous_page) -> bool:
        """Follow Edge when an invitation detail click opens a new browser tab."""
        if self._context is None:
            return False
        for attempt in range(20):
            opened_pages = [
                page
                for page in self._context.pages
                if page not in previous_pages and not page.is_closed()
            ]
            if opened_pages:
                detail_page = opened_pages[-1]
                self._return_page = previous_page
                self._page = detail_page
                detail_page.on(
                    "response",
                    lambda response: asyncio.create_task(self._capture_response(response)),
                )
                with contextlib.suppress(Exception):
                    await detail_page.bring_to_front()
                for _ in range(50):
                    if detail_page.url and detail_page.url != "about:blank":
                        break
                    await asyncio.sleep(0.1)
                with contextlib.suppress(Exception):
                    await detail_page.wait_for_load_state("domcontentloaded", timeout=15_000)
                with contextlib.suppress(Exception):
                    await detail_page.wait_for_load_state("networkidle", timeout=15_000)
                await detail_page.wait_for_timeout(500)
                await self._wait_for_human_verification()
                if selectors.is_affiliate_login_redirect(detail_page.url):
                    raise LoginRequiredError("TikTok 로그인이 만료되었습니다.")
                self._verify_market()
                return True
            with contextlib.suppress(Exception):
                details = previous_page.get_by_text("Creator details", exact=False)
                if await self._any_visible(details):
                    return False
            if attempt < 19:
                await asyncio.sleep(0.1)
        return False

    async def _open_creator_details(self, requested: str):
        suffix_query = invitation_suffix_query(requested)
        for _ in range(60):
            scope = await self._detail_scope()
            exact = scope.get_by_text(requested, exact=True)
            invitation_confirmed = await self._any_visible(exact)
            if not invitation_confirmed:
                invitation_confirmed = (
                    await self._visible_suffix_invitation(suffix_query, scope) is not None
                )
            details = scope.get_by_text("Creator details", exact=False)
            if not await self._any_visible(details):
                details = self._page.get_by_text("Creator details", exact=False)
            if invitation_confirmed and await self._any_visible(details):
                for index in range(await details.count()):
                    node = details.nth(index)
                    if await node.is_visible():
                        await node.click()
                        await self._page.wait_for_timeout(400)
                        return await self._detail_scope()
            await self._page.wait_for_timeout(250)
        raise CreatorDetailsLoadError(
            f"상세 페이지에서 전체 초대장명 또는 마지막 검색어를 확인하지 못했습니다: {suffix_query}"
        )

    async def _detail_scope(self):
        # The current TikTok UI expands Creator details inline as a core-collapse item rather
        # than a dialog/drawer. Scope extraction to that item so the invitation list's own
        # table rows and pagination controls are never mistaken for Creator-detail controls.
        summaries = self._page.get_by_text("Invited creators", exact=True)
        for index in range(await summaries.count()):
            summary = summaries.nth(index)
            if not await summary.is_visible():
                continue
            collapse = summary.locator(
                "xpath=ancestor::*[contains(@class,'core-collapse-item')][1]"
            )
            if await collapse.count():
                return collapse
        for frame in reversed(self._scopes()):
            scopes = frame.locator(
                '[role="dialog"]:visible, [class*="drawer" i]:visible, '
                '[class*="modal" i]:visible'
            )
            if await scopes.count():
                return scopes.last
        return self._page

    async def _collect_tab(self, scope, tab_name: str, error_type, progress_cb):
        # Match the tab label (optionally followed by its count), not explanatory copy such as
        # "Share your contact info so invited creators can ..." elsewhere in the drawer.
        tab_label = re.compile(
            rf"^\s*{re.escape(tab_name)}(?:\s*\(\s*\d+\s*\)|\s+\d+)?\s*$",
            re.I,
        )
        tabs = scope.get_by_text(tab_label)
        if not await self._any_visible(tabs):
            raise error_type(f"{tab_name} 탭을 찾지 못했습니다.")
        await self._dismiss_tour_overlay()
        before_rows = tuple(item.identity for item in await self._creator_rows(scope))
        expected_count = None
        selected_control = None
        selected_input = None
        for index in range(await tabs.count()):
            tab = tabs.nth(index)
            if await tab.is_visible():
                clickable = tab.locator(
                    "xpath=ancestor-or-self::*[self::label[contains(@class,'core-radio')] "
                    "or @role='radio' or @role='tab' or contains(@class,'tab')][1]"
                )
                if await clickable.count():
                    selected_control = clickable
                    control_text = (await clickable.inner_text()).strip()
                    count_match = re.search(r"\b\d+\b", control_text)
                    expected_count = int(count_match.group(0)) if count_match else None
                    radio = clickable.locator('input[type="radio"]')
                    if await radio.count():
                        selected_input = radio.first
                        await selected_input.evaluate("element => element.click()")
                    else:
                        await clickable.click(force=True)
                else:
                    await tab.click(force=True)
                break
        # Clicking a Creator-details tab starts an XHR while the previous tab's rows stay in
        # the DOM. Reading after a fixed 400 ms occasionally captured those stale rows (for
        # example the four creators on page 2 of Invited creators) as the next tab's result.
        with contextlib.suppress(Exception):
            await self._page.wait_for_load_state("networkidle", timeout=10_000)
        if selected_control is not None:
            for _ in range(60):
                classes = (await selected_control.get_attribute("class")) or ""
                checked = (await selected_control.get_attribute("aria-checked")) == "true"
                input_checked = selected_input is not None and await selected_input.is_checked()
                if input_checked or checked or "core-radio-checked" in classes:
                    break
                await self._page.wait_for_timeout(250)
        if expected_count is not None:
            expected_first_page = min(expected_count, 20)
            for _ in range(80):
                current_rows = await self._creator_rows(scope)
                if len(current_rows) == expected_first_page:
                    break
                await self._page.wait_for_timeout(250)
        elif tab_name != "Invited creators":
            for _ in range(60):
                current_rows = tuple(item.identity for item in await self._creator_rows(scope))
                if current_rows and current_rows != before_rows:
                    break
                await self._page.wait_for_timeout(250)
        await self._page.wait_for_timeout(500)
        await self._emit(progress_cb, "creators", f"{tab_name} 추출 시작")
        creators = await self._collect_creator_pages(
            scope,
            tab_name,
            progress_cb,
            phase="creators",
        )
        if expected_count and not creators:
            raise error_type(
                f"{tab_name} rows were not loaded: card={expected_count}, extracted=0"
            )
        count_warning = creator_count_warning(expected_count, len(creators))
        if count_warning:
            await self._emit(
                progress_cb,
                "warning",
                f"{tab_name} 수량 불일치 · {count_warning} · 실제 추출 결과를 저장합니다.",
            )
        return creators, count_warning

    async def _collect_sample_requests(self, progress_cb) -> list[CreatorDetails]:
        """Open the invitation's Sample Requests page and collect every creator row."""
        link = await self._sample_requests_link()
        if link is None:
            await self._emit(
                progress_cb,
                "samples",
                "Sample Requests 0명 · Free samples 미사용 또는 요청 없음",
            )
            return []

        detail_page = self._page
        detail_url = detail_page.url
        previous_pages = list(self._context.pages) if self._context is not None else []
        sample_page = detail_page
        await self._emit(progress_cb, "samples", "View sample requests 열기")

        try:
            await link.click(force=True)
            heading_pattern = re.compile(r"^\s*Sample Requests\s*$", re.I)
            ready = False
            for _ in range(120):
                self._check_cancel()
                candidates = []
                if self._context is not None:
                    candidates.extend(
                        page
                        for page in reversed(self._context.pages)
                        if page not in previous_pages and not page.is_closed()
                    )
                if not detail_page.is_closed():
                    candidates.append(detail_page)
                for candidate in candidates:
                    # The detail sidebar also contains "Sample requests". Only trust that text
                    # after navigation moved to another page/URL, or when the sample table header
                    # itself is visible in an in-place view.
                    navigated = candidate is not detail_page or candidate.url != detail_url
                    table_header = candidate.get_by_text(
                        re.compile(r"^\s*Sample score\s*$", re.I)
                    )
                    if not navigated and not await self._any_visible(table_header):
                        continue
                    headings = candidate.get_by_text(heading_pattern)
                    if await self._any_visible(headings):
                        sample_page = candidate
                        ready = True
                        break
                if ready:
                    break
                await asyncio.sleep(0.25)
            if not ready:
                raise SampleRequestsLoadError("Sample Requests 페이지를 확인하지 못했습니다.")

            self._page = sample_page
            if sample_page is not detail_page:
                sample_page.on(
                    "response",
                    lambda response: asyncio.create_task(self._capture_response(response)),
                )
                with contextlib.suppress(Exception):
                    await sample_page.bring_to_front()
            with contextlib.suppress(Exception):
                await sample_page.wait_for_load_state("networkidle", timeout=15_000)
            await sample_page.wait_for_timeout(1_000)
            await self._wait_for_human_verification(progress_cb)
            if selectors.is_affiliate_login_redirect(sample_page.url):
                raise LoginRequiredError("TikTok 로그인이 만료되었습니다.")

            creators = await self._collect_creator_pages(
                sample_page,
                "Sample Requests",
                progress_cb,
                phase="samples",
            )
            await self._emit(
                progress_cb,
                "samples",
                f"Sample Requests {len(creators)}명 추출 완료",
            )
            return creators
        finally:
            self._page = detail_page
            if self._context is not None:
                opened_pages = [
                    page for page in self._context.pages if page not in previous_pages
                ]
                for opened_page in opened_pages:
                    if not opened_page.is_closed():
                        with contextlib.suppress(Exception):
                            await opened_page.close()
            if not detail_page.is_closed():
                with contextlib.suppress(Exception):
                    await detail_page.bring_to_front()

    async def _sample_requests_link(self):
        """Expand Free samples details when needed and return its request-list action."""
        link_pattern = re.compile(r"^\s*View sample requests\s*$", re.I)
        for attempt in range(3):
            links = self._page.get_by_text(link_pattern)
            for index in range(await links.count()):
                link = links.nth(index)
                if await link.is_visible():
                    click_target = link.locator(
                        "xpath=ancestor-or-self::*[self::a or self::button or "
                        "@role='link' or @tabindex][1]"
                    )
                    if await click_target.count() and await click_target.first.is_visible():
                        return click_target.first
                    return link
            if attempt == 0:
                headings = self._page.get_by_text(
                    re.compile(r"^\s*Free samples details\s*$", re.I)
                )
                for index in range(await headings.count()):
                    heading = headings.nth(index)
                    if await heading.is_visible():
                        with contextlib.suppress(Exception):
                            await heading.click(force=True)
                        break
            await self._page.wait_for_timeout(350)
        return None

    async def _collect_creator_pages(
        self,
        scope,
        label: str,
        progress_cb,
        *,
        phase: str,
    ) -> list[CreatorDetails]:
        pages: list[list[CreatorDetails]] = []
        visited: set[tuple[str, ...]] = set()
        for page_number in range(1, MAX_CREATOR_PAGES + 1):
            self._check_cancel()
            current = await self._creator_rows(scope)
            signature = tuple(item.identity for item in current)
            if signature in visited:
                break
            visited.add(signature)
            pages.append(current)
            await self._emit(
                progress_cb,
                phase,
                f"{label} Page {page_number} · {len(current)}명",
                page_number,
            )
            if not await self._advance_next(scope):
                break
            await self._page.wait_for_timeout(350)
        return merge_creator_pages(pages)

    async def _creator_rows(self, scope) -> list[CreatorDetails]:
        rows = scope.locator("table tbody tr, [role='rowgroup'] [role='row']")
        output: list[CreatorDetails] = []
        for index in range(await rows.count()):
            row = rows.nth(index)
            if not await row.is_visible():
                continue
            cells = row.locator("td, [role='cell'], [role='gridcell']")
            raw_values = [
                (await cells.nth(cell).inner_text()).strip()
                for cell in range(await cells.count())
            ]
            values = [" ".join(value.split()) for value in raw_values]
            if not values:
                continue
            creator_node = row.locator(
                '[data-username], a[href*="tiktok.com/@"], a[href*="/creator/"], '
                '[class*="username" i], [class*="creator-name" i]'
            )
            creator = ""
            for node_index in range(await creator_node.count()):
                node = creator_node.nth(node_index)
                if not await node.is_visible():
                    continue
                creator = (await node.get_attribute("data-username")) or ""
                href = (await node.get_attribute("href")) or ""
                if not creator and href:
                    href_match = re.search(r"(?:/@|/creator/)([^/?#]+)", href, re.I)
                    creator = href_match.group(1) if href_match else ""
                if not creator:
                    node_lines = [
                        line.strip()
                        for line in (await node.inner_text()).splitlines()
                        if line.strip()
                    ]
                    creator = node_lines[0] if node_lines else ""
                if creator:
                    break
            first_lines = creator_identity_lines(raw_values)
            creator = creator.strip().lstrip("@") or (first_lines[0] if first_lines else "")
            row_text = " | ".join(values)
            creator_id_match = re.search(r"\b\d{8,}\b", row_text)
            creator_id = creator_id_match.group(0) if creator_id_match else ""
            region = next(
                (value for value in values if re.fullmatch(r"US|UK|GB|CA|AU|DE|FR|IT|ES", value, re.I)),
                self.profile.market,
            )
            nickname = first_lines[1] if len(first_lines) > 1 else ""
            for value in values[1:]:
                if not nickname and value != creator_id and value.casefold() != region.casefold():
                    nickname = value
                    break
            network = self._network_creators.get(creator.casefold())
            if network is not None:
                nickname = network.nickname or nickname
                creator_id = network.creator_id or creator_id
                region = network.region or region
            added_products, posted_content = creator_activity_flags(values[1:])
            if creator and not re.fullmatch(r"Creators?|Nickname|Creator ID|Region", creator, re.I):
                output.append(
                    CreatorDetails(
                        creator,
                        nickname,
                        creator_id,
                        region.upper(),
                        added_products,
                        posted_content,
                    )
                )
        return merge_creator_pages([output])

    async def _advance_next(self, scope) -> bool:
        candidates = scope.locator(
            'li.core-pagination-item-next, li[aria-label="Next" i], '
            '[class*="pagination-item-next" i]'
        )
        if await candidates.count() == 0:
            candidates = scope.locator(
                'button[aria-label="Next" i], li[title*="next" i], '
                '[class*="pagination-next" i] button'
            )
        if await candidates.count() == 0:
            candidates = scope.get_by_role("button", name=re.compile(r"^(Next|다음|>)$", re.I))
        for index in range(await candidates.count()):
            button = candidates.nth(index)
            if not await button.is_visible():
                continue
            classes = (await button.get_attribute("class")) or ""
            if (
                await button.is_disabled()
                or (await button.get_attribute("aria-disabled")) == "true"
                or "disabled" in classes.casefold()
            ):
                continue
            pagination = button.locator(
                "xpath=ancestor::*[contains(@class,'pagination')][1]"
            )
            before_page = ""
            if await pagination.count():
                active = pagination.locator(
                    '[aria-current="true"], [class*="pagination-item-active" i]'
                )
                if await active.count():
                    before_page = (await active.first.inner_text()).strip()
            # Core pagination puts the action handler on a nested button in some releases and
            # on the LI wrapper in others. Prefer the real button when present.
            click_target = button.locator("button")
            if await click_target.count() and await click_target.first.is_visible():
                await click_target.first.click(force=True)
            else:
                await button.click(force=True)
            if before_page and await pagination.count():
                for _ in range(40):
                    active = pagination.locator(
                        '[aria-current="true"], [class*="pagination-item-active" i]'
                    )
                    if await active.count():
                        current_page = (await active.first.inner_text()).strip()
                        if current_page and current_page != before_page:
                            break
                    await self._page.wait_for_timeout(250)
            # The active page number changes before the invitation cards finish swapping.
            await self._page.wait_for_timeout(
                getattr(self, "_pagination_settle_timeout_ms", 1_500)
            )
            return True
        return False

    async def _return_to_invitation_list(self) -> None:
        """Leave a successful detail view and restore the Target Invitation search list."""
        self._check_cancel()
        return_page = self._return_page
        if (
            return_page is not None
            and return_page is not self._page
            and not return_page.is_closed()
        ):
            detail_page = self._page
            self._page = return_page
            self._return_page = None
            if detail_page is not None and not detail_page.is_closed():
                with contextlib.suppress(Exception):
                    await detail_page.close()
        else:
            self._return_page = None
        target_url = self._target_url or target_url_from_authenticated_page(
            self.profile,
            self.profile.affiliate_entry_url,
        )
        await self._page.goto(target_url, wait_until="domcontentloaded")
        await self._wait_for_human_verification()
        with contextlib.suppress(Exception):
            await self._page.wait_for_load_state(
                "networkidle",
                timeout=getattr(self, "_list_network_idle_timeout_ms", 15_000),
            )
        await self._page.wait_for_timeout(getattr(self, "_list_settle_timeout_ms", 1_000))
        if selectors.is_affiliate_login_redirect(self._page.url):
            raise LoginRequiredError("TikTok 로그인이 만료되었습니다.")
        await self._dismiss_tour_overlay()
        self._verify_market()
        # Do not report the prior invitation as complete until the next-search surface exists.
        await self._find_search()
        self._needs_list_reset = False

    async def _emit(self, callback, phase: str, message: str, page: int = 0) -> None:
        await self._wait_for_human_verification(callback)
        if callback is None:
            return
        result = callback(phase, message, page, 0)
        if hasattr(result, "__await__"):
            await result

    async def _any_visible(self, locator) -> bool:
        for index in range(await locator.count()):
            if await locator.nth(index).is_visible():
                return True
        return False
