# QSO Contest Logger

Small web app for serial-only contest logging into Cloudlog.

## What it does

- Logs QSOs to Cloudlog through `POST /index.php/api/qso` using ADIF.
- Writes each successful QSO to a local NDJSON backup file.
- Checks the current callsign against Cloudlog with `logbook_check_callsign`.
- Runs a live callsign lookup through HamDB or QRZ.
- Lets the operator choose the current operator callsign and shows a local operator leaderboard.
- Shows recent QSOs and pre-fills the next sent serial.

## Cloudlog APIs used

This app is built around the current Cloudlog API wiki:

- `POST /index.php/api/qso`
- `POST /index.php/api/logbook_check_callsign`
- `GET /index.php/api/station_info/{apiKey}`
- `GET /index.php/api/recent_qsos/{publicSlug}/{limit}`

Reference:

- https://github.com/magicbug/Cloudlog/wiki/API

## Setup

1. Copy the example env file:

```bash
cp .env.example .env
```

2. Edit `.env` and fill in:

- optionally `HOST=0.0.0.0` to expose the app on your LAN
- `CLOUDLOG_BASE_URL`
- `CLOUDLOG_API_KEY`
- `CLOUDLOG_LOGBOOK_PUBLIC_SLUG`
- optionally `CONTEST_ID` to send an ADIF contest identifier with each QSO
- optionally `CLOUDLOG_STATION_PROFILE_ID`
- optionally `DEFAULT_OPERATOR_CALLSIGN` and `OPERATORS`
- optionally `BACKUP_LOG_FILE`
- optionally `QRZ_USERNAME`, `QRZ_PASSWORD`, and `QRZ_AGENT`

3. Start the app:

```bash
npm start
```

4. Open `http://localhost:8001`

For LAN access, start the app and use one of the `http://<your-lan-ip>:8001` URLs printed in the server log.

## Notes

- The app keeps Cloudlog credentials on the server side.
- Local backup is append-only NDJSON so you can inspect or recover QSOs without Cloudlog.
- Operator stats are calculated from the local backup file, not from Cloudlog.
- The server binds to `HOST` and prints the reachable LAN URLs at startup. If another device still cannot connect, check your OS firewall for the chosen port.
- Callsign lookup now tries both HamDB and QRZ for each query.
- QRZ XML lookup is supported through the documented session flow: first request a session key, then query callsigns with that key.
- If QRZ credentials are missing or invalid, the app degrades gracefully and keeps using HamDB.
- QRZ XML access may require the appropriate QRZ subscription level for live XML data access.
- HamDB coverage is partial worldwide, so the app treats lookup as advisory. Cloudlog logging still works without it.

## QRZ Reference

- https://www.qrz.com/docs/xml/current_spec.html
