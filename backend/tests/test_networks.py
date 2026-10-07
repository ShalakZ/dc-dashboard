from dcdash.collector import networks
from dcdash.collector.networks import publish_networks


async def test_publishes_the_24s_of_the_collectors_addresses(db, monkeypatch):
    monkeypatch.setattr(networks, "local_addresses", lambda: ["172.18.0.7", "127.0.0.1", "172.19.5.2"])
    assert await publish_networks(db) == ["172.18.0.0/24", "172.19.5.0/24"]
    assert await db.fetchval("SELECT value FROM settings WHERE key = 'collector_networks'") == {
        "cidrs": ["172.18.0.0/24", "172.19.5.0/24"]
    }


async def test_republishing_replaces_the_value(db, monkeypatch):
    monkeypatch.setattr(networks, "local_addresses", lambda: ["10.0.0.5"])
    await publish_networks(db)
    monkeypatch.setattr(networks, "local_addresses", lambda: ["10.0.1.5"])
    await publish_networks(db)
    assert await db.fetchval("SELECT value FROM settings WHERE key = 'collector_networks'") == {"cidrs": ["10.0.1.0/24"]}


async def test_failures_never_propagate(db, monkeypatch):
    def boom():
        raise OSError("no network")

    monkeypatch.setattr(networks, "local_addresses", boom)
    assert await publish_networks(db) == []
