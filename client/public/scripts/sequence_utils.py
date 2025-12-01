#!/usr/bin/env python3
"""
Utility per la normalizzazione delle sequenze.
Regola fondamentale: le straordinarie devono SEMPRE avere sequence=1.
"""

def normalize_sequences(tasks: list) -> list:
    """
    Normalizza le sequenze delle task garantendo che:
    1. Le straordinarie siano SEMPRE prima (sequence=1, 2, ...)
    2. Le altre task MANTENGONO l'ordine originale (non vengono riordinate)
    3. followup sia corretto (False per sequence=1, True per le altre)
    
    IMPORTANTE: Questa funzione NON riordina le task non-straordinaria,
    preservando l'ordine stabilito dagli script precedenti.
    
    Args:
        tasks: Lista di task da normalizzare
        
    Returns:
        Lista di task con sequence e followup corretti
    """
    if not tasks:
        return tasks
    
    # Separa straordinarie dalle altre task PRESERVANDO l'ordine originale
    straordinarie = []
    altre_task = []
    
    for t in tasks:
        if t.get("straordinaria"):
            straordinarie.append(t)
        else:
            altre_task.append(t)
    
    # Ordina SOLO le straordinarie per start_time (se ce ne sono più di una)
    straordinarie.sort(key=lambda t: t.get("start_time") or "00:00")
    
    # Le altre task MANTENGONO l'ordine originale (non ordinare!)
    
    # Combina: straordinarie prima, poi le altre (nell'ordine originale)
    ordered_tasks = straordinarie + altre_task
    
    # Assegna SOLO sequence e followup (non toccare altri campi)
    for idx, task in enumerate(ordered_tasks):
        task["sequence"] = idx + 1
        task["followup"] = idx > 0
    
    return ordered_tasks


def get_straordinaria_end_time(tasks: list) -> str:
    """
    Restituisce l'end_time dell'ultima straordinaria nella lista.
    Utile per calcolare il cursor iniziale per le task successive.
    
    Args:
        tasks: Lista di task
        
    Returns:
        end_time dell'ultima straordinaria o None se non ce ne sono
    """
    straordinarie = [t for t in tasks if t.get("straordinaria")]
    if not straordinarie:
        return None
    
    # Ordina per start_time e prendi l'ultima
    straordinarie.sort(key=lambda t: t.get("start_time") or "00:00")
    return straordinarie[-1].get("end_time")
