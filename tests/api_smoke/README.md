# API Smoke Tools

These scripts are external HTTP clients for manual kernel testing. They do not import kernel internals, read SQLite, read `kernel/storage`, or access browser profile files.

Start the kernel first:

```bash
cd kernel
docker compose up --build
```

In another shell, run smoke tools from the repository root:

Examples:

```bash
python tests/api_smoke/submit_job.py --create-profile --owner user_or_team_123
python tests/api_smoke/import_cookie_file.py --profile-id p_xxx --external-owner-id user_or_team_123 --format cookie_header --file secrets/bilibili.cookies.txt
python tests/api_smoke/force_strategy.py --job-id j_001 --owner user_or_team_123 --profile-id p_xxx --strategy api_dash --url BV1GJ411x7h7
python tests/api_smoke/poll_job.py --job-id j_001
```

Do not pass real Cookie values as command-line arguments. Put them in an ignored local file and use `--file`.
