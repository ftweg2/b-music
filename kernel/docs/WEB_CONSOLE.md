# Web Console

`tests/webui/` is a manual acceptance console for the kernel HTTP API.

It is not a backend, frontend product, user system, or platform UI.

## Rules

- It must call the kernel only through HTTP APIs with `fetch`.
- It must not import kernel code.
- It must not read SQLite.
- It must not read `kernel/storage`.
- It must not read artifact files directly.
- It must not access browser profile files.
- It must not display Cookie values.
- It must clear Cookie text immediately after import submission.

## Start

```bash
cd kernel
docker compose up --build
```

In another shell:

```bash
cd tests/webui
python -m http.server 9000
```

Open `http://localhost:9000`.

Default kernel base URL is `http://localhost:8000` and can be changed in the page.
