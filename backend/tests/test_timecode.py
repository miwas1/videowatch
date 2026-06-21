from __future__ import annotations

from reader.services.timecode import format_timestamp


def test_format_timestamp() -> None:
    assert format_timestamp(0) == "00:00"
    assert format_timestamp(6) == "00:06"
    assert format_timestamp(75) == "01:15"
    assert format_timestamp(3675) == "1:01:15"

