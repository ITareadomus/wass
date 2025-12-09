# -*- coding: utf-8 -*-
"""
API Client per comunicazione con backend Node.js/PostgreSQL.
Sostituisce la lettura/scrittura diretta di file JSON.

Uso:
    from api_client import ApiClient
    
    client = ApiClient()
    
    # Leggi dati
    timeline = client.get_timeline("2025-12-09")
    containers = client.get_containers("2025-12-09")
    cleaners = client.get_cleaners("2025-12-09")
    selected = client.get_selected_cleaners("2025-12-09")
    
    # Salva dati
    client.save_timeline("2025-12-09", timeline_data)
    client.save_containers("2025-12-09", containers_data)
    client.save_selected_cleaners("2025-12-09", cleaner_ids)
"""

import json
import requests
from typing import Any, Dict, List, Optional
from datetime import datetime


class ApiClient:
    """Client per API REST del backend."""
    
    def __init__(self, base_url: str = "http://localhost:5000"):
        self.base_url = base_url
        self.timeout = 30  # secondi
    
    def _get(self, endpoint: str, params: Optional[Dict] = None) -> Dict:
        """Esegue GET request."""
        url = f"{self.base_url}{endpoint}"
        try:
            response = requests.get(url, params=params, timeout=self.timeout)
            response.raise_for_status()
            return response.json()
        except requests.exceptions.RequestException as e:
            print(f"❌ Errore API GET {endpoint}: {e}")
            raise
    
    def _post(self, endpoint: str, data: Dict) -> Dict:
        """Esegue POST request."""
        url = f"{self.base_url}{endpoint}"
        try:
            response = requests.post(
                url, 
                json=data, 
                headers={"Content-Type": "application/json"},
                timeout=self.timeout
            )
            response.raise_for_status()
            return response.json()
        except requests.exceptions.RequestException as e:
            print(f"❌ Errore API POST {endpoint}: {e}")
            raise
    
    def _put(self, endpoint: str, data: Dict) -> Dict:
        """Esegue PUT request."""
        url = f"{self.base_url}{endpoint}"
        try:
            response = requests.put(
                url, 
                json=data, 
                headers={"Content-Type": "application/json"},
                timeout=self.timeout
            )
            response.raise_for_status()
            return response.json()
        except requests.exceptions.RequestException as e:
            print(f"❌ Errore API PUT {endpoint}: {e}")
            raise

    # ==================== TIMELINE ====================
    
    def get_timeline(self, date: str) -> Dict:
        """
        Carica timeline da PostgreSQL.
        
        Args:
            date: Data nel formato YYYY-MM-DD
            
        Returns:
            Timeline con structure:
            {
                "metadata": {"date": "2025-12-09"},
                "cleaners_assignments": [
                    {
                        "cleaner_id": 123,
                        "cleaner_name": "Mario",
                        "tasks": [...]
                    }
                ]
            }
        """
        data = self._get("/api/timeline", {"date": date})
        return data
    
    def save_timeline(self, date: str, timeline_data: Dict) -> Dict:
        """
        Salva timeline su PostgreSQL.
        
        Args:
            date: Data nel formato YYYY-MM-DD
            timeline_data: Dati timeline da salvare
            
        Returns:
            Risposta API con conferma
        """
        payload = {
            "date": date,
            "timeline": timeline_data
        }
        return self._post("/api/timeline", payload)
    
    # ==================== CONTAINERS ====================
    
    def get_containers(self, date: str) -> Dict:
        """
        Carica containers da PostgreSQL.
        
        Args:
            date: Data nel formato YYYY-MM-DD
            
        Returns:
            Containers con structure:
            {
                "containers": {
                    "early_out": {"tasks": [...], "count": N},
                    "high_priority": {"tasks": [...], "count": N},
                    "low_priority": {"tasks": [...], "count": N}
                }
            }
        """
        data = self._get("/api/containers", {"date": date})
        return data
    
    def save_containers(self, date: str, containers_data: Dict) -> Dict:
        """
        Salva containers su PostgreSQL.
        
        Args:
            date: Data nel formato YYYY-MM-DD
            containers_data: Dati containers da salvare
            
        Returns:
            Risposta API con conferma
        """
        payload = {
            "date": date,
            "containers": containers_data
        }
        return self._post("/api/containers", payload)
    
    # ==================== CLEANERS ====================
    
    def get_cleaners(self, date: str) -> List[Dict]:
        """
        Carica lista cleaners da PostgreSQL.
        
        Args:
            date: Data nel formato YYYY-MM-DD
            
        Returns:
            Lista di cleaners con tutti i campi
        """
        data = self._get("/api/cleaners", {"date": date})
        return data.get("cleaners", [])
    
    def get_selected_cleaners(self, date: str) -> List[Dict]:
        """
        Carica cleaners selezionati da PostgreSQL.
        
        Args:
            date: Data nel formato YYYY-MM-DD
            
        Returns:
            Lista di cleaners selezionati
        """
        data = self._get("/api/selected-cleaners", {"date": date})
        return data.get("cleaners", [])
    
    def save_selected_cleaners(self, date: str, cleaner_ids: List[int]) -> Dict:
        """
        Salva cleaners selezionati su PostgreSQL.
        
        Args:
            date: Data nel formato YYYY-MM-DD
            cleaner_ids: Lista di ID cleaners selezionati
            
        Returns:
            Risposta API con conferma
        """
        payload = {
            "date": date,
            "cleaner_ids": cleaner_ids
        }
        return self._post("/api/selected-cleaners", payload)
    
    # ==================== HELPER METHODS ====================
    
    def get_assigned_task_ids(self, date: str) -> set:
        """
        Ottiene set di task_id già assegnati nella timeline.
        
        Args:
            date: Data nel formato YYYY-MM-DD
            
        Returns:
            Set di task_id assegnati
        """
        timeline = self.get_timeline(date)
        assigned = set()
        
        for cleaner_entry in timeline.get("cleaners_assignments", []):
            for task in cleaner_entry.get("tasks", []):
                task_id = task.get("task_id")
                if task_id:
                    assigned.add(int(task_id))
        
        return assigned
    
    def get_assigned_logistic_codes(self, date: str) -> set:
        """
        Ottiene set di logistic_code già assegnati nella timeline.
        
        Args:
            date: Data nel formato YYYY-MM-DD
            
        Returns:
            Set di logistic_code assegnati
        """
        timeline = self.get_timeline(date)
        assigned = set()
        
        for cleaner_entry in timeline.get("cleaners_assignments", []):
            for task in cleaner_entry.get("tasks", []):
                code = task.get("logistic_code")
                if code:
                    assigned.add(str(code))
        
        return assigned
    
    def health_check(self) -> bool:
        """
        Verifica che il server API sia raggiungibile.
        
        Returns:
            True se il server risponde, False altrimenti
        """
        try:
            response = requests.get(
                f"{self.base_url}/api/health", 
                timeout=5
            )
            return response.status_code == 200
        except:
            return False


# ==================== FUNZIONI DI COMPATIBILITÀ ====================
# Per mantenere compatibilità con codice esistente che usa Path

def load_timeline_from_api(date: str) -> Dict:
    """Wrapper per compatibilità."""
    client = ApiClient()
    return client.get_timeline(date)

def save_timeline_to_api(date: str, timeline_data: Dict) -> Dict:
    """Wrapper per compatibilità."""
    client = ApiClient()
    return client.save_timeline(date, timeline_data)

def load_containers_from_api(date: str) -> Dict:
    """Wrapper per compatibilità."""
    client = ApiClient()
    return client.get_containers(date)

def save_containers_to_api(date: str, containers_data: Dict) -> Dict:
    """Wrapper per compatibilità."""
    client = ApiClient()
    return client.save_containers(date, containers_data)

def load_cleaners_from_api(date: str) -> List[Dict]:
    """Wrapper per compatibilità."""
    client = ApiClient()
    return client.get_cleaners(date)

def load_selected_cleaners_from_api(date: str) -> List[Dict]:
    """Wrapper per compatibilità."""
    client = ApiClient()
    return client.get_selected_cleaners(date)


if __name__ == "__main__":
    # Test
    import sys
    
    date = sys.argv[1] if len(sys.argv) > 1 else datetime.now().strftime("%Y-%m-%d")
    
    print(f"🔍 Test API Client per data: {date}")
    
    client = ApiClient()
    
    # Health check
    if client.health_check():
        print("✅ Server API raggiungibile")
    else:
        print("❌ Server API non raggiungibile")
        sys.exit(1)
    
    # Test timeline
    try:
        timeline = client.get_timeline(date)
        assignments = timeline.get("cleaners_assignments", [])
        print(f"✅ Timeline: {len(assignments)} cleaner assignments")
    except Exception as e:
        print(f"❌ Errore timeline: {e}")
    
    # Test containers
    try:
        containers = client.get_containers(date)
        eo = len(containers.get("containers", {}).get("early_out", {}).get("tasks", []))
        hp = len(containers.get("containers", {}).get("high_priority", {}).get("tasks", []))
        lp = len(containers.get("containers", {}).get("low_priority", {}).get("tasks", []))
        print(f"✅ Containers: EO={eo}, HP={hp}, LP={lp}")
    except Exception as e:
        print(f"❌ Errore containers: {e}")
    
    # Test cleaners
    try:
        cleaners = client.get_cleaners(date)
        print(f"✅ Cleaners: {len(cleaners)} disponibili")
    except Exception as e:
        print(f"❌ Errore cleaners: {e}")
    
    # Test selected cleaners
    try:
        selected = client.get_selected_cleaners(date)
        print(f"✅ Selected Cleaners: {len(selected)} selezionati")
    except Exception as e:
        print(f"❌ Errore selected cleaners: {e}")
    
    print("\n🎉 Test completato!")
