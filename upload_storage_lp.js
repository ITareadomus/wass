
const { Client } = require('@replit/object-storage');
const fs = require('fs');
const client = new Client();
(async () => {
  const data = fs.readFileSync('/tmp/low_priority_assignments.json', 'utf-8');
  await client.uploadFromText('29-10-2025/low_priority_assignments.json', data);
  console.log('✅ Caricato su Object Storage: 29-10-2025/low_priority_assignments.json');
})().catch(console.error);
