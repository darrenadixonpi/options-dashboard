/// <reference path="./types.ts" />

/** Compile-time guard for shared API types (Phase 3). */
function __typesPhase3Sample(data: SimulateResult): number {
  const theta = data.theta;
  if (theta?.groups?.length) {
    return theta.groups[0].daily[0] ?? theta.todayTheta;
  }
  return data.portfolio.prob_profit;
}

function __typesPhase3State(s: AppState): boolean {
  return s.simDone && s.simResult != null;
}

export {};
