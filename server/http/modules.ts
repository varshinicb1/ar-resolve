import type { ModuleApi } from './app.ts';
import { register as integrations } from './routes/integrations.ts';

// Each feature workstream adds one entry here and keeps its routes in its own file.
export const MODULES: ((api: ModuleApi) => void)[] = [
  integrations,
];
