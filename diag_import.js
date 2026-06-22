import { promises as fs } from 'fs';
import { resolve } from 'path';

async function main() {
  const target = resolve('src/controllers/buyOrderController.js');
  console.log('target', target);
  try {
    const module = await import('file://' + target.replace(/\\/g, '/'));
    console.log('imported', Object.keys(module));
  } catch (e) {
    console.error('import failed');
    console.error(e.stack || e);
    process.exit(1);
  }
}

main();
