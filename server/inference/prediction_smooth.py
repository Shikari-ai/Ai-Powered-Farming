"""Bounded LRU cache + EMA for top hypothesis across realtime frames (optional tracking id)."""

from __future__ import annotations

from collections import OrderedDict

_MAX_TRACKS = 512
_state: OrderedDict[str, tuple[str, float]] = OrderedDict()


def _touch(key: str) -> None:
    if key in _state:
        _state.move_to_end(key)
    else:
        while len(_state) >= _MAX_TRACKS:
            _state.popitem(last=False)


def smooth_top(
    tracking_id: str,
    label: str | None,
    confidence: float | None,
    *,
    alpha: float = 0.38,
    switch_margin: float = 0.12,
    strong_conf: float = 0.86,
) -> tuple[str | None, float | None]:
    """
    Stabilize (label, confidence) for the strongest detection only.
    Raw per-box scores stay unchanged in the API response.
    """
    if not tracking_id or label is None or confidence is None:
        return label, confidence
    tid = tracking_id.strip()[:128]
    if not tid:
        return label, confidence

    _touch(tid)
    prev = _state.get(tid)
    if not prev:
        _state[tid] = (label, float(confidence))
        return label, float(confidence)

    prev_label, prev_ema = prev
    conf = float(confidence)
    if prev_label == label:
        ema = alpha * conf + (1.0 - alpha) * prev_ema
        _state[tid] = (label, ema)
        return label, ema

    if conf >= strong_conf or conf >= prev_ema + switch_margin:
        _state[tid] = (label, conf)
        return label, conf

    return prev_label, prev_ema


def reset_track(tracking_id: str) -> None:
    _state.pop(tracking_id.strip()[:128], None)
