import json
import os

class TaskValidator:
    def __init__(self, settings_path='client/public/data/input/settings.json'):
        with open(settings_path, 'r', encoding='utf-8') as f:
            settings = json.load(f)

        self.rules = settings.get('task_types', {})
        self.apartment_types = settings.get('apartment_types', {})

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


# Istanza globale del validator
_validator = TaskValidator()

# Funzioni standalone per l'import negli script di assegnazione
def can_cleaner_handle_task(cleaner_role: str, task_type: str, can_do_straordinaria=False) -> bool:
    return _validator.can_cleaner_handle_task(cleaner_role, task_type, can_do_straordinaria)

def can_cleaner_handle_apartment(cleaner_role: str, apt_type: str) -> bool:
    return _validator.can_cleaner_handle_apartment(cleaner_role, apt_type)