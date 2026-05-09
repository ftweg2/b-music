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

  function copyBufferSource(source) {
    if (source instanceof ArrayBuffer) {
      return source.slice(0);
    }
    if (ArrayBuffer.isView(source)) {
      return source.buffer.slice(source.byteOffset, source.byteOffset + source.byteLength);
    }
    return null;
  }

  function toBase64(arrayBuffer) {
    const buffer = arrayBuffer || new ArrayBuffer(0);
    const bytes = new Uint8Array(buffer);
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
      let order = 0;

      sourceBuffer.appendBuffer = function (bufferSource) {
        try {
          window.__BILI_CTF_AUDIO_MSE_STATS__.appendCount += 1;
          const copy = copyBufferSource(bufferSource);
          if (copy && typeof window.__biliCtfAudioSegment === "function") {
            window.__BILI_CTF_AUDIO_MSE_STATS__.capturedCount += 1;
            window.__biliCtfAudioSegment({
              mimeType: String(mimeType || ""),
              order: order++,
              size: copy.byteLength || 0,
              dataBase64: toBase64(copy)
            });
          }
        } catch (error) {
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
