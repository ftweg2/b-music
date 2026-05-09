# Kernel WebUI Acceptance Tool

This is a manual test console for the kernel HTTP API. It is not a backend, not a product frontend, and not a user system.

Rules:

- Calls the kernel only through HTTP APIs.
- Does not import kernel code.
- Does not read SQLite.
- Does not read `kernel/storage`.
- Does not read artifact files directly.
- Does not access browser profile files.
- Does not display Cookie values.
- Displays only the QR screenshot URL returned by the kernel login API.
- Does not receive QR token internals, cookies, storage state, or sensitive headers.

Start:

```bash
cd kernel
docker compose up --build
```

In another shell:

```bash
cd ../tests/webui
python -m http.server 9000
```

Open:

```text
http://localhost:9000
```

Default kernel base URL is `http://localhost:8000`, and can be changed on the page.

QR login flow:

1. Create a profile for an `external_owner_id`.
2. Click "启动扫码登录".
3. Scan the QR image displayed by the page.
4. Poll login status until sanitized identity fields appear.
