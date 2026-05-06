import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { copyFile, mkdir } from 'fs/promises';
import { existsSync } from 'fs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const projectRoot = join(__dirname, '..');

const optimizerPythonFiles = [
  'server/services/optimizer/phase2_ortools.py',
  'server/services/optimizer/phase4_ortools.py',
  'server/services/optimizer/phase5_ortools.py',
];

async function copyOptimizerPythonFiles() {
  const distDir = join(projectRoot, 'dist');
  await mkdir(distDir, { recursive: true });

  console.log('Copying optimizer Python scripts to dist...');

  for (const relativeSource of optimizerPythonFiles) {
    const sourcePath = join(projectRoot, relativeSource);
    const fileName = relativeSource.split('/').pop();

    if (!fileName) {
      throw new Error(`Invalid source file path: ${relativeSource}`);
    }

    if (!existsSync(sourcePath)) {
      throw new Error(`Missing optimizer Python script: ${sourcePath}`);
    }

    const destPath = join(distDir, fileName);
    await copyFile(sourcePath, destPath);
    console.log(`Copied ${fileName}`);
  }

  console.log('Optimizer Python scripts copied successfully.');
}

copyOptimizerPythonFiles().catch((err) => {
  console.error('Failed to copy optimizer Python scripts:', err);
  process.exit(1);
});
