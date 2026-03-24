const fs = require('fs');
const path = 'c:/Users/10996/portfolio-tracker/src/components\Assets/PPF.js';
try {
  let content = fs.readFileSync(path, 'utf8');
  content = content.replace(/\t/g, '        ');
  fs.writeFileSync(path, content, 'utf8');
  console.log('Successfully replaced tabs with spaces');
} catch (err) {
  console.error(err);
  process.exit(1);
}
