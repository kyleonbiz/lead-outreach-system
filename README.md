# lead-outreach-system
# Scheduler reactivated

## Hosted service

`docker build -t aurum . && docker run -p 8000:8000 -v aurum-data:/data --env-file .env aurum`

Run exactly **one** instance (one scheduler). Required env: the same values as the GitHub secrets
(`SHEET_ID`, `MS_*`, `SENDER_EMAIL`, `PLACES_API_KEY`, `DISCORD_WEBHOOK_URL`, ...), plus
`GOOGLE_SERVICE_ACCOUNT_JSON` (service-account key) and `APP_API_KEY` (protects the control API).
Optional: `DAILY_SEND_CAP`, `PER_RUN_CAP`, `CAMPAIGN_ID`, `EMAIL_SENDING_ENABLED`.
Open the service URL in a browser for the control panel, and `/dashboard` for the dashboard (sign in with `APP_API_KEY`).
API (send `X-API-Key`): `GET /status`, `POST /jobs/{name}/run`, `POST /sending/pause`, `POST /sending/resume`, `GET|PUT /settings`.
