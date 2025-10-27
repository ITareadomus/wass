
import os
import json
import psycopg2
from datetime import date, datetime

def json_serial(obj):
    """JSON serializer per oggetti datetime/date"""
    if isinstance(obj, (datetime, date)):
        return obj.isoformat()
    raise TypeError(f"Type {type(obj)} not serializable")

def get_pg_connection():
    database_url = os.environ.get('DATABASE_URL')
    if not database_url:
        raise Exception("DATABASE_URL environment variable not set")
    return psycopg2.connect(database_url)

def export_table(cursor, table_name):
    """Esporta una tabella in formato lista di dizionari"""
    cursor.execute(f"SELECT * FROM {table_name}")
    columns = [desc[0] for desc in cursor.description]
    rows = cursor.fetchall()
    
    result = []
    for row in rows:
        result.append(dict(zip(columns, row)))
    
    return result

def main():
    conn = get_pg_connection()
    cur = conn.cursor()
    
    # Lista delle tabelle da esportare
    tables = [
        'operations',
        'cleaners',
        'tasks',
        'timeline_assignments',
        'confirmed_assignments',
        'personnel',
        'assignments'
    ]
    
    export_data = {
        'exported_at': datetime.now().isoformat(),
        'tables': {}
    }
    
    for table in tables:
        try:
            print(f"Esportando {table}...")
            export_data['tables'][table] = export_table(cur, table)
            print(f"  ✅ {len(export_data['tables'][table])} righe esportate")
        except Exception as e:
            print(f"  ⚠️  Errore: {e}")
            export_data['tables'][table] = []
    
    cur.close()
    conn.close()
    
    # Salva in JSON
    output_file = 'client/public/data/output/database_export.json'
    with open(output_file, 'w', encoding='utf-8') as f:
        json.dump(export_data, f, indent=2, ensure_ascii=False, default=json_serial)
    
    print(f"\n✅ Database esportato in: {output_file}")
    
    # Statistiche
    total_rows = sum(len(rows) for rows in export_data['tables'].values())
    print(f"\nStatistiche:")
    print(f"  - Tabelle esportate: {len(tables)}")
    print(f"  - Righe totali: {total_rows}")

if __name__ == "__main__":
    main()
