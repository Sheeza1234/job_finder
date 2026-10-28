"""A server holding a CV and personal data must not be reachable from the network without a password."""
LOOPBACK = ("127.0.0.1", "localhost", "::1")


def assert_safe_bind(host: str, password: str, allow_insecure: bool = False) -> None:
    if host in LOOPBACK or password or allow_insecure:
        return
    raise RuntimeError(f"Refusing to listen on {host} without APP_PASSWORD: your CV and personal data would be reachable without a login. "
                       "Set APP_PASSWORD, bind to 127.0.0.1, or set ALLOW_INSECURE=true if a trusted proxy already enforces authentication.")
