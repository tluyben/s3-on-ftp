import { readFileSync } from 'fs';
import { join } from 'path';

export function readPort(): number {
  if (process.env.PORT) {
    const p = parseInt(process.env.PORT, 10);
    if (!isNaN(p)) return p;
  }
  try {
    const raw = readFileSync(join(process.cwd(), '.port'), 'utf-8').trim();
    const p = parseInt(raw, 10);
    return isNaN(p) ? 3000 : p;
  } catch {
    return 3000;
  }
}
