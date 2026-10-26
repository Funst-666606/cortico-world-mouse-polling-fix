import { writeFileSync } from 'node:fs';
import { DESCRIBE } from '../src/describe.js';

writeFileSync(new URL('../describe.json', import.meta.url), `${JSON.stringify(DESCRIBE, null, 2)}\n`);
console.log('wrote describe.json');
