// Ported from clinic-receptionist src/core/registry.ts (same owner).
// A named set of interchangeable implementations of one layer (call engines, notification
// connectors, guard profiles). A new vendor or profile is added by registering it, not by editing
// the code that uses it. Choosing is "first available in the configured order", which is also how
// fallbacks work. Adapted for AR Resolve: `available()` takes a plain settings record (process.env
// by default) instead of a Cloudflare Worker Env binding.

export type Settings = Record<string, string | undefined>;

export interface Pluggable {
  /** Stable id used in config and the database. Lowercase, no spaces. */
  readonly id: string;
  /** One line for screens and logs. */
  readonly label?: string;
  /** Can this implementation run with these settings? Absent means always. */
  available?(settings: Settings): boolean;
}

/** Something that sends data to outside companies, which then need a BAA before PHI may flow. */
export interface DataProcessor {
  /** Vendor ids as written in the vendor/BAA register (lowercase): "twilio", "availity"... */
  readonly vendors: readonly string[];
}

export class Registry<T extends Pluggable> {
  private readonly items = new Map<string, T>();
  readonly layer: string;
  private readonly defaultOrder: string[];

  constructor(layer: string, defaultOrder: string[] = []) {
    this.layer = layer;
    this.defaultOrder = defaultOrder;
  }

  register(item: T): this {
    if (!/^[a-z0-9][a-z0-9_-]*$/.test(item.id)) throw new Error(`${this.layer} id "${item.id}" must be lowercase letters, digits, - or _`);
    this.items.set(item.id, item);
    return this;
  }

  get(id: string): T | undefined { return this.items.get(id); }

  require(id: string): T {
    const item = this.items.get(id);
    if (!item) throw new Error(`no ${this.layer} "${id}" (have: ${this.ids().join(', ') || 'none'})`);
    return item;
  }

  ids(): string[] { return [...this.items.keys()]; }
  list(): T[] { return [...this.items.values()]; }

  /** The configured order: a comma list (unknown ids ignored), else the default order, else registration order. */
  order(configured?: string | null): T[] {
    const wanted = (configured ?? '').split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);
    const ids = wanted.length ? wanted : this.defaultOrder.length ? this.defaultOrder : this.ids();
    return ids.map((id) => this.items.get(id)).filter((x): x is T => !!x);
  }

  candidates(settings: Settings, configured?: string | null): T[] {
    return this.order(configured).filter((x) => !x.available || x.available(settings));
  }

  pick(settings: Settings, configured?: string | null): T | undefined {
    return this.candidates(settings, configured)[0];
  }
}
