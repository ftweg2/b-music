FROM mcr.microsoft.com/playwright/python:v1.49.1-noble

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    KERNEL_DATA_DIR=/data \
    KERNEL_HOST=0.0.0.0 \
    KERNEL_PORT=8000 \
    PLAYWRIGHT_BROWSER_CHANNEL=chrome \
    MSE_CAPTURE_MS=45000 \
    MSE_PLAYBACK_RATE=4.0 \
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

COPY app ./app
COPY docs ./docs
COPY AGENTS.md ./

RUN mkdir -p /data/profiles /data/artifacts

EXPOSE 8000

CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8000"]
