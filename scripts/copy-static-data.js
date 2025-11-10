import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { copyFile, mkdir } from 'fs/promises';
import { existsSync } from 'fs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const projectRoot = join(__dirname, '..');

const staticFiles = [
  'client/public/data/cleaners/cleaners.json',
  'client/public/data/cleaners/cleaners_aliases.json',
  'client/public/data/accounts.json',
  'client/public/data/input/settings.json',
  'client/public/data/input/operations.json',
];

async function copyStaticData() {
  console.log('📦 Copying static data files for production...');
  
  for (const file of staticFiles) {
    const sourcePath = join(projectRoot, file);
    const destPath = join(projectRoot, 'dist/public', file.replace('client/public/', ''));
    
    if (!existsSync(sourcePath)) {
      console.warn(`⚠️  Source file not found: ${sourcePath}`);
      continue;
    }
    
    const destDir = dirname(destPath);
    await mkdir(destDir, { recursive: true });
    
    await copyFile(sourcePath, destPath);
    console.log(`✅ Copied: ${file}`);
  }
  
  console.log('✨ Static data files copied successfully!');
}

copyStaticData().catch(err => {
  console.error('❌ Error copying static data:', err);
  process.exit(1);
});
