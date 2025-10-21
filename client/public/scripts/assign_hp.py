# -*- coding: utf-8 -*-
from __future__ import annotations
import math
from typing import Dict, List, Any, Callable

def _euclid_minutes(a: Dict[str, Any], b: Dict[str, Any]) -> int:
    ax, ay = float(a.get("lon", 0.0)), float(a.get("lat", 0.0))
    bx, by = float(b.get("lon", 0.0)), float(b.get("lat", 0.0))
    dist_km = ((ax - bx) ** 2 + (ay - by) ** 2) ** 0.5 * 111.0
    return int(round((dist_km / 25.0) * 60.0))

def assign(tasks, cleaners, travel_time_fn: Callable[[Dict[str, Any], Dict[str, Any]], int] | None = None):
    travel = travel_time_fn or _euclid_minutes
    routes = {c["id"]: [] for c in cleaners}
    cleaner_lookup = {c["id"]: c for c in cleaners}
    task_lookup = {t["id"]: t for t in tasks}
    unassigned = []

    def last_stop(cid: str):
        r = routes[cid]
        if not r:
            c = cleaner_lookup[cid]
            return {"id": f"HOME_{cid}", "lat": c.get("home_lat", 0.0), "lon": c.get("home_lon", 0.0)}
        return task_lookup[r[-1]]

    for t in tasks:
        cands = []
        for c in cleaners:
            cid = c["id"]
            hop = int(travel(last_stop(cid), t))
            if len(routes[cid]) >= 3:
                continue
            if len(routes[cid]) == 2 and hop > 10:
                continue
            cands.append((hop, cid))
        if not cands:
            unassigned.append({"task_id": t["id"], "reason": "no_eligible_cleaner"})
            continue
        lt15 = [c for c in cands if c[0] < 15]
        pool = lt15 if lt15 else cands
        hop, chosen_cid = min(pool, key=lambda x: x[0])
        routes[chosen_cid].append(t["id"])
    return {"routes": routes, "unassigned": unassigned}
