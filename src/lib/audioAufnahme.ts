/**
 * Audioaufnahme (VOICE-01, 14-09): die EINZIGE Stelle, die Browser-Audio-APIs berührt —
 * bewusst getrennt vom Zustandsautomaten (`diktat.ts`), damit dieser DOM-frei und unter
 * `environment: 'node'` testbar bleibt (dieselbe Trennung, die `diktat.ts` über
 * Konstruktor-/Funktions-Injektion ohnehin herstellt). Dieses Modul selbst ist NICHT unter
 * `environment: 'node'` testbar (es gibt kein DOM, kein `MediaRecorder`, kein `getUserMedia`)
 * — die Absicherung läuft über den injizierten `aufnehmen`-Parameter in `diktat.test.ts`.
 */

export interface Aufnahme {
  /** Beendet die Aufnahme und liefert die aufgezeichneten Bytes samt tatsächlichem MIME-Typ.
   *  Gibt den Mikrofon-Stream in JEDEM Fall frei — auch wenn dabei ein Fehler auftritt. */
  beenden(): Promise<{ bytes: Uint8Array; mime: string }>;
}

/** Bevorzugte Container-Typen, geprüft in dieser Reihenfolge über `MediaRecorder.isTypeSupported`
 *  (Opus in WebM zuerst — kleinste Bitrate —, dann WebM ohne Codec-Angabe, dann MP4 für Safari,
 *  das kein WebM unterstützt). Liste statt fester Wert: ein künftiger Befund bleibt eine
 *  Ein-Zeilen-Änderung. */
const BEVORZUGTE_MIME_TYPEN: readonly string[] = ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4'];

function bestMimeType(): string | undefined {
  return BEVORZUGTE_MIME_TYPEN.find((t) => typeof MediaRecorder !== 'undefined' && MediaRecorder.isTypeSupported(t));
}

/** Startet die Aufnahme (fordert die Mikrofonberechtigung an — die Promise lehnt ab, wenn die
 *  Nutzerin verweigert oder kein Mikrofon vorhanden ist). */
export async function starteAufnahme(): Promise<Aufnahme> {
  const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
  const mime = bestMimeType();
  const recorder = mime ? new MediaRecorder(stream, { mimeType: mime }) : new MediaRecorder(stream);
  const chunks: Blob[] = [];
  recorder.ondataavailable = (ereignis: BlobEvent): void => {
    if (ereignis.data.size > 0) chunks.push(ereignis.data);
  };
  recorder.start();

  /** Mikrofon-Stream in JEDEM Fall freigeben (auch im Fehlerfall) — sonst bleibt die
   *  Aufnahme-Anzeige des Browsers stehen und suggeriert eine weiterlaufende Aufnahme. */
  function freigeben(): void {
    for (const track of stream.getTracks()) track.stop();
  }

  return {
    beenden(): Promise<{ bytes: Uint8Array; mime: string }> {
      return new Promise((resolve, reject) => {
        recorder.onstop = (): void => {
          const typ = recorder.mimeType || mime || 'audio/webm';
          const blob = new Blob(chunks, { type: typ });
          blob.arrayBuffer()
            .then((buf) => resolve({ bytes: new Uint8Array(buf), mime: typ }))
            .catch((e: unknown) => reject(e instanceof Error ? e : new Error(String(e))))
            .finally(freigeben);
        };
        try {
          recorder.stop();
        } catch (e) {
          freigeben();
          reject(e instanceof Error ? e : new Error(String(e)));
        }
      });
    },
  };
}
