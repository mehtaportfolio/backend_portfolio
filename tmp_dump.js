import fs from 'fs';
const path = './src/services/angelOneService.js';
const buf = fs.readFileSync(path);
console.log('len', buf.length);
console.log('hex', buf.slice(0, 200).toString('hex'));
console.log('text', buf.slice(0, 600).toString('utf8'));
