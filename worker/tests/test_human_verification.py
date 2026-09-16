import asyncio

from gmv.automation.human_verification import HumanVerificationMixin


class FakeLocator:
    def __init__(self, page, *, body=False):
        self.page = page
        self.body = body

    @property
    def first(self):
        return self

    async def count(self):
        return 0 if self.body else 1

    async def is_visible(self):
        return self.page.challenge_states.pop(0) if self.page.challenge_states else False

    async def evaluate(self, _script, _phrases):
        return self.page.body_matches


class FakePage:
    def __init__(self, challenge_states, *, body_matches=False):
        self.challenge_states = list(challenge_states)
        self.body_matches = body_matches

    def is_closed(self):
        return False

    def locator(self, selector):
        return FakeLocator(self, body=selector == "body")


class FakeSession(HumanVerificationMixin):
    def __init__(self, page):
        self._page = page
        self._context = None
        self.security_challenge_active = False
        self.cancelled = False
        self._init_human_verification()

    def _check_cancel(self):
        if self.cancelled:
            raise asyncio.CancelledError


def test_visible_puzzle_pauses_alerts_once_and_resumes(monkeypatch):
    alerts = []
    phases = []

    async def no_sleep(_seconds):
        return None

    async def progress(phase, message, page, total):
        phases.append((phase, message, page, total))

    monkeypatch.setattr("gmv.automation.human_verification.asyncio.sleep", no_sleep)
    monkeypatch.setattr(
        "gmv.automation.human_verification.show_human_verification_alert",
        lambda: alerts.append("alert"),
    )
    session = FakeSession(FakePage([True, True, False, False, False]))

    assert asyncio.run(session._wait_for_human_verification(progress)) is True
    assert alerts == ["alert"]
    assert [phase for phase, *_ in phases] == [
        "human_verification",
        "human_verification_resolved",
    ]
    assert session.security_challenge_active is False


def test_strong_verification_text_is_detected_without_captcha_selector():
    session = FakeSession(FakePage([False], body_matches=True))
    assert asyncio.run(session._visible_human_verification()) is not None


def test_normal_page_does_not_pause_or_alert(monkeypatch):
    alerts = []
    monkeypatch.setattr(
        "gmv.automation.human_verification.show_human_verification_alert",
        lambda: alerts.append("alert"),
    )
    session = FakeSession(FakePage([False], body_matches=False))
    assert asyncio.run(session._wait_for_human_verification()) is False
    assert alerts == []
