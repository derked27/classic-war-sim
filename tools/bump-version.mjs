// Stamp src/version.js with a fresh build id. Run before committing a change people should pick up (npm run bump).
import { writeFileSync } from 'node:fs';

const id = new Date().toISOString().replace(/\D/g, '').slice(0, 14);
writeFileSync(new URL('../src/version.js', import.meta.url),
  `// Build stamp, bumped by tools/bump-version.mjs (npm run bump). update.js compares it with the deployed copy.\nexport const VERSION = '${id}';\n`);
console.log(`version ${id}`);
