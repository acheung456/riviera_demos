const DROPBOX_API_BASE = "https://api.dropboxapi.com/2";
const DROPBOX_CONTENT_API_BASE = "https://content.dropboxapi.com/2";
const DROPBOX_OAUTH_AUTHORIZE_URL = "https://www.dropbox.com/oauth2/authorize";
const DROPBOX_OAUTH_TOKEN_URL = "https://api.dropboxapi.com/oauth2/token";
const AUTH_STORAGE_KEY = "riviera_demo_dropbox_auth";
const PKCE_STORAGE_KEY = "riviera_demo_dropbox_pkce";
const OAUTH_POPUP_NAME = "riviera-dropbox-oauth";
const OAUTH_MESSAGE_TYPE = "riviera-dropbox-oauth-result";
const TRANSCRIPT_POLL_INTERVAL_MS = 15000;
const REQUIRED_SCOPES = ["files.content.read", "files.content.write"];

const form = document.querySelector("#transcription-form");

if (form) {
  const runtimeConfig = window.RIVIERA_CONFIG || {};
  const connectButton = document.querySelector("#connect-button");
  const disconnectButton = document.querySelector("#disconnect-button");
  const authDescription = document.querySelector("#auth-description");
  const authMeta = document.querySelector("#auth-meta");
  const mediaUrlInput = document.querySelector("#media-url");
  const mediaFileInput = document.querySelector("#media-file");
  const timestampLevelInput = document.querySelector("#timestamp-level");
  const modeInputs = Array.from(document.querySelectorAll('input[name="inputMode"]'));
  const statusPill = document.querySelector("#status-pill");
  const statusLog = document.querySelector("#status-log");
  const transcriptOutput = document.querySelector("#transcript-output");
  const jsonOutput = document.querySelector("#json-output");
  const submitButton = document.querySelector("#submit-button");
  const resetButton = document.querySelector("#reset-button");
  const copyTranscriptButton = document.querySelector("#copy-transcript");
  const copyJsonButton = document.querySelector("#copy-json");
  const modePanels = Array.from(document.querySelectorAll("[data-mode-panel]"));

  let latestTranscript = "";
  let latestJson = "";
  let authState = loadStoredAuth();
  let oauthPopup = null;

  class RetryableApiError extends Error {
    constructor(message, options = {}) {
      super(message);
      this.name = "RetryableApiError";
      this.status = options.status || 0;
      this.retryAfterMs = options.retryAfterMs || 0;
      this.details = options.details || null;
    }
  }

  class ApiRequestError extends Error {
    constructor(message, options = {}) {
      super(message);
      this.name = "ApiRequestError";
      this.status = options.status || 0;
      this.details = options.details || null;
    }
  }

  function getDropboxAppKey() {
    return runtimeConfig.dropboxAppKey || "";
  }

  function getRedirectUri() {
    return new URL("oauth-callback.html", window.location.href).toString();
  }

  function getSelectedMode() {
    return modeInputs.find((input) => input.checked)?.value || "url";
  }

  function isAuthValid(auth) {
    return Boolean(auth?.accessToken && auth?.expiresAt && Date.now() < auth.expiresAt);
  }

  function loadStoredAuth() {
    try {
      const raw = window.localStorage.getItem(AUTH_STORAGE_KEY);
      if (!raw) {
        return null;
      }

      const parsed = JSON.parse(raw);
      if (!isAuthValid(parsed)) {
        window.localStorage.removeItem(AUTH_STORAGE_KEY);
        return null;
      }

      return parsed;
    } catch (error) {
      window.localStorage.removeItem(AUTH_STORAGE_KEY);
      return null;
    }
  }

  function storeAuth(auth) {
    authState = auth;
    window.localStorage.setItem(AUTH_STORAGE_KEY, JSON.stringify(auth));
  }

  function storePkceState(pkceState) {
    const serialized = JSON.stringify(pkceState);
    window.localStorage.setItem(PKCE_STORAGE_KEY, serialized);
    window.sessionStorage.setItem(PKCE_STORAGE_KEY, serialized);
    window.name = `${PKCE_STORAGE_KEY}:${serialized}`;
  }

  function loadPkceState() {
    const raw =
      window.localStorage.getItem(PKCE_STORAGE_KEY) ||
      window.sessionStorage.getItem(PKCE_STORAGE_KEY) ||
      (window.name.startsWith(`${PKCE_STORAGE_KEY}:`)
        ? window.name.slice(`${PKCE_STORAGE_KEY}:`.length)
        : "");

    if (!raw) {
      return null;
    }

    try {
      return JSON.parse(raw);
    } catch (error) {
      clearPkceState();
      return null;
    }
  }

  function clearPkceState() {
    window.localStorage.removeItem(PKCE_STORAGE_KEY);
    window.sessionStorage.removeItem(PKCE_STORAGE_KEY);
    if (window.name.startsWith(`${PKCE_STORAGE_KEY}:`)) {
      window.name = "";
    }
  }

  function clearAuth() {
    authState = null;
    window.localStorage.removeItem(AUTH_STORAGE_KEY);
    clearPkceState();
  }

  function getAccessToken() {
    if (!isAuthValid(authState)) {
      clearAuth();
      return "";
    }
    return authState.accessToken;
  }

  function updateAuthUi() {
    const hasAppKey = Boolean(getDropboxAppKey());
    const connected = Boolean(getAccessToken());

    connectButton.disabled = !hasAppKey;
    disconnectButton.classList.toggle("is-hidden", !connected);

    if (!hasAppKey) {
      authDescription.textContent =
        "Add the Dropbox app key to enable this demo.";
      authMeta.textContent = "Dropbox app key missing.";
      return;
    }

    authDescription.textContent = "Connect Dropbox once to run URL or file-based transcriptions.";

    if (!connected) {
      authMeta.textContent = "Not connected.";
      return;
    }

    const expiresAt = new Date(authState.expiresAt);
    authMeta.textContent = `Connected until ${expiresAt.toLocaleTimeString([], {
      hour: "numeric",
      minute: "2-digit",
    })}.`;
  }

  function setStatus(label, tone = "neutral") {
    statusPill.textContent = label;
    statusPill.className = "pill";
    statusPill.classList.add(
      tone === "success"
        ? "pill-success"
        : tone === "danger"
          ? "pill-danger"
          : tone === "progress"
            ? "pill-progress"
            : "pill-neutral",
    );
  }

  function pushStatus(message) {
    statusLog.textContent = message;
  }

  function resetStatusLog() {
    statusLog.textContent = "";
  }

  function setTranscript(text) {
    latestTranscript = text || "";
    transcriptOutput.textContent =
      text && text.trim()
        ? text
        : "The request completed, but no joined transcript text was found in structured_transcript.segments.";
    transcriptOutput.classList.toggle("empty-state", !text || !text.trim());
  }

  function setJson(value) {
    latestJson = value;
    jsonOutput.textContent = value || "No response yet.";
    jsonOutput.classList.toggle("empty-state", !value);
  }

  function updateModeUI() {
    const mode = getSelectedMode();
    modePanels.forEach((panel) => {
      const visible = panel.getAttribute("data-mode-panel") === mode;
      panel.classList.toggle("is-hidden", !visible);
    });

    if (mode === "url") {
      mediaUrlInput.required = true;
      mediaFileInput.required = false;
    } else {
      mediaUrlInput.required = false;
      mediaFileInput.required = true;
    }
  }

  function sanitizeFilename(name) {
    return name.replace(/[^a-zA-Z0-9._-]/g, "-");
  }

  function toBase64Url(bytes) {
    let binary = "";
    bytes.forEach((byte) => {
      binary += String.fromCharCode(byte);
    });

    return window.btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
  }

  function createRandomString(length) {
    const charset = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-._~";
    const randomValues = new Uint8Array(length);
    window.crypto.getRandomValues(randomValues);

    return Array.from(randomValues, (value) => charset[value % charset.length]).join("");
  }

  async function createCodeChallenge(codeVerifier) {
    const data = new TextEncoder().encode(codeVerifier);
    const digest = await window.crypto.subtle.digest("SHA-256", data);
    return toBase64Url(new Uint8Array(digest));
  }

  async function beginOauthFlow() {
    const appKey = getDropboxAppKey();
    if (!appKey) {
      pushStatus("Dropbox app key is not configured.");
      setStatus("Error", "danger");
      return;
    }

    const codeVerifier = createRandomString(64);
    const codeChallenge = await createCodeChallenge(codeVerifier);
    const state = createRandomString(32);
    const redirectUri = getRedirectUri();

    storePkceState({
      codeVerifier,
      state,
      redirectUri,
      createdAt: Date.now(),
    });

    const params = new URLSearchParams({
      client_id: appKey,
      response_type: "code",
      redirect_uri: redirectUri,
      code_challenge: codeChallenge,
      code_challenge_method: "S256",
      token_access_type: "online",
      scope: REQUIRED_SCOPES.join(" "),
      state,
    });

    const authorizeUrl = `${DROPBOX_OAUTH_AUTHORIZE_URL}?${params.toString()}`;
    const popupWidth = 520;
    const popupHeight = 720;
    const popupLeft = Math.max(window.screenX + (window.outerWidth - popupWidth) / 2, 0);
    const popupTop = Math.max(window.screenY + (window.outerHeight - popupHeight) / 2, 0);
    const popupFeatures = [
      `width=${popupWidth}`,
      `height=${popupHeight}`,
      `left=${Math.round(popupLeft)}`,
      `top=${Math.round(popupTop)}`,
      "resizable=yes",
      "scrollbars=yes",
    ].join(",");

    oauthPopup = window.open(authorizeUrl, OAUTH_POPUP_NAME, popupFeatures);

    if (oauthPopup) {
      oauthPopup.focus();
      resetStatusLog();
      setStatus("Authorizing", "progress");
      pushStatus("Waiting for Dropbox authorization in the popup window...");
      return;
    }

    window.location.assign(authorizeUrl);
  }

  async function apiFetch(url, options, errorPrefix) {
    const response = await fetch(url, options);
    const text = await response.text();
    let parsed;

    try {
      parsed = text ? JSON.parse(text) : {};
    } catch (error) {
      parsed = { raw: text };
    }

    if (!response.ok) {
      const retryAfterHeader = response.headers.get("retry-after");
      const retryAfterSeconds = Number(retryAfterHeader);
      const retryAfterMs = Number.isFinite(retryAfterSeconds) && retryAfterSeconds > 0
        ? retryAfterSeconds * 1000
        : 0;
      const errorMessage =
        parsed?.error_summary ||
        parsed?.error_description ||
        parsed?.error ||
        parsed?.raw ||
        `${response.status} ${response.statusText}`;

      if (response.status === 429) {
        throw new RetryableApiError(`${errorPrefix}: ${errorMessage}`, {
          status: response.status,
          retryAfterMs,
          details: parsed,
        });
      }

      throw new ApiRequestError(`${errorPrefix}: ${errorMessage}`, {
        status: response.status,
        details: parsed,
      });
    }

    return parsed;
  }

  async function finishOauthFlow(code, state) {
    const appKey = getDropboxAppKey();
    const pkceState = loadPkceState();

    if (!appKey || !pkceState) {
      resetStatusLog();
      setStatus("Error", "danger");
      pushStatus("Missing PKCE state. Start the Dropbox connection flow again.");
      return;
    }

    if (pkceState.state !== state) {
      resetStatusLog();
      setStatus("Error", "danger");
      pushStatus("OAuth state mismatch. The login flow was not verified.");
      return;
    }

    resetStatusLog();
    setStatus("Authorizing", "progress");
    pushStatus("Exchanging OAuth code for an access token...");

    const body = new URLSearchParams({
      code,
      grant_type: "authorization_code",
      redirect_uri: pkceState.redirectUri,
      code_verifier: pkceState.codeVerifier,
      client_id: appKey,
    });

    try {
      const tokenResponse = await apiFetch(
        DROPBOX_OAUTH_TOKEN_URL,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/x-www-form-urlencoded;charset=UTF-8",
          },
          body: body.toString(),
        },
        "OAuth token exchange failed",
      );

      const expiresIn = Number(tokenResponse.expires_in || 0);
      storeAuth({
        accessToken: tokenResponse.access_token,
        tokenType: tokenResponse.token_type,
        scope: tokenResponse.scope || REQUIRED_SCOPES.join(" "),
        expiresAt: Date.now() + Math.max(expiresIn - 60, 0) * 1000,
      });

      pushStatus("Dropbox connected successfully.");
      setStatus("Connected", "success");
    } catch (error) {
      clearAuth();
      setStatus("Error", "danger");
      pushStatus(error.message);
    } finally {
      clearPkceState();
      updateAuthUi();
    }
  }

  async function finishOauthFlowIfPresent() {
    const params = new URLSearchParams(window.location.search);
    const authError = params.get("error");
    const authErrorDescription = params.get("error_description");
    const code = params.get("code");
    const state = params.get("state");
    const cleanUrl = window.location.origin + window.location.pathname;

    if (authError) {
      resetStatusLog();
      setStatus("Error", "danger");
      pushStatus(`Dropbox OAuth error: ${authErrorDescription || authError}`);
      window.history.replaceState({}, document.title, cleanUrl);
      return;
    }

    if (!code) {
      return;
    }

    await finishOauthFlow(code, state);
    window.history.replaceState({}, document.title, cleanUrl);
  }

  function handleOauthMessage(event) {
    if (event.origin !== window.location.origin) {
      return;
    }

    const payload = event.data;

    if (!payload || payload.type !== OAUTH_MESSAGE_TYPE) {
      return;
    }

    if (oauthPopup && !oauthPopup.closed) {
      oauthPopup.close();
    }

    if (payload.error) {
      resetStatusLog();
      setStatus("Error", "danger");
      pushStatus(`Dropbox OAuth error: ${payload.errorDescription || payload.error}`);
      clearPkceState();
      return;
    }

    finishOauthFlow(payload.code, payload.state).catch((error) => {
      setStatus("Error", "danger");
      pushStatus(error.message);
    });
  }

  async function uploadFileToDropbox(accessToken, file) {
    const now = new Date();
    const timestamp = [
      now.getUTCFullYear(),
      String(now.getUTCMonth() + 1).padStart(2, "0"),
      String(now.getUTCDate()).padStart(2, "0"),
      "-",
      String(now.getUTCHours()).padStart(2, "0"),
      String(now.getUTCMinutes()).padStart(2, "0"),
      String(now.getUTCSeconds()).padStart(2, "0"),
    ].join("");

    const uploadPath = `/Apps/Riviera Demos/uploads/${timestamp}-${sanitizeFilename(file.name)}`;

    pushStatus(`Uploading ${file.name} to Dropbox...`);
    setStatus("Uploading", "progress");

    return apiFetch(
      `${DROPBOX_CONTENT_API_BASE}/files/upload`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${accessToken}`,
          "Content-Type": "application/octet-stream",
          "Dropbox-API-Arg": JSON.stringify({
            path: uploadPath,
            mode: "add",
            autorename: true,
            mute: true,
          }),
        },
        body: file,
      },
      "Upload failed",
    );
  }

  async function waitForRateLimitWindow(delayMs, reason) {
    pushStatus(`${reason} Waiting ${Math.round(delayMs / 1000)} seconds before retrying...`);
    await new Promise((resolve) => {
      window.setTimeout(resolve, delayMs);
    });
  }

  async function apiFetchWithRateLimitRetry(url, options, errorPrefix, retryContext) {
    while (true) {
      try {
        return await apiFetch(url, options, errorPrefix);
      } catch (error) {
        if (error instanceof RetryableApiError && error.status === 429) {
          const retryDelayMs = Math.max(error.retryAfterMs || 0, TRANSCRIPT_POLL_INTERVAL_MS);
          await waitForRateLimitWindow(retryDelayMs, retryContext);
          continue;
        }

        throw error;
      }
    }
  }

  function buildDropboxCorsHackUrl(path, accessToken) {
    const url = new URL(`${DROPBOX_API_BASE}${path}`);
    url.searchParams.set("authorization", `Bearer ${accessToken}`);
    url.searchParams.set("reject_cors_preflight", "true");
    return url.toString();
  }

  async function launchTranscript(accessToken, payload) {
    pushStatus("Starting async transcript job...");
    setStatus("Launching", "progress");

    return apiFetchWithRateLimitRetry(
      buildDropboxCorsHackUrl("/riviera/get_transcript_async", accessToken),
      {
        method: "POST",
        headers: {
          "Content-Type": "text/plain; charset=dropbox-cors-hack",
        },
        body: JSON.stringify(payload),
      },
      "Failed to launch transcription",
      "Rate limited while launching the transcript job.",
    );
  }

  async function pollTranscript(accessToken, asyncJobId) {
    await waitForRateLimitWindow(
      TRANSCRIPT_POLL_INTERVAL_MS,
      "Async job created. Respecting the API rate limit before the first status check.",
    );

    while (true) {
      pushStatus(`Checking job ${asyncJobId}...`);
      setStatus("Polling", "progress");

      const response = await apiFetchWithRateLimitRetry(
        buildDropboxCorsHackUrl("/riviera/get_transcript_async/check", accessToken),
        {
          method: "POST",
          headers: {
            "Content-Type": "text/plain; charset=dropbox-cors-hack",
          },
          body: JSON.stringify({ async_job_id: asyncJobId }),
        },
        "Failed while polling transcription",
        "Rate limited while polling the transcript job.",
      );

      if (response[".tag"] === "complete") {
        pushStatus("Transcription complete.");
        setStatus("Complete", "success");
        return response;
      }

      if (response[".tag"] === "failed") {
        throw new Error(`Transcription failed: ${JSON.stringify(response, null, 2)}`);
      }

      if (response[".tag"] !== "in_progress") {
        throw new Error(`Unexpected job state: ${JSON.stringify(response, null, 2)}`);
      }

      await new Promise((resolve) => {
        window.setTimeout(resolve, TRANSCRIPT_POLL_INTERVAL_MS);
      });
    }
  }

  function extractTranscriptText(response) {
    const segments = response?.structured_transcript?.segments;
    if (!Array.isArray(segments)) {
      return "";
    }

    return segments
      .map((segment) => segment?.text || "")
      .filter(Boolean)
      .join(" ");
  }

  function setBusy(isBusy) {
    submitButton.disabled = isBusy;
    submitButton.textContent = isBusy ? "Working..." : "Start transcription";
  }

  async function handleSubmit(event) {
    event.preventDefault();
    resetStatusLog();
    setTranscript("");
    setJson("");
    setBusy(true);

    const accessToken = getAccessToken();
    const mode = getSelectedMode();
    const timestampLevel = timestampLevelInput.value;

    try {
      if (!accessToken) {
        throw new Error("Connect Dropbox before starting a transcription.");
      }

      let fileIdOrUrl;

      if (mode === "url") {
        const mediaUrl = mediaUrlInput.value.trim();

        if (!mediaUrl) {
          throw new Error("A media URL is required for URL mode.");
        }

        fileIdOrUrl = {
          ".tag": "url",
          url: mediaUrl,
        }
        pushStatus("Prepared remote URL payload.");
      } else {
        const file = mediaFileInput.files?.[0];

        if (!file) {
          throw new Error("Select a local audio or video file to continue.");
        }

        const uploadResult = await uploadFileToDropbox(accessToken, file);
        pushStatus(`Upload complete: ${uploadResult.name || file.name}`);

        if (uploadResult.id) {
          fileIdOrUrl = {
            ".tag": "file_id",
            file_id: uploadResult.id,
          };
          pushStatus(`Using Dropbox file ID ${uploadResult.id}.`);
        } else if (uploadResult.path_display) {
          fileIdOrUrl = {
            ".tag": "path",
            path: uploadResult.path_display,
          };
          pushStatus(`Using uploaded path ${uploadResult.path_display}.`);
        } else {
          throw new Error("Upload succeeded, but no file identifier was returned.");
        }
      }

      const launchPayload = {
        file_id_or_url: fileIdOrUrl,
        timestamp_level: timestampLevel,
      };

      const launchResult = await launchTranscript(accessToken, launchPayload);

      if (launchResult[".tag"] === "complete") {
        pushStatus("The API returned a completed transcript immediately.");
        setStatus("Complete", "success");
        setTranscript(extractTranscriptText(launchResult));
        setJson(JSON.stringify(launchResult, null, 2));
        return;
      }

      if (launchResult[".tag"] !== "async_job_id" || !launchResult.async_job_id) {
        throw new Error(`Unexpected launch response: ${JSON.stringify(launchResult, null, 2)}`);
      }

      pushStatus(`Async job created: ${launchResult.async_job_id}`);
      const finalResult = await pollTranscript(accessToken, launchResult.async_job_id);
      setTranscript(extractTranscriptText(finalResult));
      setJson(JSON.stringify(finalResult, null, 2));
    } catch (error) {
      setStatus("Error", "danger");
      pushStatus(error.message);
      setTranscript("");
      setJson(
        JSON.stringify(
          {
            error: error.message,
            status: error.status || null,
            details: error.details || null,
          },
          null,
          2,
        ),
      );
    } finally {
      setBusy(false);
    }
  }

  async function copyText(value, label) {
    if (!value) {
      return;
    }

    try {
      await navigator.clipboard.writeText(value);
      pushStatus(`${label} copied to clipboard.`);
    } catch (error) {
      pushStatus(`Could not copy ${label.toLowerCase()}.`);
    }
  }

  connectButton.addEventListener("click", () => {
    beginOauthFlow().catch((error) => {
      setStatus("Error", "danger");
      pushStatus(error.message);
    });
  });

  disconnectButton.addEventListener("click", () => {
    clearAuth();
    updateAuthUi();
    resetStatusLog();
    setStatus("Idle");
    pushStatus("Disconnected from Dropbox.");
    setTranscript("");
    setJson("");
  });

  form.addEventListener("submit", handleSubmit);
  resetButton.addEventListener("click", () => {
    form.reset();
    updateModeUI();
    resetStatusLog();
    setStatus("Idle");
    pushStatus("Waiting for input.");
    setTranscript("");
    setJson("");
  });
  copyTranscriptButton.addEventListener("click", () => copyText(latestTranscript, "Transcript"));
  copyJsonButton.addEventListener("click", () => copyText(latestJson, "JSON"));
  modeInputs.forEach((input) => {
    input.addEventListener("change", updateModeUI);
  });

  window.addEventListener("message", handleOauthMessage);
  updateModeUI();
  updateAuthUi();
  finishOauthFlowIfPresent().catch((error) => {
    setStatus("Error", "danger");
    pushStatus(error.message);
  });
}
