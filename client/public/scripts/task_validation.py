import json
import os
from typing import Optional

# Funzione helper per caricare le impostazioni da API (PostgreSQL)
def load_settings(settings_path=None):
    """Carica le impostazioni da API PostgreSQL."""
    try:
        from api_client import load_settings_from_api
        return load_settings_from_api()
    except Exception as e:
        print(f"Errore durante il caricamento delle impostazioni da API: {e}")
        return {}

class TaskValidator:
    def __init__(self, settings_path='client/public/data/input/settings.json'):
        settings = load_settings(settings_path)

        self.rules = settings.get('task_types', {})
        self.apartment_types = settings.get('apartment_types', {})
        self.priority_types = settings.get('priority_types', {}) # Aggiunto per le priorità

    def _normalize_cleaner_role(self, role: str) -> str:
        normalized = role.lower().strip()

        if 'standard' in normalized:
            return 'standard_cleaner'
        elif 'premium' in normalized:
            return 'premium_cleaner'
        elif 'straord' in normalized:
            return 'straordinario_cleaner'
        elif 'formatore' in normalized:
            return 'formatore_cleaner'

        return normalized

    def can_cleaner_handle_task(self, cleaner_role: str, task_type: str, can_do_straordinaria=False) -> bool:
        role_key = self._normalize_cleaner_role(cleaner_role)

        # straordinaria: flag per-cleaner
        if task_type == "straordinario_apt":
            return bool(can_do_straordinaria)

        role_rules = self.rules.get(role_key, {})
        allowed = role_rules.get(task_type)

        if allowed is None:
            return True

        return bool(allowed)

    def can_cleaner_handle_priority(self, cleaner_role: str, task_priority: str) -> bool:
        """Valida se il cleaner può gestire task con questa priorità (EO/HP/LP)"""
        if not task_priority:
            return True
        
        role_key = self._normalize_cleaner_role(cleaner_role)
        priority_rules = self.priority_types.get(role_key, {})
        
        # Se non ci sono regole per questo ruolo, permetti tutto
        if not priority_rules:
            return True
        
        # Mappa priorità a chiavi di configurazione
        priority_map = {
            'early_out': 'early_out',
            'high_priority': 'high_priority', 
            'low_priority': 'low_priority'
        }
        
        priority_key = priority_map.get(task_priority)
        if not priority_key:
            return True
        
        # Verifica se il cleaner può gestire questa priorità
        return bool(priority_rules.get(priority_key, True))

    def can_cleaner_handle_apartment(self, cleaner_role: str, apt_type: str) -> bool:
        if not apt_type:
            return True

        role_key = self._normalize_cleaner_role(cleaner_role)

        if role_key == 'standard_cleaner':
            allowed_apts = self.apartment_types.get('standard_apt', [])
        elif role_key == 'premium_cleaner':
            allowed_apts = self.apartment_types.get('premium_apt', [])
        elif role_key == 'straordinario_cleaner':
            allowed_apts = self.apartment_types.get('straordinario_apt', [])
        elif role_key == 'formatore_cleaner':
            allowed_apts = self.apartment_types.get('formatore_apt', [])
        else:
            return True

        return apt_type in allowed_apts

    # Nuova funzione per validare la priorità
    def can_cleaner_handle_priority(self, cleaner_role: str, priority: str) -> bool:
        """
        Verifica se un cleaner con un certo ruolo può gestire una task con una certa priorità
        basandosi su settings.json -> priority_types
        """
        role_key = self._normalize_cleaner_role(cleaner_role)
        allowed_priorities = self.priority_types.get(role_key, {})

        # Se la priorità non è esplicitamente permessa, allora non è permessa
        # Se la chiave di ruolo non esiste, allowed_priorities sarà {}, e .get(priority, False) restituirà False
        return allowed_priorities.get(priority, False)


# Istanza globale del validator
_validator = TaskValidator()

# Funzioni standalone per l'import negli script di assegnazione
def can_cleaner_handle_task(cleaner_role: str, task_type: str, can_do_straordinaria=False) -> bool:
    return _validator.can_cleaner_handle_task(cleaner_role, task_type, can_do_straordinaria)

def can_cleaner_handle_apartment(cleaner_role: str, apt_type: str) -> bool:
    return _validator.can_cleaner_handle_apartment(cleaner_role, apt_type)

# Nuova funzione standalone per la validazione della priorità
def can_cleaner_handle_priority(cleaner_role: str, priority: str) -> bool:
    """
    Verifica se un cleaner con un certo ruolo può gestire una task con una certa priorità
    basandosi su settings.json -> priority_types.
    """
    return _validator.can_cleaner_handle_priority(cleaner_role, priority)