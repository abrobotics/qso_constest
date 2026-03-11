# QSO Contest Logger

Small web app for serial-exchange contest logging into Cloudlog.

## What it does

- Logs QSOs to Cloudlog through `POST /index.php/api/qso` using ADIF.
- Checks the current callsign against Cloudlog with `logbook_check_callsign`.
- Runs a live callsign lookup through HamDB by default.
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

- `CLOUDLOG_BASE_URL`
- `CLOUDLOG_API_KEY`
- `CLOUDLOG_LOGBOOK_PUBLIC_SLUG`
- optionally `CLOUDLOG_STATION_PROFILE_ID`

3. Start the app:

```bash
npm start
```

4. Open `http://localhost:3000`

## Notes

- The app keeps Cloudlog credentials on the server side.
- QRZ XML lookup is not the default because QRZ XML access is a paid feature. HamDB is used instead as a no-auth fallback.
- HamDB coverage is partial worldwide, so the app treats lookup as advisory. Cloudlog logging still works without it.
