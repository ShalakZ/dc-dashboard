from dcdash.api.security import (
    LoginLimiter, hash_password, hash_token, new_session_token, verify_password,
)


def test_password_hash_verifies_and_is_not_plaintext():
    hashed = hash_password("correct-horse")
    assert hashed != "correct-horse" and hashed.startswith("$argon2")
    assert verify_password(hashed, "correct-horse")
    assert not verify_password(hashed, "wrong")
    assert not verify_password("not-a-hash", "correct-horse")


def test_session_token_is_random_and_stored_hashed():
    token, token_hash = new_session_token()
    other, _ = new_session_token()
    assert token != other and len(token) >= 40
    assert token_hash == hash_token(token) and token_hash != token


def test_limiter_blocks_after_max_failures_and_recovers_after_the_window():
    now = [0.0]
    limiter = LoginLimiter(max_failures=3, window_seconds=60, clock=lambda: now[0])
    for _ in range(2):
        limiter.record_failure("k")
    assert not limiter.blocked("k")
    limiter.record_failure("k")
    assert limiter.blocked("k") and not limiter.blocked("other")
    now[0] = 61.0
    assert not limiter.blocked("k")


def test_limiter_reset_clears_one_key():
    limiter = LoginLimiter(max_failures=1)
    limiter.record_failure("a")
    limiter.record_failure("b")
    limiter.reset("a")
    assert not limiter.blocked("a") and limiter.blocked("b")
