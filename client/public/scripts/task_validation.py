
# -*- coding: utf-8 -*-
"""
Utility per validare la compatibilità tra cleaner e task basata su settings.json
"""
from __future__ import annotations
from typing import Dict, Optional, List
import json
from pathlib import Path

# Path to settings.json
BASE = Path(__file__).parent.parent / "data"
SETTINGS_PATH = BASE / "input" / "settings.json"

# Cache per evitare letture ripetute
_settings_cache: Optional[Dict] = None


def _load_settings() -> Dict:
    """Carica settings.json con caching"""
    global _settings_cache
    if _settings_cache is None:
        try:
            with open(SETTINGS_PATH, 'r', encoding='utf-8') as f:
                _settings_cache = json.load(f)
        except Exception as e:
            print(f"⚠️ Errore caricamento settings.json: {e}")
            _settings_cache = {}
    return _settings_cache


def _normalize_cleaner_role(role: str) -> str:
    """Normalizza il ruolo del cleaner al formato usato in settings.json"""
    role_lower = role.lower().strip()
    
    if 'form' in role_lower:
        return 'formatore'
    elif 'straord' in role_lower:
        return 'straordinaria'
    elif 'premium' in role_lower:
        return 'premium'
    else:
        return 'standard'


def can_cleaner_handle_task(cleaner_role: str, task_type: str, can_do_straordinaria: bool = False) -> bool:
    """
    Verifica se un cleaner può gestire un determinato tipo di task.
    
    Args:
        cleaner_role: Il ruolo del cleaner (Standard, Premium, Formatore, etc.)
        task_type: Il tipo di task ('standard_apt', 'premium_apt', 'straordinario_apt')
        can_do_straordinaria: Flag che indica se il cleaner può fare straordinarie
    
    Returns:
        True se il cleaner può gestire la task, False altrimenti
    """
    settings = _load_settings()
    
    if not settings or 'task_types' not in settings:
        print(f"⚠️ Settings non valido, permetto task {task_type} per {cleaner_role}")
        return True
    
    task_types = settings['task_types']
    
    # Normalizza task_type
    if task_type not in task_types:
        print(f"⚠️ Tipo task {task_type} non trovato in settings, permetto")
        return True
    
    # Per straordinarie, usa il flag can_do_straordinaria
    if task_type == 'straordinario_apt':
        return can_do_straordinaria
    
    # Normalizza ruolo
    normalized_role = _normalize_cleaner_role(cleaner_role)
    role_key = f"{normalized_role}_cleaner"
    
    # Verifica permesso
    rules = task_types[task_type]
    allowed = rules.get(role_key, False)
    
    if not allowed:
        print(f"   ⚠️ Cleaner {cleaner_role} ({normalized_role}) non può gestire {task_type}")
    
    return allowed


def can_cleaner_handle_apartment(cleaner_role: str, apt_type: Optional[str]) -> bool:
    """
    Verifica se un cleaner può gestire un determinato tipo di appartamento.
    
    Args:
        cleaner_role: Il ruolo del cleaner (Standard, Premium, Formatore, etc.)
        apt_type: Il tipo di appartamento (A, B, C, D, E, F, X)
    
    Returns:
        True se il cleaner può gestire l'appartamento, False altrimenti
    """
    # Se apt_type è None o vuoto, permetti (task non migrata)
    if not apt_type:
        return True
    
    settings = _load_settings()
    
    if not settings or 'apartment_types' not in settings:
        print(f"⚠️ Settings apartment_types non valido, permetto apt {apt_type} per {cleaner_role}")
        return True
    
    apartment_types = settings['apartment_types']
    
    # Normalizza ruolo
    normalized_role = _normalize_cleaner_role(cleaner_role)
    
    # Mappa ruolo normalizzato a chiave apartment_types
    role_to_key = {
        'standard': 'standard_apt',
        'premium': 'premium_apt',
        'straordinaria': 'premium_apt',  # Straordinari usano stesse regole dei Premium
        'formatore': 'formatore_apt'
    }
    
    apt_key = role_to_key.get(normalized_role)
    
    if not apt_key or apt_key not in apartment_types:
        print(f"⚠️ Ruolo {cleaner_role} ({normalized_role}) non trovato in apartment_types, permetto")
        return True
    
    # Verifica se l'appartamento è nella lista permessa
    allowed_types = apartment_types[apt_key]
    allowed = apt_type in allowed_types
    
    if not allowed:
        print(f"   ⚠️ Cleaner {cleaner_role} ({normalized_role}) non può gestire appartamento tipo {apt_type}")
        print(f"      Tipi permessi: {allowed_types}")
    
    return allowed


def get_allowed_apartment_types(cleaner_role: str) -> List[str]:
    """
    Restituisce la lista di tipi di appartamento permessi per un ruolo.
    
    Args:
        cleaner_role: Il ruolo del cleaner
    
    Returns:
        Lista di tipi di appartamento permessi (es. ['A', 'B', 'C'])
    """
    settings = _load_settings()
    
    if not settings or 'apartment_types' not in settings:
        return ['A', 'B', 'C', 'D', 'E', 'F', 'X']  # Default: tutti
    
    apartment_types = settings['apartment_types']
    normalized_role = _normalize_cleaner_role(cleaner_role)
    
    role_to_key = {
        'standard': 'standard_apt',
        'premium': 'premium_apt',
        'straordinaria': 'premium_apt',
        'formatore': 'formatore_apt'
    }
    
    apt_key = role_to_key.get(normalized_role, 'standard_apt')
    
    return apartment_types.get(apt_key, ['A', 'B', 'C', 'D', 'E', 'F', 'X'])
