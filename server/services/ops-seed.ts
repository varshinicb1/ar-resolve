// Reference data for the operations workstream: business calendars, the seeded
// review-interval policy per client and the draft attribution rule.
import type { Db } from '../db/db.ts';
import { seedCalendars } from './calendar.ts';
import { seedAttribution } from './outcomes.ts';

export function seedOperations(db: Db): void {
  seedCalendars(db);
  seedAttribution(db);
}
