import { readFileSync, writeFileSync } from 'fs';
const path = 'test/memory-experiments/exp2-pos-removed-embedding.ts';
let c = readFileSync(path, 'utf8');
c = c.replace('getEmbeddings(controlEmbs.length ? controlTexts : controlTexts)', 'getEmbeddings(controlTexts)');
writeFileSync(path, c);
console.log('Fixed exp2');
