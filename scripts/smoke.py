"""Drive a running stack from first-run setup to live data.

Start the stack with the dev profile first:  scripts/setup.sh --profile dev
Then run:  uv run --project backend python scripts/smoke.py [base_url]   (default http://localhost, through Caddy)
"""

import sys
import time

import httpx

BASE = sys.argv[1] if len(sys.argv) > 1 else "http://localhost"
ADMIN = {"username": "admin", "password": "smoke-test-password"}
SOURCE = {
    "name": "smoke-sim",
    "connector_type": "simulator",
    "config": {"url": "http://simulator:9000"},
    "secret": "sim-key",
}


def wait(check, what: str, timeout: float = 60.0):
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        value = check()
        if value:
            return value
        time.sleep(1)
    sys.exit(f"FAILED: timed out waiting for {what}")


def main() -> None:
    with httpx.Client(base_url=BASE, timeout=10) as client:
        assert client.get("/api/health").json() == {"status": "ok"}
        if client.get("/api/setup").json()["needed"]:
            client.post("/api/setup", json=ADMIN).raise_for_status()
        else:
            client.post("/api/login", json=ADMIN).raise_for_status()

        sources = client.get("/api/sources").json()
        source = next((s for s in sources if s["name"] == SOURCE["name"]), None)
        if source is None:
            source = client.post("/api/sources", json=SOURCE).raise_for_status().json()

        job = client.post(f"/api/sources/{source['id']}/browse").json()["job_id"]
        wait(lambda: client.get(f"/api/jobs/{job}").json()["status"] == "done", "browse job")
        points = {p["address"]: p for p in client.get(f"/api/sources/{source['id']}/points").json()}
        print(f"browsed {len(points)} points")

        assets = client.get("/api/assets").json()
        panel = next((a for a in assets if a["name"] == "Smoke Panel"), None)
        if panel is None:
            panel = client.post("/api/assets", json={"name": "Smoke Panel"}).raise_for_status().json()
        for address, metric in (("LVP01_kW", "active_power_kw"), ("LVP01_kWh", "energy_kwh")):
            if points[address]["mapping"] is None:
                client.post(
                    "/api/mappings",
                    json={"point_id": points[address]["id"], "asset_id": panel["id"],
                          "metric": metric, "interval_seconds": 1},
                ).raise_for_status()

        def live():
            summary = client.get(f"/api/assets/{panel['id']}/summary").json()
            values = {m["metric"]: m["value"] for m in summary["metrics"]}
            return summary if all(v is not None for v in values.values()) and len(values) == 2 else None

        summary = wait(live, "live values")
        for metric in summary["metrics"]:
            print(f"{metric['metric']}: {metric['value']:.2f} {metric['unit']}")
        print(f"energy today: {summary['energy_today']}")
        print("OK")


if __name__ == "__main__":
    main()
