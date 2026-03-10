import { readFileSync } from 'fs';
import { join } from 'path';

export function readPort(): number {
  try {
    const raw = readFileSync(join(process.cwd(), '.port'), 'utf-8').trim();
    const p = parseInt(raw, 10);
    return isNaN(p) ? 3000 : p;
  } catch {
    return 3000;
  }
}
