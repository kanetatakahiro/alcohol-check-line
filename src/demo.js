import { readFileSync } from 'node:fs';
import { reconcile } from './reconcile.js';

const fixture = JSON.parse(readFileSync(new URL('../examples/fake-data.json', import.meta.url), 'utf8'));
console.log('架空データによる確認モード（シート更新・LINE送信なし）');
console.table(reconcile(fixture));
