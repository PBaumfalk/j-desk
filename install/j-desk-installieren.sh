#!/usr/bin/env bash
#
# J-DESK auf einem Linux-Server einrichten — ohne Docker.
#
# Richtet Node 22, den Programmordner, einen eigenen Benutzer und einen systemd-Dienst ein,
# sodass J-DESK beim Serverstart automatisch mitläuft.
#
# Aufruf (als root oder mit sudo):
#     sudo bash j-desk-installieren.sh
#
# Der Docker-Weg ist der empfohlene. Dieses Skript ist für Server gedacht, auf denen Docker
# nicht in Frage kommt. Es fragt vor jedem Schritt, der etwas verändert.
#
# Getestet für: Debian 12, Ubuntu 22.04/24.04.

set -euo pipefail

# ── Einstellungen ────────────────────────────────────────────────────────────────
DIENST_NAME="j-desk"
ZIEL_ORDNER="/opt/j-desk"
DATEN_ORDNER="/var/lib/j-desk"
BENUTZER="j-desk"
NODE_HAUPTVERSION="22"
QUELLE="https://github.com/PBaumfalk/j-desk.git"

# ── Ausgabe ──────────────────────────────────────────────────────────────────────
rot=$'\033[31m'; gruen=$'\033[32m'; gelb=$'\033[33m'; fett=$'\033[1m'; normal=$'\033[0m'

schritt()  { printf '\n%s▸ %s%s\n' "$fett" "$1" "$normal"; }
hinweis()  { printf '  %s\n' "$1"; }
erfolg()   { printf '  %s✓ %s%s\n' "$gruen" "$1" "$normal"; }
warnung()  { printf '  %s! %s%s\n' "$gelb" "$1" "$normal"; }
abbruch()  { printf '\n%sAbbruch: %s%s\n\n' "$rot" "$1" "$normal" >&2; exit 1; }

frage() {
  # frage "Text" → 0 bei Ja, 1 bei Nein. Bei -j/--ja ohne Rückfrage Ja.
  if [ "${OHNE_RUECKFRAGE:-nein}" = "ja" ]; then return 0; fi
  local antwort
  read -r -p "  $1 [j/N] " antwort </dev/tty || return 1
  [[ "$antwort" =~ ^([jJ]|[yY])$ ]]
}

OHNE_RUECKFRAGE="nein"
[[ "${1:-}" =~ ^(-j|--ja)$ ]] && OHNE_RUECKFRAGE="ja"

# ── Vorprüfungen ─────────────────────────────────────────────────────────────────
schritt "Vorprüfung"

[ "$(id -u)" -eq 0 ] || abbruch "Bitte mit sudo ausführen: sudo bash $0"

command -v systemctl >/dev/null 2>&1 || abbruch \
  "Dieses Skript braucht systemd. Auf diesem System ist es nicht vorhanden — bitte den Docker-Weg verwenden."

for werkzeug in curl git; do
  command -v "$werkzeug" >/dev/null 2>&1 || abbruch \
    "Das Programm '$werkzeug' fehlt. Nachinstallieren mit: apt install $werkzeug"
done

erfolg "System geeignet (systemd vorhanden, curl und git vorhanden)"

if [ -d "$ZIEL_ORDNER" ]; then
  warnung "Der Ordner $ZIEL_ORDNER existiert bereits."
  frage "Vorhandene Installation aktualisieren?" || abbruch "Vom Benutzer abgebrochen."
  AKTUALISIERUNG="ja"
else
  AKTUALISIERUNG="nein"
fi

# ── Node ─────────────────────────────────────────────────────────────────────────
schritt "Node $NODE_HAUPTVERSION prüfen"

node_passt="nein"
if command -v node >/dev/null 2>&1; then
  vorhanden="$(node -v | sed 's/^v//' | cut -d. -f1)"
  if [ "$vorhanden" = "$NODE_HAUPTVERSION" ]; then
    node_passt="ja"
    erfolg "Node $(node -v) ist bereits vorhanden"
  else
    warnung "Node v$vorhanden ist vorhanden, benötigt wird Version $NODE_HAUPTVERSION."
  fi
else
  hinweis "Node ist nicht vorhanden."
fi

if [ "$node_passt" = "nein" ]; then
  hinweis "Node $NODE_HAUPTVERSION wird aus der offiziellen NodeSource-Paketquelle eingerichtet."
  frage "Fortfahren?" || abbruch "Ohne Node $NODE_HAUPTVERSION kann J-DESK nicht laufen."
  curl -fsSL "https://deb.nodesource.com/setup_${NODE_HAUPTVERSION}.x" | bash -
  apt-get install -y nodejs
  erfolg "Node $(node -v) eingerichtet"
fi

# ── Benutzer ─────────────────────────────────────────────────────────────────────
schritt "Dienstbenutzer"

if id "$BENUTZER" >/dev/null 2>&1; then
  erfolg "Benutzer '$BENUTZER' existiert bereits"
else
  # Eigener Benutzer ohne Anmeldemöglichkeit: Läuft der Dienst später doch einmal
  # in einen Fehler, ist der Schaden auf dessen eigene Dateien begrenzt.
  useradd --system --home-dir "$DATEN_ORDNER" --create-home --shell /usr/sbin/nologin "$BENUTZER"
  erfolg "Benutzer '$BENUTZER' angelegt (ohne Anmelderecht, nur für den Dienst)"
fi

# ── Programm holen ───────────────────────────────────────────────────────────────
schritt "Programm einrichten"

if [ "$AKTUALISIERUNG" = "ja" ]; then
  git -C "$ZIEL_ORDNER" fetch --tags --quiet
  git -C "$ZIEL_ORDNER" checkout --quiet "$(git -C "$ZIEL_ORDNER" describe --tags --abbrev=0 origin/main 2>/dev/null || echo main)"
  git -C "$ZIEL_ORDNER" pull --quiet --ff-only || true
  erfolg "Quelltext aktualisiert"
else
  git clone --quiet "$QUELLE" "$ZIEL_ORDNER"
  # Auf die neueste veröffentlichte Version stellen statt auf den Entwicklungsstand.
  letzte_version="$(git -C "$ZIEL_ORDNER" describe --tags --abbrev=0 2>/dev/null || true)"
  if [ -n "$letzte_version" ]; then
    git -C "$ZIEL_ORDNER" checkout --quiet "$letzte_version"
    erfolg "Version $letzte_version geholt"
  else
    warnung "Keine veröffentlichte Version gefunden — es wird der Hauptzweig verwendet."
  fi
fi

mkdir -p "$DATEN_ORDNER"
chown -R "$BENUTZER:$BENUTZER" "$DATEN_ORDNER"

schritt "Abhängigkeiten und Bauvorgang"
hinweis "Das dauert einige Minuten."
( cd "$ZIEL_ORDNER" && npm ci --silent && npm run build --silent )
chown -R "$BENUTZER:$BENUTZER" "$ZIEL_ORDNER"
erfolg "Programm gebaut"

# ── Einstellungen ────────────────────────────────────────────────────────────────
schritt "Einstellungen"

EINSTELLUNGEN="/etc/j-desk.env"
if [ -f "$EINSTELLUNGEN" ]; then
  erfolg "Vorhandene Einstellungen unter $EINSTELLUNGEN bleiben unverändert"
else
  cat > "$EINSTELLUNGEN" <<'EOF'
# J-DESK — Einstellungen. Nach jeder Änderung:  systemctl restart j-desk

PORT=4810
DATA_DIR=/var/lib/j-desk

# Verbindung zu j-lawyer.
#   Gesetzt → Anmeldung über j-lawyer, Akten kommen von dort (Normalfall).
#   Leer    → J-DESK arbeitet eigenständig, erste Anmeldung legt das Konto an.
# Das "/j-lawyer-io" am Ende gehört dazu.
#JLAWYER_URL=http://kanzlei-server:8080/j-lawyer-io

# Vorschau für Word- und Excel-Dateien (freiwillig, braucht einen DocumentServer)
#EUROOFFICE_URL=
#EUROOFFICE_JWT_SECRET=
#PUBLIC_URL=http://localhost:4810

# Anonymisierung (freiwillig)
#ANYMIZE_API_KEY=
EOF
  chmod 640 "$EINSTELLUNGEN"
  chown root:"$BENUTZER" "$EINSTELLUNGEN"
  erfolg "Einstellungen angelegt: $EINSTELLUNGEN"
fi

# ── Dienst ───────────────────────────────────────────────────────────────────────
schritt "systemd-Dienst"

cat > "/etc/systemd/system/${DIENST_NAME}.service" <<EOF
[Unit]
Description=J-DESK — visuelle juristische Arbeitsebene
Documentation=https://github.com/PBaumfalk/j-desk
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=$BENUTZER
Group=$BENUTZER
WorkingDirectory=$ZIEL_ORDNER
EnvironmentFile=$EINSTELLUNGEN
Environment=NODE_ENV=production
Environment=WEB_DIR=$ZIEL_ORDNER/build
ExecStart=/usr/bin/npx tsx packages/server/src/main.ts
Restart=on-failure
RestartSec=5

# Absicherung: Der Dienst darf nur in sein eigenes Datenverzeichnis schreiben.
NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=strict
ProtectHome=true
ReadWritePaths=$DATEN_ORDNER

[Install]
WantedBy=multi-user.target
EOF

systemctl daemon-reload
systemctl enable --quiet "$DIENST_NAME"
erfolg "Dienst eingerichtet (startet künftig automatisch mit dem Server)"

schritt "Dienst starten"
systemctl restart "$DIENST_NAME"

# Kurz warten und nachsehen, ob er auch oben bleibt — ein Dienst, der sofort wieder
# abstürzt, meldet beim Start trotzdem keinen Fehler.
sleep 3
if systemctl is-active --quiet "$DIENST_NAME"; then
  port="$(grep -E '^PORT=' "$EINSTELLUNGEN" | cut -d= -f2 || echo 4810)"
  adresse="$(hostname -I 2>/dev/null | awk '{print $1}')"
  erfolg "J-DESK läuft"
  printf '\n%sFertig.%s\n\n' "$fett" "$normal"
  printf '  Erreichbar unter:  http://%s:%s\n' "${adresse:-<server-adresse>}" "$port"
  printf '  Einstellungen:     %s\n' "$EINSTELLUNGEN"
  printf '  Daten (sichern!):  %s\n' "$DATEN_ORDNER"
  printf '\n  Zustand ansehen:   systemctl status %s\n' "$DIENST_NAME"
  printf '  Protokoll:         journalctl -u %s -f\n\n' "$DIENST_NAME"
else
  printf '\n'
  warnung "Der Dienst wurde gestartet, läuft aber nicht mehr."
  hinweis "Ursache steht im Protokoll:"
  hinweis "    journalctl -u $DIENST_NAME -n 50 --no-pager"
  exit 1
fi
