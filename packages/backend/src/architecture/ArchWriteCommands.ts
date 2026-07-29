import {
  createUnit as storeCreateUnit,
  updateUnit as storeUpdateUnit,
  supersedeUnit as storeSupersedeUnit,
  getUnit,
  type ArchUnit,
  type ArchUnitUpdateFields,
  type NewArchUnitInput,
} from './ArchUnitStore';

/**
 * Thrown when an arch.updateUnit/arch.supersedeUnit intent's base_version no
 * longer matches the unit's current version — the unit advanced under the
 * operator since the intent was composed. Architecture is irreplaceable, so
 * unlike the task store's last-write-wins default, this hard-blocks rather
 * than silently overwriting; the operator re-stages against current.
 */
export class StaleArchUnitVersionError extends Error {
  constructor(
    public readonly unitId: string,
    public readonly baseVersion: number,
    public readonly currentVersion: number,
  ) {
    super(
      `[ArchWriteCommands] stale edit for arch unit "${unitId}": staged against version ${baseVersion}, ` +
        `current version is ${currentVersion}. Re-stage against the current unit.`,
    );
    this.name = 'StaleArchUnitVersionError';
  }
}

/**
 * Thrown when an arch.updateUnit/arch.supersedeUnit intent targets a unit
 * that has already been superseded — a stale edit racing a prior supersede.
 */
export class ArchUnitAlreadySupersededError extends Error {
  constructor(
    public readonly unitId: string,
    public readonly supersededBy: string | undefined,
  ) {
    super(
      `[ArchWriteCommands] arch unit "${unitId}" has already been superseded` +
        (supersededBy ? ` by "${supersededBy}"` : '') +
        ` — re-stage the edit against the successor unit.`,
    );
    this.name = 'ArchUnitAlreadySupersededError';
  }
}

export type NewArchUnitCommandFields = Omit<NewArchUnitInput, 'at'>;

export interface SupersedeUnitResult {
  previous: ArchUnit;
  next: ArchUnit;
}

/**
 * The sanctioned write path atop the arch_unit store, analogous to
 * TaskWriteCommands for tasks. This is the single chokepoint arch.* staged
 * intents apply through — never a raw ArchUnitStore call from the route
 * layer. Read-before-write: an updateUnit/supersedeUnit call re-reads the
 * unit's current state and enforces optimistic-concurrency + supersede
 * blocking before dispatching to the store.
 */
interface ArchWriteCommands {
  createUnit(fields: NewArchUnitCommandFields): Promise<ArchUnit>;
  updateUnit(
    unitId: string,
    baseVersion: number,
    fields: ArchUnitUpdateFields,
  ): Promise<ArchUnit>;
  supersedeUnit(
    unitId: string,
    baseVersion: number,
    replacement: NewArchUnitCommandFields,
  ): Promise<SupersedeUnitResult>;
}

/** Blocks a stale/superseded-target apply before any store write. */
function checkEditable(unitId: string, baseVersion: number): ArchUnit {
  const current = getUnit(unitId);
  if (!current) {
    throw new Error(`[ArchWriteCommands] no arch unit "${unitId}" to edit`);
  }
  if (current.status === 'superseded') {
    throw new ArchUnitAlreadySupersededError(unitId, current.supersededBy);
  }
  if (current.version !== baseVersion) {
    throw new StaleArchUnitVersionError(unitId, baseVersion, current.version);
  }
  return current;
}

export class BackendArchWriteCommands implements ArchWriteCommands {
  async createUnit(fields: NewArchUnitCommandFields): Promise<ArchUnit> {
    return storeCreateUnit({ ...fields, at: new Date().toISOString() });
  }

  async updateUnit(
    unitId: string,
    baseVersion: number,
    fields: ArchUnitUpdateFields,
  ): Promise<ArchUnit> {
    checkEditable(unitId, baseVersion);
    return storeUpdateUnit(unitId, fields, new Date().toISOString());
  }

  async supersedeUnit(
    unitId: string,
    baseVersion: number,
    replacement: NewArchUnitCommandFields,
  ): Promise<SupersedeUnitResult> {
    checkEditable(unitId, baseVersion);
    const at = new Date().toISOString();
    return storeSupersedeUnit(unitId, { ...replacement, at }, at);
  }
}
