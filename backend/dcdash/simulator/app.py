import os
from datetime import datetime, timezone

from fastapi import Depends, FastAPI, Header, HTTPException, Query
from pydantic import BaseModel

from dcdash.simulator.model import PANELS, Simulator


class Fault(BaseModel):
    offline: bool = False
    reject_auth: bool = False


def create_sim_app(sim: Simulator | None = None, api_key: str | None = None) -> FastAPI:
    sim = sim or Simulator()
    key = api_key or os.environ.get("SIM_API_KEY", "sim-key")
    app = FastAPI(title="DC Dashboard simulator")
    app.state.sim = sim

    def guard(x_api_key: str | None = Header(default=None)) -> None:
        if sim.offline:
            raise HTTPException(503, "simulator offline")
        if sim.reject_auth or x_api_key != key:
            raise HTTPException(401, "bad api key")

    @app.get("/points", dependencies=[Depends(guard)])
    def points() -> dict:
        return {"points": sim.points()}

    @app.get("/read", dependencies=[Depends(guard)])
    def read(addresses: str = Query(...)) -> dict:
        now = datetime.now(timezone.utc)
        sim.advance(now)
        return {
            "values": [
                {"address": address, "ts": now.isoformat(), "value": sim.read(address, now)}
                for address in addresses.split(",")
                if address
            ]
        }

    @app.post("/admin/fault")
    def fault(body: Fault) -> Fault:
        sim.offline, sim.reject_auth = body.offline, body.reject_auth
        return body

    @app.post("/admin/reset-counter/{panel}")
    def reset_counter(panel: str) -> dict:
        if panel not in PANELS:
            raise HTTPException(404, "unknown panel")
        sim.reset_counter(panel)
        return {"panel": panel}

    return app


app = create_sim_app()
