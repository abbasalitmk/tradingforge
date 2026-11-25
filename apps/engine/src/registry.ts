import type { Sql } from '@tradeforger/db';
import { STRATEGY_CATALOG, getStrategy, clampParams, type Params } from '@tradeforger/strategy';

export type VersionStatus = 'CANDIDATE' | 'VALIDATED' | 'REJECTED' | 'APPROVED' | 'RETIRED';
export type VersionOrigin = 'DEFAULT' | 'AI_PROPOSAL' | 'MANUAL';

export interface StrategyVersion {
  readonly id: string;
  readonly strategyId: string;
  readonly version: number;
  readonly params: Params;
  status: VersionStatus;
  readonly origin: VersionOrigin;
  readonly hypothesis: string | null;
  validation: unknown;
  readonly createdAt: number;
  validatedAt: number | null;
  approvedAt: number | null;
  approvedBy: string | null;
}

interface Row {
  id: string; strategy_id: string; version: number; params: Params; status: VersionStatus;
  origin: VersionOrigin; hypothesis: string | null; validation: unknown;
  created_at: Date; validated_at: Date | null; approved_at: Date | null; approved_by: string | null;
}

const fromRow = (r: Row): StrategyVersion => ({
  id: r.id, strategyId: r.strategy_id, version: r.version, params: r.params, status: r.status,
  origin: r.origin, hypothesis: r.hypothesis, validation: r.validation,
  createdAt: r.created_at.getTime(), validatedAt: r.validated_at?.getTime() ?? null,
  approvedAt: r.approved_at?.getTime() ?? null, approvedBy: r.approved_by,
});

/**
 * Versioned strategy parameters and the evidence behind each.
 *
 * The rule that makes the research loop safe is enforced here, not in the UI:
 * automated validation can move a version to VALIDATED or REJECTED, and only
 * an explicit human `approve()` makes it APPROVED — the one status LIVE
 * trading will use. An AI that proposes a change can never also sign it off.
 */
export class StrategyRegistry {
  private readonly sql: Sql;
  private readonly versions = new Map<string, StrategyVersion>();

  constructor(sql: Sql) {
    this.sql = sql;
  }

  /** Load every version; seed a v1 DEFAULT for any catalog strategy that has none. */
  async load(): Promise<void> {
    const rows = await this.sql<Row[]>`SELECT * FROM strategy_versions ORDER BY strategy_id, version`;
    for (const r of rows) this.versions.set(r.id, fromRow(r));
    for (const def of STRATEGY_CATALOG) {
      if (!this.list(def.id).length) await this.add(def.id, def.defaults, 'DEFAULT', null);
    }
  }

  list(strategyId?: string): StrategyVersion[] {
    return [...this.versions.values()]
      .filter((v) => strategyId === undefined || v.strategyId === strategyId)
      .sort((a, b) => a.strategyId.localeCompare(b.strategyId) || b.version - a.version);
  }

  get(id: string): StrategyVersion | null {
    return this.versions.get(id) ?? null;
  }

  approved(strategyId: string): StrategyVersion | null {
    return this.list(strategyId).find((v) => v.status === 'APPROVED') ?? null;
  }

  /**
   * Validation verdict on the parameters the live analyzer actually runs (see
   * `activeParams`): the approved version, else the version holding the
   * catalog defaults. Null when those parameters were never validated.
   */
  activeVerdict(strategyId: string): { status: 'APPROVED' | 'VALIDATED' | 'REJECTED'; oosExpectancyR: number | null } | null {
    const valOf = (v: StrategyVersion) => v.validation as { status?: string; outOfSample?: { expectancyR?: number } } | null;
    const oos = (v: StrategyVersion): number | null => valOf(v)?.outOfSample?.expectancyR ?? null;
    const approved = this.approved(strategyId);
    if (approved) {
      // Never hide a REJECTED validation report behind APPROVED status.
      const reportStatus = valOf(approved)?.status;
      return { status: reportStatus === 'REJECTED' ? 'REJECTED' : 'APPROVED', oosExpectancyR: oos(approved) };
    }
    const def = getStrategy(strategyId);
    if (!def) return null;
    const key = (p: Params): string => JSON.stringify(Object.entries(clampParams(def, p)).sort(([a], [b]) => a.localeCompare(b)));
    const active = key(def.defaults);
    const v = this.list(strategyId)
      .filter((x) => x.validation !== null && x.validation !== undefined && key(x.params) === active)
      .sort((a, b) => b.version - a.version)[0];
    if (!v || (v.status !== 'VALIDATED' && v.status !== 'REJECTED')) return null;
    return { status: v.status, oosExpectancyR: oos(v) };
  }

  /** Params the live analyzer runs: the approved version where one exists, else defaults. */
  activeParams(): Record<string, Params> {
    const out: Record<string, Params> = {};
    for (const def of STRATEGY_CATALOG) out[def.id] = this.approved(def.id)?.params ?? def.defaults;
    return out;
  }

  async add(strategyId: string, params: Params, origin: VersionOrigin, hypothesis: string | null): Promise<StrategyVersion> {
    const def = getStrategy(strategyId);
    if (!def) throw new Error(`unknown strategy ${strategyId}`);
    const clamped = clampParams(def, params);
    const version = Math.max(0, ...this.list(strategyId).map((v) => v.version)) + 1;
    const id = `${strategyId}@v${version}`;
    const [row] = await this.sql<Row[]>`
      INSERT INTO strategy_versions (id, strategy_id, version, params, status, origin, hypothesis)
      VALUES (${id}, ${strategyId}, ${version}, ${this.sql.json(clamped as never)}, 'CANDIDATE', ${origin}, ${hypothesis})
      RETURNING *`;
    const v = fromRow(row!);
    this.versions.set(v.id, v);
    return v;
  }

  /** Automated checks decide VALIDATED or REJECTED — never APPROVED. */
  async recordValidation(id: string, passed: boolean, report: unknown): Promise<StrategyVersion> {
    const v = this.require(id);
    if (v.status === 'APPROVED' || v.status === 'RETIRED') {
      // Re-validating a live version records evidence without changing its status.
      await this.sql`UPDATE strategy_versions SET validation = ${this.sql.json(report as never)}, validated_at = now() WHERE id = ${id}`;
      v.validation = report;
      v.validatedAt = Date.now();
      return v;
    }
    const status: VersionStatus = passed ? 'VALIDATED' : 'REJECTED';
    await this.sql`
      UPDATE strategy_versions SET status = ${status}, validation = ${this.sql.json(report as never)}, validated_at = now()
      WHERE id = ${id}`;
    v.status = status;
    v.validation = report;
    v.validatedAt = Date.now();
    return v;
  }

  /** Human sign-off. Only a VALIDATED version qualifies; the previous approval is retired. */
  async approve(id: string, by: string): Promise<StrategyVersion> {
    const v = this.require(id);
    if (v.status !== 'VALIDATED') {
      throw new Error(`${id} is ${v.status}; only a VALIDATED version can be approved`);
    }
    const prev = this.approved(v.strategyId);
    await this.sql.begin(async (tx) => {
      if (prev) await tx`UPDATE strategy_versions SET status = 'RETIRED' WHERE id = ${prev.id}`;
      await tx`UPDATE strategy_versions SET status = 'APPROVED', approved_at = now(), approved_by = ${by} WHERE id = ${id}`;
    });
    if (prev) prev.status = 'RETIRED';
    v.status = 'APPROVED';
    v.approvedAt = Date.now();
    v.approvedBy = by;
    return v;
  }

  async retire(id: string): Promise<StrategyVersion> {
    const v = this.require(id);
    await this.sql`UPDATE strategy_versions SET status = 'RETIRED' WHERE id = ${id}`;
    v.status = 'RETIRED';
    return v;
  }

  private require(id: string): StrategyVersion {
    const v = this.versions.get(id);
    if (!v) throw new Error(`unknown strategy version ${id}`);
    return v;
  }
}
