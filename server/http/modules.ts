import type { ModuleApi } from './app.ts';
import { register as kb } from './routes/kb.ts';

// Each feature workstream adds one entry here and keeps its routes in its own file.
export const MODULES: ((api: ModuleApi) => void)[] = [
  kb,
];
