# -*- coding: utf-8 -*-
"""
Helper condivisi per interazione con API.
Usato da assign_eo.py, assign_hp.py, assign_lp.py
"""

from typing import Dict, List, Optional

# API Client import (opzionale, con fallback)
try:
    from api_client import ApiClient
    API_AVAILABLE = True
except ImportError:
    API_AVAILABLE = False


def save_timeline_via_api(work_date: str, timeline_data: Dict, use_api: bool = False) -> bool:
    """Salva timeline via API se disponibile."""
    if not use_api or not API_AVAILABLE:
        return False
    
    try:
        client = ApiClient()
        client.save_timeline(work_date, timeline_data)
        print(f"   ✅ Timeline salvata via API per {work_date}")
        return True
    except Exception as e:
        print(f"   ⚠️ Errore salvataggio API timeline: {e}")
        return False


def save_containers_via_api(work_date: str, containers_data: Dict, use_api: bool = False) -> bool:
    """Salva containers via API se disponibile."""
    if not use_api or not API_AVAILABLE:
        return False
    
    try:
        client = ApiClient()
        client.save_containers(work_date, containers_data)
        print(f"   ✅ Containers salvati via API per {work_date}")
        return True
    except Exception as e:
        print(f"   ⚠️ Errore salvataggio API containers: {e}")
        return False


def load_timeline_via_api(work_date: str, use_api: bool = False) -> Optional[Dict]:
    """Carica timeline via API se disponibile."""
    if not use_api or not API_AVAILABLE:
        return None
    
    try:
        client = ApiClient()
        data = client.get_timeline(work_date)
        if data and data.get("cleaners_assignments") is not None:
            print(f"   ✅ Timeline caricata da API: {len(data.get('cleaners_assignments', []))} cleaners")
            return data
    except Exception as e:
        print(f"   ⚠️ Errore API timeline: {e}")
    
    return None


def load_containers_via_api(work_date: str, use_api: bool = False) -> Optional[Dict]:
    """Carica containers via API se disponibile."""
    if not use_api or not API_AVAILABLE:
        return None
    
    try:
        client = ApiClient()
        data = client.get_containers(work_date)
        if data and data.get("containers"):
            print(f"   ✅ Containers caricati da API")
            return data
    except Exception as e:
        print(f"   ⚠️ Errore API containers: {e}")
    
    return None


def load_cleaners_via_api(work_date: str, use_api: bool = False) -> Optional[List[Dict]]:
    """Carica cleaners selezionati via API se disponibile."""
    if not use_api or not API_AVAILABLE:
        return None
    
    try:
        client = ApiClient()
        cleaners = client.get_selected_cleaners(work_date)
        if cleaners:
            print(f"   ✅ Cleaners caricati da API: {len(cleaners)}")
            return cleaners
    except Exception as e:
        print(f"   ⚠️ Errore API cleaners: {e}")
    
    return None


def get_assigned_logistic_codes_via_api(work_date: str, use_api: bool = False) -> Optional[set]:
    """Ottiene set di logistic_code già assegnati dalla timeline via API."""
    if not use_api or not API_AVAILABLE:
        return None
    
    try:
        client = ApiClient()
        return client.get_assigned_logistic_codes(work_date)
    except Exception as e:
        print(f"   ⚠️ Errore API logistic codes: {e}")
        return None
