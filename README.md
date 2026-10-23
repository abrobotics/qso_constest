# QSO Contest Logger

A small web app to log ham radio contest QSOs **fast**, straight into [Cloudlog](https://github.com/magicbug/Cloudlog).

Type the callsign, type the received exchange, hit Enter: the QSO is sent to Cloudlog, saved to a local backup file, and the next one is ready. It works on any device with a browser (PC, tablet, phone) on your local network, so several operators can log from the same station.

- Two exchange types: **serial numbers** (WPX, most contests) or **CQ zone** (CQ World Wide DX).
- Live dupe check and callsign lookup (QRZ and HamDB).
- Optional live rig frequency with automatic band selection.
- Local backup of every QSO and **Cabrillo export** for log submission.
- Operator leaderboard for multi-op stations.
- No dependencies to install: only Node.js.

---

## Quick start (5 minutes)

### 1. What you need

| Requirement | Why | Where |
| --- | --- | --- |
| **Node.js 18 or newer** | Runs the app | https://nodejs.org (take the "LTS" version) |
| **A Cloudlog instance** | The app logs into your Cloudlog logbook | Your own Cloudlog server, reachable from this computer |
| A QRZ XML subscription *(optional)* | Name, country and CQ zone lookup | https://www.qrz.com |

Check that Node.js is installed by opening a terminal (Windows: *PowerShell*, macOS: *Terminal*) and typing:

```bash
node --version
```

You should see `v18.x` or higher. If you get "command not found", install Node.js from the link above, then close and reopen the terminal.

### 2. Get the app

**With Git:**

```bash
git clone https://github.com/abrobotics/qso_constest.git
cd qso_constest
```

**Without Git:** on the GitHub page, click **Code → Download ZIP**, unzip it, then open a terminal in the unzipped folder.

There is no `npm install` step: the app has no dependencies.

### 3. Collect three things from Cloudlog

Log into your Cloudlog web interface and note:

1. **The Cloudlog URL**, for example `https://cloudlog.example.com`.
2. **A read & write API key**: in Cloudlog, open the API keys page from your account menu and create a key with *read & write* rights.
3. **The public slug of your logbook**: in the Station Logbooks page, edit your logbook and set a *public slug* (a short name such as `f4abc-contest`).

### 4. Configure

Copy the example settings file:

```bash
# macOS / Linux
cp .env.example .env

# Windows (PowerShell)
Copy-Item .env.example .env
```

Open `.env` in any text editor and fill in at least:

```ini
CLOUDLOG_BASE_URL=https://cloudlog.example.com
CLOUDLOG_API_KEY=your-read-write-api-key
CLOUDLOG_LOGBOOK_PUBLIC_SLUG=your-public-slug
DEFAULT_OPERATOR_CALLSIGN=F4ABC
CONTEST_ID=CQ-WPX-SSB
```

Then pick the block for your contest in [Contest presets](#contest-presets) below.

### 5. Start

```bash
npm start
```

Open **http://localhost:8001** in your browser. The status pill at the top of the form must say **Ready**. If it says *Config needed*, the message under the form tells you which setting is missing.

To log from another device (tablet, second PC), use one of the `http://<ip>:8001` addresses printed in the terminal. If it does not load, allow port 8001 in your computer's firewall.

To stop the app, press `Ctrl+C` in the terminal.

---

## Logging a QSO

1. Pick the **operator** (multi-op stations) and the **band**.
2. Type the **callsign**. The lookup panel shows:
   - **Format**: whether the callsign looks valid.
   - **Cloudlog**: `New`, or a dupe warning. A dupe disables the *Log QSO* button.
   - **Callbooks**: name and country from QRZ / HamDB.
3. Type the **received exchange** (serial number or CQ zone).
4. Press **Enter** or click **Log QSO**.

The sent exchange is filled in for you: the next serial number, or your CQ zone. Click **Locked** to unlock and correct it if needed.

---

## Contest presets

Add one of these blocks to your `.env`, then restart the app.

### Serial number contests (CQ WPX, etc.)

The exchange is RST + serial number. This is the default mode.

```ini
CONTEST_ID=CQ-WPX-SSB
DEFAULT_MODE=SSB
EXCHANGE_TYPE=serial
SERIAL_PAD=3
```

The next sent serial is computed from the number of QSOs in the local backup file. Start each contest with an empty or new backup file (see `BACKUP_LOG_FILE`).

### CQ World Wide DX (CQ zone exchange)

The exchange is RST + CQ zone. Example for CQ WW DX SSB 2026 from France (zone 14):

```ini
CONTEST_ID=CQ-WW-SSB
DEFAULT_MODE=SSB
EXCHANGE_TYPE=cqzone
MY_CQ_ZONE=14
CONTEST_START=2026-10-24T00:00:00Z
CONTEST_END=2026-10-25T23:59:59Z
BANDS=160m,80m,40m,20m,15m,10m
```

- The form shows **Received zone / Sent zone** (1 to 40).
- With QRZ configured, the received zone is pre-filled from QRZ. Always check it against what the station actually sends.
- With `CONTEST_START` / `CONTEST_END`, dupes are checked per band **during the contest only**. A station worked before the contest shows as `New (worked before)` and can be logged.
- QSOs are sent to Cloudlog with the ADIF fields `CQZ`, `MY_CQ_ZONE`, `STX_STRING` and `SRX_STRING`.

---

## Submitting your log (Cabrillo)

After the contest, click **Download Cabrillo log** in the right-hand panel (or open http://localhost:8001/api/cabrillo). You get a Cabrillo 3.0 file, built from the local backup, ready to upload to the contest robot.

Set the header categories in `.env` first:

```ini
CABRILLO_CALLSIGN=F4ABC          # defaults to the Cloudlog station callsign
CABRILLO_CATEGORY_OPERATOR=SINGLE-OP   # SINGLE-OP, MULTI-OP, CHECKLOG
CABRILLO_CATEGORY_ASSISTED=NON-ASSISTED
CABRILLO_CATEGORY_BAND=ALL
CABRILLO_CATEGORY_POWER=LOW            # HIGH, LOW, QRP
CABRILLO_CATEGORY_TRANSMITTER=ONE
CABRILLO_NAME=Your Name
CABRILLO_EMAIL=you@example.com
```

Open the file in a text editor and review it before uploading. Only QSOs matching `CONTEST_ID` (and the contest window, when set) are exported. QSOs logged with an older version of the app have no stored frequency or zone and use default values.

---

## Optional features

### Live rig frequency and auto band

Set `RADIO_FREQUENCY_FILE` to a text file that contains the current frequency **in MHz** (for example `14.205`). The app reads it twice a second, shows it, and can select the band automatically (*Auto band* switch). The real frequency is also written to Cloudlog and to the Cabrillo log.

Any tool can write that file. If the file content starts with `#`, the app shows it as a rig error and turns auto band off. Example with Hamlib's `rigctld` running (macOS / Linux):

```bash
while true; do
  hz=$(rigctl -m 2 f) && awk "BEGIN{printf \"%.3f\", $hz/1000000}" > freq.txt || echo "# rig not responding" > freq.txt
  sleep 0.5
done
```

Without a rig file, SSB QSOs use typical phone frequencies (14.200, 7.100…). Use a rig file if you want exact frequencies in your Cabrillo log.

### Callsign lookup

HamDB is always queried (free, mostly US coverage). For worldwide data and CQ zone pre-fill, add your QRZ credentials (requires a QRZ XML subscription):

```ini
QRZ_USERNAME=F4ABC
QRZ_PASSWORD=your-qrz-password
```

If QRZ is not configured or fails, the app keeps working with HamDB only. Lookup is advisory: logging never depends on it.

### Multiple operators

```ini
OPERATORS=F4ABC,F4XYZ,F5DEF
DEFAULT_OPERATOR_CALLSIGN=F4ABC
```

Each device remembers its last selected operator. The leaderboard in the right-hand panel counts QSOs per operator from the local backup (hide it with the *Hide stats* switch).

---

## All settings

All settings live in `.env`. Restart the app after any change.

| Setting | Default | Description |
| --- | --- | --- |
| `CLOUDLOG_BASE_URL` | *required* | Cloudlog URL (with or without `/index.php`) |
| `CLOUDLOG_API_KEY` | *required* | Cloudlog read & write API key |
| `CLOUDLOG_LOGBOOK_PUBLIC_SLUG` | *required* | Public slug of the Cloudlog logbook |
| `CLOUDLOG_STATION_PROFILE_ID` | active profile | Cloudlog station location to log into |
| `HOST` | `0.0.0.0` | `0.0.0.0` = reachable on the LAN, `127.0.0.1` = this computer only |
| `PORT` | `8001` | Web port |
| `CONTEST_ID` | empty | ADIF / Cabrillo contest name, e.g. `CQ-WPX-SSB`, `CQ-WW-SSB` |
| `DEFAULT_MODE` | `SSB` | Mode sent to Cloudlog (`SSB`, `CW`, …) |
| `DEFAULT_RST_SENT` / `DEFAULT_RST_RCVD` | `59` | RST reports |
| `EXCHANGE_TYPE` | `serial` | `serial` or `cqzone` |
| `MY_CQ_ZONE` | empty | Your CQ zone, required with `cqzone` |
| `SERIAL_PAD` | `3` | Digits shown for serials (`001`) |
| `CONTEST_START` / `CONTEST_END` | empty | Contest window in UTC; enables contest-only dupe checking |
| `BANDS` | `160m,…,10m` | Band buttons shown in the form |
| `DEFAULT_OPERATOR_CALLSIGN` | empty | Operator selected by default |
| `OPERATORS` | empty | Comma-separated operator list |
| `BACKUP_LOG_FILE` | `data/qso-backup.ndjson` | Local backup file |
| `RADIO_FREQUENCY_FILE` | empty | Live rig frequency file (MHz) |
| `QRZ_USERNAME` / `QRZ_PASSWORD` | empty | QRZ XML credentials |
| `QRZ_AGENT` | `qso_constest/<version>` | User agent sent to QRZ / HamDB |
| `CABRILLO_*` | see above | Cabrillo header |
| `APP_VERSION` | `x.x.x` | Version shown in the Cabrillo header and user agent |

---

## Backup and safety

- Every QSO accepted by Cloudlog is also appended to `BACKUP_LOG_FILE`, one JSON line per QSO. If Cloudlog goes down after the contest, your log is still there.
- The backup file drives the sent serial, the contest dupe check, the leaderboard and the Cabrillo export. **Use a new backup file per contest** and delete any test QSOs from it before exporting.
- Cloudlog credentials stay on the server; the browser never sees them. Do not expose the app to the internet: it has no login.

---

## Troubleshooting

| Problem | Fix |
| --- | --- |
| `node: command not found` | Install Node.js 18+ and reopen the terminal |
| *Config needed* in the app | The message lists the missing `.env` settings |
| `fetch is not defined` | Your Node.js is too old: install version 18 or newer |
| Cloudlog errors / *Unavailable* | Check the URL and that the API key has **read & write** rights |
| Other devices cannot connect | Use the LAN address printed at startup and allow port 8001 in the firewall |
| `EADDRINUSE` at startup | Port 8001 is taken: change `PORT` in `.env` |
| Callbooks *Unavailable* | Normal without QRZ credentials or internet; logging still works |
| Wrong next serial | The serial comes from the backup file: check `BACKUP_LOG_FILE` |

---

## Technical notes

Cloudlog API endpoints used ([Cloudlog API wiki](https://github.com/magicbug/Cloudlog/wiki/API)):

- `POST /index.php/api/qso` (QSOs sent as ADIF)
- `POST /index.php/api/logbook_check_callsign`
- `GET /index.php/api/station_info/{apiKey}`
- `GET /index.php/api/recent_qsos/{publicSlug}/{limit}`

QRZ lookups use the [QRZ XML interface](https://www.qrz.com/docs/xml/current_spec.html) session flow. Run `npm run check` to syntax-check the code.
