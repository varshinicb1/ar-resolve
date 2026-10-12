import type { ModuleApi } from './app.ts';
import { register as kb } from './routes/kb.ts';
import { register as operations } from './routes/operations.ts';
import { register as voice } from './routes/voice.ts';
import { register as ruleStudio } from './routes/rule-studio.ts';
import { register as integrations } from './routes/integrations.ts';
import { register as glue } from './routes/glue.ts';

// Each feature workstream adds one entry here and keeps its routes in its own file.
export const MODULES: ((api: ModuleApi) => void)[] = [
  kb,
  operations,
  voice,
  ruleStudio,
  integrations,
  glue,
];
