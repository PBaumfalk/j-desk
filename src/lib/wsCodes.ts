/** Übersetzt server-seitige Zugriffsverlust-Close-Codes; null = normaler Abriss (Reconnect). */
export function accessLossMessage(code: number): string | null {
  if (code === 4001) return 'Schreibtisch wurde gelöscht';
  if (code === 4003) return 'Zugriff wurde entzogen';
  return null;
}
