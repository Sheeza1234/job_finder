import pytest

from app.bind import assert_safe_bind


def test_loopback_is_always_allowed():
    for h in ("127.0.0.1", "localhost", "::1"):
        assert_safe_bind(h, "")


def test_network_bind_needs_a_password_or_explicit_override():
    with pytest.raises(RuntimeError, match="APP_PASSWORD"):
        assert_safe_bind("0.0.0.0", "")
    assert_safe_bind("0.0.0.0", "pw")
    assert_safe_bind("0.0.0.0", "", allow_insecure=True)
