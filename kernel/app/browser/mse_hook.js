(function () {
  if (window.__BILI_CTF_AUDIO_MSE_INSTALLED__) {
    return;
  }
  window.__BILI_CTF_AUDIO_MSE_INSTALLED__ = true;
  window.__BILI_CTF_AUDIO_MSE_STATS__ = {
    installed: true,
    mediaSourceAvailable: typeof window.MediaSource === "function",
    managedMediaSourceAvailable: typeof window.ManagedMediaSource === "function",
    canConstructInDedicatedWorker: Boolean(
      window.MediaSource && window.MediaSource.canConstructInDedicatedWorker
    ),
    objectUrlCount: 0,
    sourceOpenCount: 0,
    sourceBuffers: [],
    appendCount: 0,
    capturedCount: 0,
    errors: []
  };
  let nextSegmentOrder = 0;
  let capturedBytes = 0;
  let accepting = true;
  const pending = new Set();
  window.__biliCtfAudioMseFinish = function () {
    accepting = false;
    return Promise.all(Array.from(pending));
  };

  function rememberError(stage, error) {
    const errors = window.__BILI_CTF_AUDIO_MSE_STATS__.errors;
    if (errors.length >= 10) {
      return;
    }
    errors.push({
      stage: String(stage || ""),
      name: String((error && error.name) || ""),
      message: String((error && error.message) || error || "").slice(0, 240)
    });
  }

  function bufferSourceView(source) {
    if (source instanceof ArrayBuffer) {
      return new Uint8Array(source);
    }
    if (ArrayBuffer.isView(source)) {
      return new Uint8Array(source.buffer, source.byteOffset, source.byteLength);
    }
    return null;
  }

  function toBase64(bytes) {
    // Encode synchronously before the original appendBuffer can detach/reuse the
    // input. Modern Chrome avoids the large intermediate binary string entirely.
    if (typeof bytes.toBase64 === "function") {
      return bytes.toBase64();
    }
    let binary = "";
    const chunkSize = 0x8000;
    for (let index = 0; index < bytes.length; index += chunkSize) {
      const chunk = bytes.subarray(index, index + chunkSize);
      binary += String.fromCharCode.apply(null, chunk);
    }
    return btoa(binary);
  }

  function isAudioSourceBuffer(mimeType) {
    const normalized = String(mimeType || "").toLowerCase();
    return normalized.includes("audio") || normalized.includes("mp4a");
  }

  function isMediaSourceObject(value) {
    return Boolean(
      value &&
        ((window.MediaSource && value instanceof window.MediaSource) ||
          (window.ManagedMediaSource && value instanceof window.ManagedMediaSource))
    );
  }

  if (window.URL && typeof window.URL.createObjectURL === "function") {
    const originalCreateObjectURL = window.URL.createObjectURL;
    window.URL.createObjectURL = function (value) {
      try {
        if (isMediaSourceObject(value)) {
          window.__BILI_CTF_AUDIO_MSE_STATS__.objectUrlCount += 1;
          value.addEventListener("sourceopen", function () {
            window.__BILI_CTF_AUDIO_MSE_STATS__.sourceOpenCount += 1;
          });
        }
      } catch (error) {
        rememberError("createObjectURL", error);
      }
      return originalCreateObjectURL.apply(this, arguments);
    };
  }

  function patchAddSourceBuffer(ctor, label) {
    if (!ctor || !ctor.prototype || typeof ctor.prototype.addSourceBuffer !== "function") {
      return;
    }
    const originalAddSourceBuffer = ctor.prototype.addSourceBuffer;
    if (originalAddSourceBuffer.__biliCtfAudioPatched) {
      return;
    }

    function patchedAddSourceBuffer(mimeType) {
      const sourceBuffer = originalAddSourceBuffer.call(this, mimeType);
      const audioLike = isAudioSourceBuffer(mimeType);
      window.__BILI_CTF_AUDIO_MSE_STATS__.sourceBuffers.push({
        kind: label,
        mimeType: String(mimeType || ""),
        audioLike: audioLike
      });
      if (!audioLike) {
        return sourceBuffer;
      }

      const originalAppendBuffer = sourceBuffer.appendBuffer;
      sourceBuffer.appendBuffer = function (bufferSource) {
        try {
          window.__BILI_CTF_AUDIO_MSE_STATS__.appendCount += 1;
          const bytes = bufferSourceView(bufferSource);
          if (accepting && bytes && bytes.byteLength && typeof window.__biliCtfAudioSegment === "function") {
            const limits = window.__BILI_CTF_AUDIO_MSE_LIMITS__;
            if (limits && (bytes.byteLength > limits.segmentBytes ||
                capturedBytes + bytes.byteLength > limits.totalBytes || nextSegmentOrder >= limits.segments)) {
              accepting = false;
              window.__BILI_CTF_AUDIO_MSE_STATS__.captureLimitExceeded = true;
              throw new Error("MSE capture size or segment limit exceeded");
            }
            const encoded = toBase64(bytes);
            capturedBytes += bytes.byteLength;
            window.__BILI_CTF_AUDIO_MSE_STATS__.capturedCount += 1;
            const sent = Promise.resolve(window.__biliCtfAudioSegment({
              mimeType: String(mimeType || ""),
              order: nextSegmentOrder++,
              size: bytes.byteLength,
              dataBase64: encoded
            })).catch(function (error) {
              accepting = false;
              window.__BILI_CTF_AUDIO_MSE_STATS__.captureFailed = true;
              rememberError("segmentDelivery", error);
            });
            pending.add(sent);
            sent.then(function () { pending.delete(sent); });
          }
        } catch (error) {
          window.__BILI_CTF_AUDIO_MSE_STATS__.captureFailed = true;
          rememberError("appendBuffer", error);
        }
        return originalAppendBuffer.call(this, bufferSource);
      };

      return sourceBuffer;
    }

    patchedAddSourceBuffer.__biliCtfAudioPatched = true;
    ctor.prototype.addSourceBuffer = patchedAddSourceBuffer;
  }

  patchAddSourceBuffer(window.MediaSource, "MediaSource");
  patchAddSourceBuffer(window.ManagedMediaSource, "ManagedMediaSource");

  if (!window.MediaSource && !window.ManagedMediaSource) {
    rememberError("install", "MediaSource APIs are not available");
  }
})();
