/**
 * Gemeinsame Fehlerklasse des Kommandopfads — in ein Blatt-Modul ausgelagert (13-02), damit
 * reine Validator-Module wie `extern.ts` (das VON `commands.ts` importiert wird) CommandError
 * werfen können, ohne einen zirkulären Import commands ↔ extern zu erzeugen (Projekt-Constraint:
 * keine zirkulären Importe). `commands.ts` re-exportiert die Klasse — alle Bestands-Importe
 * (`import { CommandError } from './commands'`) bleiben unverändert funktionsfähig.
 */
export class CommandError extends Error {}
