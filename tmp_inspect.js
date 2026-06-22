import fs from 'fs';
const path = './src/services/angelOneService.js';
const text = fs.readFileSync(path, 'utf8');
const lines = text.split(/\r?\n/);
for (let i = 0; i < Math.min(lines.length, 200); i++) {
  console.log(`${i+1}: ${lines[i]}`);
}
