FROM mcr.microsoft.com/playwright/python:v1.49.1-noble

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    KERNEL_DATA_DIR=/data \
    KERNEL_HOST=0.0.0.0 \
    KERNEL_PORT=8000 \
    PLAYWRIGHT_BROWSER_CHANNEL=chrome \
    MSE_CAPTURE_MS=45000 \
    MSE_PLAYBACK_RATE=4.0 \
    MSE_MAX_SEGMENT_BYTES=16777216 \
    MSE_MAX_CAPTURE_BYTES=536870912 \
    MSE_MAX_SEGMENTS=4096 \
    LOGIN_SESSION_TIMEOUT_SECONDS=180 \
    LOGIN_POLL_INTERVAL_SECONDS=3 \
    LOGIN_QR_REFRESH_SECONDS=60 \
    BILIBILI_LOGIN_URL=https://passport.bilibili.com/login

WORKDIR /app

RUN apt-get update \
    && apt-get install -y --no-install-recommends ffmpeg curl ca-certificates \
    && rm -rf /var/lib/apt/lists/*

COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt
RUN playwright install chrome

# Optional branded headless runtime: keeps AAC/MSE codecs while avoiding the
# full desktop Chrome startup overhead on small VPS machines.
ARG CHROME_SHELL_VERSION=152.0.7977.82
RUN curl -fsSL "https://storage.googleapis.com/chrome-for-testing-public/${CHROME_SHELL_VERSION}/linux64/chrome-headless-shell-linux64.zip" -o /tmp/bmusic-shell.zip \
    && python -c "import zipfile,os; zipfile.ZipFile('/tmp/bmusic-shell.zip').extractall('/opt'); os.chmod('/opt/chrome-headless-shell-linux64/chrome-headless-shell',0o755)" \
    && rm /tmp/bmusic-shell.zip

COPY app ./app
COPY docs ./docs

RUN mkdir -p /data/profiles /data/artifacts

EXPOSE 8000

CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8000", "--workers", "1"]
