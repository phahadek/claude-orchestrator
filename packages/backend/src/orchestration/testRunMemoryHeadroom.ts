const HEADROOM_WARN_FRACTION = 0.9;

export interface HeadroomBreach {
  command: string;
  peakRssMb: number;
  maxRssMb: number;
  fraction: number;
}

export function findHeadroomBreaches(
  stats: { command: string; peakRssMb: number | null }[] | null | undefined,
  maxRssMb: number,
  warnFraction = HEADROOM_WARN_FRACTION,
): HeadroomBreach[] {
  if (!stats || !(maxRssMb > 0)) return [];
  const breaches: HeadroomBreach[] = [];
  for (const s of stats) {
    if (s.peakRssMb === null || s.peakRssMb === undefined) continue;
    const fraction = s.peakRssMb / maxRssMb;
    if (fraction >= warnFraction) {
      breaches.push({
        command: s.command,
        peakRssMb: s.peakRssMb,
        maxRssMb,
        fraction,
      });
    }
  }
  return breaches;
}
