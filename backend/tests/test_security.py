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


def _limiter(max_failures=3, window=60, max_keys=50_000):
    now = [0.0]
    return LoginLimiter(max_failures, window, clock=lambda: now[0], max_keys=max_keys), now


def test_limiter_blocks_on_the_nth_failure_for_the_whole_window():
    limiter, now = _limiter()
    for _ in range(2):
        limiter.record_failure("k")
    assert not limiter.blocked("k")  # N-1 failures do not block
    limiter.record_failure("k")
    assert limiter.blocked("k") and not limiter.blocked("other")
    now[0] = 59.999
    assert limiter.blocked("k") and 0 < limiter.retry_after("k") < 0.01
    now[0] = 60.0
    assert not limiter.blocked("k") and limiter.retry_after("k") == 0.0


def test_limiter_starts_a_fresh_count_when_the_block_ends():
    limiter, now = _limiter()
    for _ in range(3):
        limiter.record_failure("k")
    now[0] = 60.0
    for _ in range(2):
        limiter.record_failure("k")
    assert not limiter.blocked("k")  # the three failures that caused the block do not count again
    limiter.record_failure("k")
    assert limiter.blocked("k")


def test_limiter_failures_spread_beyond_the_window_do_not_add_up():
    limiter, now = _limiter()
    for moment in (0.0, 30.0, 61.0):
        now[0] = moment
        limiter.record_failure("spread")
    assert not limiter.blocked("spread")
    for moment in (0.0, 30.0, 59.0):
        now[0] = moment
        limiter.record_failure("close")
    assert limiter.blocked("close")


def test_a_failure_during_a_block_neither_extends_nor_restarts_it():
    limiter, now = _limiter()
    for _ in range(3):
        limiter.record_failure("k")
    now[0] = 30.0
    limiter.record_failure("k")
    now[0] = 59.0
    assert limiter.blocked("k")
    now[0] = 60.0
    assert not limiter.blocked("k")  # still ends at 0 + 60, not 30 + 60


def test_a_full_set_of_failures_during_a_block_does_not_start_a_second_block():
    limiter, now = _limiter()  # 3 failures, 60 s
    for _ in range(3):
        limiter.record_failure("k")  # blocked at t=0
    now[0] = 30.0
    for _ in range(3):
        limiter.record_failure("k")  # a whole new set of failures, but the key is already blocked
    assert limiter.retry_after("k") == 30.0
    now[0] = 59.0
    assert limiter.blocked("k")
    now[0] = 60.0
    assert not limiter.blocked("k")  # the block still ends at 0 + 60, not 30 + 60
    limiter.record_failure("k")
    assert not limiter.blocked("k")  # the failures made during the block were not kept to add to this one


def test_a_failure_exactly_one_window_old_no_longer_counts():
    limiter, now = _limiter()  # 3 failures, 60 s
    for moment in (0.0, 30.0, 60.0):
        now[0] = moment
        limiter.record_failure("k")
    assert not limiter.blocked("k")  # at t=60 the failure from t=0 is a full window old and has dropped out
    now[0] = 61.0
    limiter.record_failure("k")
    assert limiter.blocked("k")  # t=30, 60 and 61 are all inside the window


def test_configure_applies_to_a_running_block_in_both_directions():
    limiter, now = _limiter(max_failures=5, window=300)
    for _ in range(5):
        limiter.record_failure("k")
    limiter.configure(5, 600)
    now[0] = 400.0
    assert limiter.blocked("k")  # a longer block applies at once
    limiter.configure(5, 100)
    now[0] = 150.0
    assert not limiter.blocked("k")  # and so does a shorter one


def test_lowering_the_failure_count_applies_from_the_next_failure():
    limiter, _ = _limiter(max_failures=5)
    limiter.record_failure("k")
    limiter.record_failure("k")
    limiter.configure(2, 60)
    assert not limiter.blocked("k")
    limiter.record_failure("k")
    assert limiter.blocked("k")


def test_asking_about_a_key_never_seen_stores_nothing():
    limiter, _ = _limiter()
    assert not limiter.blocked("never-seen") and limiter.retry_after("never-seen") == 0.0
    assert limiter.blocked_keys() == []
    assert len(limiter._failures) + len(limiter._blocked_since) == 0


def test_blocked_keys_lists_only_the_blocked_ones():
    limiter, now = _limiter()
    for _ in range(3):
        limiter.record_failure("a")
    limiter.record_failure("b")
    assert limiter.blocked_keys() == ["a"]
    now[0] = 60.0
    assert limiter.blocked_keys() == []


def test_drop_removes_the_matching_keys_blocked_or_counting():
    limiter, _ = _limiter(max_failures=2)
    limiter.record_failure(("1.1.1.1", "bob"))
    limiter.record_failure(("2.2.2.2", "bob"))
    limiter.record_failure(("2.2.2.2", "bob"))  # blocked
    limiter.record_failure(("1.1.1.1", "alice"))
    assert limiter.drop(lambda key: key[1] == "bob") == 2
    assert not limiter.blocked(("2.2.2.2", "bob"))
    assert limiter._failures.keys() == {("1.1.1.1", "alice")}


def test_the_cap_bounds_memory_and_keeps_blocks_over_counters():
    limiter, _ = _limiter(max_failures=3, max_keys=10)
    for _ in range(3):
        limiter.record_failure("culprit")
    for i in range(100):
        limiter.record_failure(f"once-{i}")
        assert len(limiter._failures) + len(limiter._blocked_since) <= 10
    assert limiter.blocked("culprit")


def test_clear_restores_the_constructor_numbers():
    limiter, _ = _limiter(max_failures=5, window=300)
    limiter.configure(3, 60)
    limiter.record_failure("k")
    limiter.clear()
    limiter.record_failure("k")
    limiter.record_failure("k")
    limiter.record_failure("k")
    limiter.record_failure("k")
    assert not limiter.blocked("k")  # 4 failures are below the restored 5
    limiter.record_failure("k")
    assert limiter.blocked("k")
    assert limiter.retry_after("k") == 300.0


def test_limiter_reset_clears_one_key():
    limiter = LoginLimiter(max_failures=1)
    limiter.record_failure("a")
    limiter.record_failure("b")
    limiter.reset("a")
    assert not limiter.blocked("a") and limiter.blocked("b")
