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


class TaskValidationRules:
    """Gestisce le regole di validazione task_types e apartment_types da settings.json"""

    def __init__(self):
        self.rules: Dict[str, Dict[str, bool]] = {}
        # mappa: "standard_cleaner" -> ["A","B",...]
        self.apartment_types: Dict[str, List[str]] = {}
        self.load_rules()

    def load_rules(self) -> None:
        """Carica le regole task_types e apartment_types da settings.json"""
        try:
            with open(SETTINGS_PATH, 'r', encoding='utf-8') as f:
                settings = json.load(f)
                self.rules = settings.get('task_types', {})
                self.apartment_types = settings.get('apartment_types', {})
        except FileNotFoundError:
            print(f"⚠️ Warning: {SETTINGS_PATH} not found, using empty rules")
            self.rules = {}
            self.apartment_types = {}
        except json.JSONDecodeError as e:
            print(f"⚠️ Warning: Error parsing {SETTINGS_PATH}: {e}")
            self.rules = {}
            self.apartment_types = {}

    def can_cleaner_handle_task(self, cleaner_role: str, task_type: str, can_do_straordinaria: bool = False) -> bool:
        """
        Verifica se un cleaner può gestire un determinato tipo di task

        Args:
            cleaner_role: Il ruolo del cleaner ("Standard", "Premium", "Formatore")
            task_type: Il tipo di task ("standard_apt", "premium_apt", "straordinario_apt")
            can_do_straordinaria: Flag che indica se il cleaner può fare straordinarie

        Returns:
            True se il cleaner può gestire la task, False altrimenti
        """
        # Normalizza i nomi
        task_type_key = self._normalize_task_type(task_type)
        cleaner_key = self._normalize_cleaner_role(cleaner_role)

        # Se non ci sono regole, permetti tutto (fallback safe)
        if not self.rules or task_type_key not in self.rules:
            return True

        # Per straordinarie, usa il flag can_do_straordinaria
        if task_type_key == 'straordinario_apt':
            return can_do_straordinaria

        task_rules = self.rules[task_type_key]

        # Verifica se il cleaner può gestire questo tipo di task
        return task_rules.get(cleaner_key, False)

    def can_cleaner_handle_apartment_type(self, cleaner_role: str, apartment_type: str) -> bool:
        """
        Verifica se un cleaner può gestire un determinato tipo di appartamento

        Args:
            cleaner_role: Il ruolo del cleaner ("Standard", "Premium", "Formatore")
            apartment_type: Il tipo di appartamento ("A", "B", "C", etc.)

        Returns:
            True se il cleaner può gestire questo tipo di appartamento, False altrimenti
        """
        # Normalizza i nomi
        cleaner_key = self._normalize_cleaner_role(cleaner_role)

        # Se non ci sono regole, permetti tutto (fallback safe)
        if not self.apartment_types or cleaner_key not in self.apartment_types:
            return True

        allowed_apartment_types = self.apartment_types[cleaner_key]

        # Verifica se il tipo di appartamento è permesso
        return apartment_type in allowed_apartment_types

    def _normalize_task_type(self, task_type: str) -> str:
        """Normalizza il tipo di task al formato usato in settings.json"""
        # Gestisce varianti: "standard", "premium", "straordinaria", etc.
        task_type_lower = task_type.lower()

        if 'straord' in task_type_lower:
            return 'straordinario_apt'
        elif 'premium' in task_type_lower:
            return 'premium_apt'
        else:  # default to standard
            return 'standard_apt'

    def _normalize_cleaner_role(self, role: str) -> str:
        """Normalizza il ruolo del cleaner al formato usato in settings.json"""
        # Gestisce varianti: "Standard", "Premium", "Formatore", etc.
        role_lower = role.lower()

        if 'form' in role_lower:
            return 'formatore_cleaner'
        elif 'straord' in role_lower:
            return 'straordinaria_cleaner'
        elif 'premium' in role_lower:
            return 'premium_cleaner'
        else:  # default to standard
            return 'standard_cleaner'

    def get_validation_message(self, cleaner_role: str, task_type: str) -> Optional[str]:
        """
        Restituisce un messaggio di errore se l'assegnazione non è valida

        Returns:
            Messaggio di errore o None se la validazione passa
        """
        if not self.can_cleaner_handle_task(cleaner_role, task_type):
            return f"⚠️ Cleaner {cleaner_role} non può gestire task {task_type}"
        return None

    def get_apartment_validation_message(self, cleaner_role: str, apartment_type: str) -> Optional[str]:
        """
        Restituisce un messaggio di errore se l'assegnazione del tipo di appartamento non è valida

        Returns:
            Messaggio di errore o None se la validazione passa
        """
        if not self.can_cleaner_handle_apartment_type(cleaner_role, apartment_type):
            return f"⚠️ Cleaner {cleaner_role} non può gestire appartamento tipo {apartment_type}"
        return None


# Singleton instance
_validation_rules: Optional[TaskValidationRules] = None


def get_validation_rules() -> TaskValidationRules:
    """Restituisce l'istanza singleton delle regole di validazione"""
    global _validation_rules
    if _validation_rules is None:
        _validation_rules = TaskValidationRules()
    return _validation_rules


# Convenience functions
def can_cleaner_handle_task(cleaner_role: str, task_type: str, can_do_straordinaria: bool = False) -> bool:
    """Wrapper convenience per la validazione dei task"""
    return get_validation_rules().can_cleaner_handle_task(cleaner_role, task_type, can_do_straordinaria)


def validate_assignment(cleaner_role: str, task_type: str, can_do_straordinaria: bool = False) -> Optional[str]:
    """Wrapper convenience per ottenere messaggi di validazione task"""
    if not get_validation_rules().can_cleaner_handle_task(cleaner_role, task_type, can_do_straordinaria):
        return f"⚠️ Cleaner {cleaner_role} non può gestire task {task_type}"
    return None


def can_cleaner_handle_apartment_type(cleaner_role: str, apartment_type: str) -> bool:
    """Wrapper convenience per la validazione dei tipi di appartamento"""
    return get_validation_rules().can_cleaner_handle_apartment_type(cleaner_role, apartment_type)


def can_cleaner_handle_apartment(cleaner_role: str, apartment_type: str) -> bool:
    """Alias per can_cleaner_handle_apartment_type"""
    return can_cleaner_handle_apartment_type(cleaner_role, apartment_type)


def validate_apartment_assignment(cleaner_role: str, apartment_type: str) -> Optional[str]:
    """Wrapper convenience per ottenere messaggi di validazione tipo di appartamento"""
    return get_validation_rules().get_apartment_validation_message(cleaner_role, apartment_type)