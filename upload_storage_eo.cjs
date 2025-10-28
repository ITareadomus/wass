
const { Client } = require('@replit/object-storage');
const fs = require('fs');
const client = new Client();
(async () => {
  try {
    const data = fs.readFileSync('/tmp/early_out_assignments.json', 'utf-8');
    await client.uploadFromText('29-10-2025/early_out_assignments.json', data);
    console.log('✅ Caricato su Object Storage: 29-10-2025/early_out_assignments.json');
  } catch (error) {
    console.error('❌ Errore upload Object Storage:', error.message);
    process.exit(1);
  }
})();
