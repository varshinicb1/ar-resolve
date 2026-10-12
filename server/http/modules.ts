import type { ModuleApi } from './app.ts';
import { register as ruleStudio } from './routes/rule-studio.ts';

// Each feature workstream adds one entry here and keeps its routes in its own file.
export const MODULES: ((api: ModuleApi) => void)[] = [
  ruleStudio,
];
