"""Shared TikTok human-verification detection and desktop notification."""

from __future__ import annotations

import asyncio
import ctypes
import os
import threading
from collections.abc import Awaitable, Callable

HUMAN_VERIFICATION_SELECTORS = (
    "#captcha-verify-image",
    "#captcha_container",
    ".captcha_verify_container",
    ".secsdk-captcha-drag-icon",
    "[class*='secsdk-captcha' i]",
    "iframe[src*='captcha' i]",
    "iframe[src*='verify' i]",
    "[class*='captcha_verify' i]",
    "[id^='captcha-verify' i]",
    "[id*='captcha_container' i]",
)

# These phrases are deliberately specific. Generic words such as "verification" occur in
# ordinary Seller Center pages and would incorrectly pause healthy jobs.
HUMAN_VERIFICATION_PHRASES = (
    "complete the puzzle",
    "drag the slider",
    "slide to fit",
    "verify to continue",
    "please complete the security check",
    "사람인지 확인",
    "퍼즐을 완성",
    "슬라이더를 드래그",
    "보안 인증을 완료",
)

VERIFICATION_PAUSED_MESSAGE = "틱톡샵 셀러센터 인증하세요. 자동화를 일시정지했습니다."
VERIFICATION_RESUMED_MESSAGE = "인증 완료를 확인했습니다. 자동화를 계속합니다."

VerificationCallback = Callable[[str, str, int, int], Awaitable[None] | None]

_alert_lock = threading.Lock()
_alert_open = False


def show_human_verification_alert() -> None:
    """Show one non-blocking, topmost Windows desktop alert."""
    global _alert_open
    if os.name != "nt":
        return
    with _alert_lock:
        if _alert_open:
            return
        _alert_open = True

    def show() -> None:
        global _alert_open
        try:
            # MB_OK | MB_ICONWARNING | MB_SETFOREGROUND | MB_TOPMOST
            flags = 0x00000000 | 0x00000030 | 0x00010000 | 0x00040000
            ctypes.windll.user32.MessageBoxW(
                None,
                "틱톡샵 셀러센터 인증하세요.",
                "TikTok Automation Alert",
                flags,
            )
        finally:
            with _alert_lock:
                _alert_open = False

    threading.Thread(target=show, name="tiktok-verification-alert", daemon=True).start()


async def _invoke_callback(callback, phase: str, message: str) -> None:
    if callback is None:
        return
    result = callback(phase, message, 0, 0)
    if asyncio.iscoroutine(result):
        await result


class HumanVerificationMixin:
    """Pause a browser workflow while a visible TikTok puzzle is present."""

    def _init_human_verification(self) -> None:
        self._human_verification_announced = False
        self._human_verification_callback: VerificationCallback | None = None

    def set_human_verification_callback(self, callback: VerificationCallback | None) -> None:
        self._human_verification_callback = callback

    async def _visible_human_verification(self):
        context = getattr(self, "_context", None)
        current_page = getattr(self, "_page", None)
        pages = []
        if current_page is not None:
            pages.append(current_page)
        if context is not None:
            for page in context.pages:
                if page not in pages:
                    pages.append(page)

        for page in pages:
            with_page = await self._visible_human_verification_on_page(page)
            if with_page is not None:
                return with_page
        return None

    async def _visible_human_verification_on_page(self, page):
        if page is None:
            return None
        try:
            if page.is_closed():
                return None
        except (AttributeError, TypeError):
            pass
        try:
            locator = page.locator(", ".join(HUMAN_VERIFICATION_SELECTORS)).first
            if await locator.count() > 0 and await locator.is_visible():
                return locator
        except Exception:  # noqa: BLE001 - unsupported/stale selectors are harmless
            pass
        try:
            body = page.locator("body")
            matches_phrase = await body.evaluate(
                "(node, phrases) => phrases.some(phrase => "
                "(node.innerText || '').toLowerCase().includes(phrase))",
                list(HUMAN_VERIFICATION_PHRASES),
            )
        except Exception:  # noqa: BLE001 - a navigating page may not have a body yet
            return None
        if matches_phrase:
            return body
        return None

    async def _human_verification_started(self, callback=None) -> None:
        self.security_challenge_active = True
        if self._human_verification_announced:
            return
        self._human_verification_announced = True
        show_human_verification_alert()
        await _invoke_callback(
            callback or self._human_verification_callback,
            "human_verification",
            VERIFICATION_PAUSED_MESSAGE,
        )

    async def _human_verification_completed(self, callback=None) -> None:
        self.security_challenge_active = False
        if not self._human_verification_announced:
            return
        self._human_verification_announced = False
        await _invoke_callback(
            callback or self._human_verification_callback,
            "human_verification_resolved",
            VERIFICATION_RESUMED_MESSAGE,
        )

    async def _wait_for_human_verification(self, callback=None) -> bool:
        """Wait indefinitely while a visible challenge remains, then resume in-place."""
        challenge = await self._visible_human_verification()
        if challenge is None:
            return False

        await self._human_verification_started(callback)
        clear_polls = 0
        while True:
            self._check_cancel()
            if await self._visible_human_verification() is None:
                clear_polls += 1
                if clear_polls >= 3:
                    await self._human_verification_completed(callback)
                    return True
            else:
                clear_polls = 0
            await asyncio.sleep(0.35)


async def await_with_human_verification_pause(
    awaitable,
    *,
    session,
    timeout_seconds: float,
):
    """Run an operation while excluding visible-puzzle time from its watchdog."""
    task = asyncio.create_task(awaitable)
    loop = asyncio.get_running_loop()
    deadline = loop.time() + timeout_seconds
    verification_was_active = False
    try:
        while True:
            done, _ = await asyncio.wait({task}, timeout=0.25)
            if done:
                return await task
            now = loop.time()
            if getattr(session, "security_challenge_active", False):
                verification_was_active = True
                deadline = now + timeout_seconds
            elif verification_was_active:
                verification_was_active = False
                deadline = now + timeout_seconds
            elif now >= deadline:
                raise TimeoutError(f"browser made no progress for {timeout_seconds:.0f}s")
    finally:
        if not task.done():
            task.cancel()
            try:
                await task
            except (asyncio.CancelledError, Exception):
                pass
