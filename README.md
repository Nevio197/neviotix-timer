# NEVIOTIX Timer

Ein eigener lokaler Countdown für OBS: kompaktes Browser-Dock, transparente Starting-/BRB-Anzeigen, Lua-Hotkeys und ein Updater für GitHub Releases.

**Version 1.1.0 · Windows · Node.js 24 oder neuer · MIT**

## Funktionen

- Dauer oder Countdown bis zu einer Uhrzeit, Schnellzeiten und Start/Pause/Fortsetzen.
- Während des Countdowns Zeit hinzufügen oder abziehen, optional nach 00:00 weiterzählen.
- Minimal, Neon und Glass; Farbe, Zifferngröße, Beschriftung und Fortschrittsbalken live ändern.
- Gemeinsamer Timerstand für alle Anzeigen und Szenen.
- Optionale Szenen-Automatik: beim Aktivieren einer Szene starten oder bei 00:00 wechseln.
- OBS-Hotkeys für Start/Pause, Reset und ±1 Minute.
- Updates auf Knopfdruck aus diesem Repository, mit SHA-256-Prüfung vor dem Ersetzen von Dateien.

Das Add-on besteht aus eigenem JavaScript-, HTML-, CSS- und Lua-Code. Es nutzt die Browser-Dock- und Skript-Funktionen von OBS; es ist keine native DLL.

## Einrichtung

1. [Node.js 24 oder neuer](https://nodejs.org/) und [OBS Studio](https://obsproject.com/) mit Browser-Quellen installieren.
2. Das Windows-ZIP aus den [Releases](https://github.com/nevio197/neviotix-timer/releases/latest) nach `%LOCALAPPDATA%\NEVIOTIX-Timer` entpacken. Die Dateien wie `server.cjs` müssen direkt in diesem Ordner liegen.
3. `start.vbs` doppelt anklicken. Der Dienst startet ohne Terminalfenster.
4. In OBS unter **Werkzeuge → Skripte → +** die Datei `neviotix-timer.lua` aus diesem Ordner hinzufügen. Dadurch startet der Dienst künftig mit dieser Szenensammlung.
5. Unter **Docks → Benutzerdefinierte Browser-Docks** einen Dock namens `NEVIOTIX Timer` mit `http://127.0.0.1:18771/` anlegen und unten andocken.
6. Die gewünschte Anzeige als Browser-Quelle hinzufügen, Größe **600 × 160 Pixel**:

| Anzeige | Adresse |
| --- | --- |
| Starting Soon | `http://127.0.0.1:18771/overlay/starting` |
| Be Right Back | `http://127.0.0.1:18771/overlay/brb` |

Die Quellen haben einen transparenten Hintergrund. Die BRB-Anzeige verwendet beim Standardlabel automatisch „WIEDER DA IN“.

Für weitere Szenensammlungen das Lua-Skript dort ebenfalls hinzufügen. Globale Tasten lassen sich unter **OBS → Einstellungen → Hotkeys → NEVIOTIX Timer** belegen. Im Dock funktionieren zusätzlich Leertaste und `R`, solange kein Eingabefeld bearbeitet wird.

## Updates

Im Tab **Updates** auf **Nach Updates suchen** klicken. Eine verfügbare stabile Version lässt sich mit **Update installieren** übernehmen. Der lokale Timer-Dienst wird dabei kurz neu gestartet; der Countdown wird pausiert wiederhergestellt. Während eines aktiven Streams oder einer Aufnahme wird die Installation blockiert.

Das Update prüft Repository, Version, Archivpfade und SHA-256-Werte. Installationsdateien werden gesichert und bei einem fehlgeschlagenen Austausch zurückgesetzt. Timer-Einstellungen unter `%APPDATA%\NEVIOTIX-Timer` und die OBS-Konfiguration bleiben außerhalb des Update-Pakets.

Es werden nur stabile Releases aus `nevio197/neviotix-timer` verwendet. Updates werden nicht ohne Klick installiert. Für Update-Prüfung und Download ist Internet erforderlich; der Countdown selbst läuft lokal.

## Lokale Daten

- Dienst: nur `127.0.0.1:18771`, nicht das gesamte Netzwerk.
- Einstellungen: `%APPDATA%\NEVIOTIX-Timer\state.json`.
- Starterfehler: `%APPDATA%\NEVIOTIX-Timer\launcher.log`.
- Szenen-Automatik nutzt die bestehende lokale OBS-WebSocket-Konfiguration. Deren Zugangsdaten bleiben auf dem Rechner und werden nicht an GitHub gesendet.

Dieses Repository und die Release-Pakete enthalten ausschließlich Add-on-Code und Dokumentation, keine persönlichen OBS-Szenen, Zugangsdaten oder Laufzeitdaten.

## Entwicklung und Releases

Keine zusätzlichen npm-Pakete nötig:

```text
npm run check
npm test
npm run package
```

Der Paketbau verwendet eine feste Dateiliste, sortierte ZIP-Einträge und einen festen Archiv-Zeitstempel. Er erzeugt unter `dist/` das Windows-ZIP, `update-manifest.json` und `SHA256SUMS`.

Für eine neue Version `package.json` und die sichtbare Version in der Dokumentation anpassen, Prüfungen ausführen und einen passenden `vX.Y.Z`-Tag veröffentlichen. Dienst und Starter lesen die Version direkt aus `package.json`. Der Release-Workflow prüft den Tag gegen die Paketversion und lädt die drei Assets zu GitHub Releases hoch.

## English

NEVIOTIX Timer is a local OBS add-on with an adjustable countdown, transparent overlays, three visual styles, optional scene automation, global OBS hotkeys and a manual GitHub updater. It uses OBS browser docks and Lua scripting rather than a native DLL. It has no runtime npm dependencies.

Requirements: Windows, Node.js 24+ and OBS Studio with browser sources. Extract the Windows release ZIP into `%LOCALAPPDATA%\NEVIOTIX-Timer`, run `start.vbs`, add `neviotix-timer.lua` under OBS **Tools → Scripts**, then add the custom browser dock at `http://127.0.0.1:18771/`. Use the overlay URLs above as 600 × 160 browser sources.

Use the **Updates** tab to check and explicitly install stable releases from this repository. Archive paths and SHA-256 hashes are checked before applying an update. Timer settings and OBS configuration are kept separate. The local service binds only to loopback; OBS credentials are never uploaded.

Licensed under [MIT](LICENSE).
