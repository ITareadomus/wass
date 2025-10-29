
#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
assign_eo.py — assegnazione EO con dedup rigoroso
-------------------------------------------------
Corregge il problema delle task duplicate (stesso logistic_code) assegnate
a cleaner diversi. La deduplica viene applicata in tre punti:
1) durante il planning (guardia su task_id e logistic_code)
2) durante la costruzione dell'output (seconda guardia)
3) durante il merge con la timeline esistente (rimuove le EO precedenti
   con gli stessi logistic_code, indipendentemente dal cleaner originario)

Il modulo può essere importato (usando le funzioni) oppure eseguito come CLI:

CLI USAGE
---------
python assign_eo.py --tasks tasks.json --cleaners cleaners.json --timeline timeline.json --out timeline_updated.json

- tasks.json: lista di task EO da pianificare (array di dict)
- cleaners.json: lista di cleaner disponibili (array di dict)
- timeline.json: file con lo stato delle assegnazioni (schema simile all'output)
- timeline_updated.json: file di output aggiornato

Se non si passa --timeline, il merge salta e viene stampato l'output EO.
"""

from __future__ import annotations
import json
import sys
import argparse
from dataclasses import dataclass, field
from typing import Any, Dict, List, Optional, Tuple, Set


# ----------------------------
# Data models (minimi)
# ----------------------------

@dataclass
class Task:
    task_id: int
    logistic_code: int
    client_id: int
    premium: bool
    address: str
    lat: Optional[str] = None
    lng: Optional[str] = None
    cleaning_time: Optional[int] = None
    checkin_date: Optional[str] = None
    checkout_date: Optional[str] = None
    checkin_time: Optional[str] = None
    checkout_time: Optional[str] = None
    pax_in: Optional[int] = None
    pax_out: Optional[int] = None
    small_equipment: Optional[bool] = None
    operation_id: Optional[int] = None
    confirmed_operation: Optional[bool] = None
    straordinaria: Optional[bool] = None
    type_apt: Optional[str] = None
    alias: Optional[str] = None
    customer_name: Optional[str] = None
    reasons: Optional[List[str]] = None
    priority: Optional[str] = None
    start_time: Optional[str] = None
    end_time: Optional[str] = None
    followup: Optional[bool] = None
    sequence: Optional[int] = None
    travel_time: Optional[int] = None

    @staticmethod
    def from_dict(d: Dict[str, Any]) -> "Task":
        # garantisce int per logistic_code se possibile
        lc = d.get("logistic_code")
        try:
            lc = int(lc) if lc is not None else None
        except Exception:
            pass
        return Task(
            task_id=int(d["task_id"]),
            logistic_code=lc,
            client_id=int(d.get("client_id", 0)),
            premium=bool(d.get("premium", False)),
            address=d.get("address", ""),
            lat=d.get("lat"),
            lng=d.get("lng"),
            cleaning_time=d.get("cleaning_time"),
            checkin_date=d.get("checkin_date"),
            checkout_date=d.get("checkout_date"),
            checkin_time=d.get("checkin_time"),
            checkout_time=d.get("checkout_time"),
            pax_in=d.get("pax_in"),
            pax_out=d.get("pax_out"),
            small_equipment=d.get("small_equipment"),
            operation_id=d.get("operation_id"),
            confirmed_operation=d.get("confirmed_operation"),
            straordinaria=d.get("straordinaria"),
            type_apt=d.get("type_apt"),
            alias=d.get("alias"),
            customer_name=d.get("customer_name"),
            reasons=d.get("reasons") or [],
            priority=d.get("priority"),
            start_time=d.get("start_time"),
            end_time=d.get("end_time"),
            followup=d.get("followup"),
            sequence=d.get("sequence"),
            travel_time=d.get("travel_time"),
        )

    def to_public_dict(self) -> Dict[str, Any]:
        # mantiene le stesse chiavi del tuo output
        return {
            "task_id": self.task_id,
            "logistic_code": self.logistic_code,
            "client_id": self.client_id,
            "premium": self.premium,
            "address": self.address,
            "lat": self.lat,
            "lng": self.lng,
            "cleaning_time": self.cleaning_time,
            "checkin_date": self.checkin_date,
            "checkout_date": self.checkout_date,
            "checkin_time": self.checkin_time,
            "checkout_time": self.checkout_time,
            "pax_in": self.pax_in,
            "pax_out": self.pax_out,
            "small_equipment": self.small_equipment,
            "operation_id": self.operation_id,
            "confirmed_operation": self.confirmed_operation,
            "straordinaria": self.straordinaria,
            "type_apt": self.type_apt,
            "alias": self.alias,
            "customer_name": self.customer_name,
            "reasons": self.reasons,
            "priority": self.priority,
            "start_time": self.start_time,
            "end_time": self.end_time,
            "followup": self.followup,
            "sequence": self.sequence,
            "travel_time": self.travel_time,
        }


@dataclass
class Cleaner:
    id: int
    name: str
    lastname: str
    role: str
    premium: bool
    route: List[Task] = field(default_factory=list)

    @staticmethod
    def from_dict(d: Dict[str, Any]) -> "Cleaner":
        return Cleaner(
            id=int(d["id"]),
            name=d.get("name", ""),
            lastname=d.get("lastname", ""),
            role=d.get("role", ""),
            premium=bool(d.get("premium", False)),
            route=[],
        )

    def to_public_dict(self) -> Dict[str, Any]:
        return {
            "id": self.id,
            "name": self.name,
            "lastname": self.lastname,
            "role": self.role,
            "premium": self.premium,
        }


# ----------------------------
# Assignment planner
# ----------------------------

def choose_insertion(cleaner: Cleaner, task: Task) -> Tuple[int, int]:
    """
    Semplice euristica: inserisce in coda (pos = len(route)).
    Ritorna (posizione, travel_time stimato). Travel_time 0 per semplicità.
    """
    return len(cleaner.route), 0


def plan_day(tasks: List[Task], cleaners: List[Cleaner]) -> Tuple[List[Cleaner], List[Task]]:
    """
    Assegna le task ai cleaner disponibili con dedup rigoroso:
    - una task non può essere assegnata due volte (task_id)
    - due cleaner non possono avere la stessa EO (logistic_code)
    """
    unassigned: List[Task] = []
    assigned_task_ids: Set[int] = set()
    assigned_codes: Set[int] = set()

    # euristica: ordina tasks per priority/time se serve (qui lasciamo l'ordine dato)
    for task in tasks:
        if task.task_id in assigned_task_ids or (task.logistic_code is not None and task.logistic_code in assigned_codes):
            # già assegnata o stesso codice assegnato
            continue

        # euristica di scelta cleaner: premium->premium se possibile, altrimenti primo disponibile
        preferred: Optional[Cleaner] = None
        fallback: Optional[Cleaner] = None
        for c in cleaners:
            if preferred is None and (c.premium == bool(task.premium)):
                preferred = c
            if fallback is None:
                fallback = c
            if preferred and fallback:
                break

        chosen_cleaner = preferred or fallback
        if chosen_cleaner is None:
            unassigned.append(task)
            continue

        pos, travel = choose_insertion(chosen_cleaner, task)
        chosen_cleaner.route.insert(pos, task)
        assigned_task_ids.add(task.task_id)
        if task.logistic_code is not None:
            assigned_codes.add(task.logistic_code)

    return cleaners, unassigned


# ----------------------------
# Output building with dedup
# ----------------------------

def build_output(cleaners: List[Cleaner], unassigned: List[Task], meta: Optional[Dict[str, Any]] = None) -> Dict[str, Any]:
    """
    Costruisce l'output nello schema atteso, con seconda guardia dedup.
    """
    out: Dict[str, Any] = {"cleaners_assignments": [], "meta": meta or {}}

    seen_task_ids: Set[int] = set()
    seen_codes: Set[int] = set()

    for c in cleaners:
        tasks_payload: List[Dict[str, Any]] = []
        for t in c.route:
            if t.task_id in seen_task_ids or (t.logistic_code is not None and t.logistic_code in seen_codes):
                # skip duplicati
                continue
            tasks_payload.append(t.to_public_dict())
            seen_task_ids.add(t.task_id)
            if t.logistic_code is not None:
                seen_codes.add(t.logistic_code)

        if tasks_payload:
            out["cleaners_assignments"].append({
                "cleaner": c.to_public_dict(),
                "tasks": tasks_payload
            })

    # meta safe-guards
    out.setdefault("meta", {})
    out["meta"].setdefault("total_cleaners", len(out["cleaners_assignments"]))
    out["meta"].setdefault("total_tasks", sum(len(e["tasks"]) for e in out["cleaners_assignments"]))

    return out


# ----------------------------
# Timeline merge with dedup
# ----------------------------

def _collect_codes_from_output(output: Dict[str, Any]) -> Set[int]:
    codes: Set[int] = set()
    for entry in output.get("cleaners_assignments", []):
        for t in entry.get("tasks", []):
            lc = t.get("logistic_code")
            try:
                lc = int(lc) if lc is not None else None
            except Exception:
                lc = None
            if lc is not None:
                codes.add(lc)
    return codes


def merge_timeline(existing: Dict[str, Any], new_output: Dict[str, Any]) -> Dict[str, Any]:
    """
    Rimuove dal timeline 'existing' tutte le EO auto-assegnate con logistic_code
    presenti in 'new_output', poi appende le nuove assegnazioni.
    Inoltre, rimuove eventuali cleaner rimasti senza task.
    """
    new_codes = _collect_codes_from_output(new_output)

    cleaned_existing: List[Dict[str, Any]] = []
    for c in existing.get("cleaners_assignments", []):
        kept_tasks = []
        for t in c.get("tasks", []):
            lc = t.get("logistic_code")
            try:
                lc_int = int(lc) if lc is not None else None
            except Exception:
                lc_int = None

            reasons = t.get("reasons") or []
            # rimuovi solo le EO auto-assegnate (coerente con il caso d'uso)
            if not (("automatic_assignment_eo" in reasons) and (lc_int in new_codes)):
                kept_tasks.append(t)

        if kept_tasks:
            c2 = dict(c)
            c2["tasks"] = kept_tasks
            cleaned_existing.append(c2)

    merged = {
        "cleaners_assignments": cleaned_existing + new_output.get("cleaners_assignments", []),
        "meta": new_output.get("meta") or existing.get("meta") or {},
    }

    # drop cleaner senza task
    merged["cleaners_assignments"] = [c for c in merged["cleaners_assignments"] if c.get("tasks")]

    # calibra meta finali
    merged.setdefault("meta", {})
    merged["meta"]["total_cleaners"] = len(merged["cleaners_assignments"])
    merged["meta"]["total_tasks"] = sum(len(e["tasks"]) for e in merged["cleaners_assignments"])

    return merged


# ----------------------------
# CLI helpers
# ----------------------------

def _load_json(path: str) -> Any:
    with open(path, "r", encoding="utf-8") as f:
        return json.load(f)


def _dump_json(obj: Any, path: Optional[str] = None) -> None:
    if path:
        with open(path, "w", encoding="utf-8") as f:
            json.dump(obj, f, ensure_ascii=False, indent=2)
    else:
        json.dump(obj, sys.stdout, ensure_ascii=False, indent=2)
        sys.stdout.write("\n")


def run_cli(args: argparse.Namespace) -> None:
    # Carica cleaners e tasks
    cleaners_raw = _load_json(args.cleaners)
    tasks_raw = _load_json(args.tasks)

    cleaners = [Cleaner.from_dict(c) for c in cleaners_raw]
    tasks = [Task.from_dict(t) for t in tasks_raw]

    planned_cleaners, unassigned = plan_day(tasks, cleaners)
    new_output = build_output(planned_cleaners, unassigned, meta={"source": "assign_eo.py"})

    if args.timeline:
        timeline = _load_json(args.timeline)
        merged = merge_timeline(timeline, new_output)
        if args.out:
            _dump_json(merged, args.out)
        else:
            _dump_json(merged, None)
    else:
        # Nessuna timeline: stampiamo solo il nuovo output EO
        if args.out:
            _dump_json(new_output, args.out)
        else:
            _dump_json(new_output, None)


def make_argparser() -> argparse.Namespace:
    p = argparse.ArgumentParser(description="Assegnatore EO con dedup su logistic_code e task_id.")
    p.add_argument("--tasks", required=True, help="JSON file con tasks EO (array)")
    p.add_argument("--cleaners", required=True, help="JSON file con cleaners (array)")
    p.add_argument("--timeline", required=False, help="JSON file esistente con timeline (opzionale)")
    p.add_argument("--out", required=False, help="Percorso file di output (se omesso stampa su stdout)")
    return p


if __name__ == "__main__":
    parser = make_argparser()
    run_cli(parser.parse_args())
