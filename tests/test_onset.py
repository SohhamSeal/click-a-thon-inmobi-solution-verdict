"""Persistence rule for historical segment onset (mirrors web/lib/onset.ts)."""

from __future__ import annotations


def compute_onset(flagged: list[bool], k: int = 2) -> tuple[str, int | None]:
    if len(flagged) < k:
        return "undetermined", None
    onset = None
    for i in range(len(flagged) - k + 1):
        if all(flagged[i : i + k]):
            onset = i
            break
    if onset is None:
        return "undetermined", None
    run = 0
    for j in range(onset, len(flagged)):
        if not flagged[j]:
            break
        run += 1
    status = "determined" if run > k else "weak"
    return status, onset


def test_no_sustained_run():
    assert compute_onset([True, False, True]) == ("undetermined", None)


def test_exactly_k_is_weak():
    assert compute_onset([False, True, True, False]) == ("weak", 1)


def test_longer_than_k_is_determined_earliest():
    # two runs; onset is the first
    flagged = [True, True, True, False, True, True, True, True]
    assert compute_onset(flagged) == ("determined", 0)
