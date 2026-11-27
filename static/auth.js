// Cognito login for the AWS deployment (authorization code + PKCE, no client secret).
//
// Session rules (see the system design doc):
// - Tokens live in sessionStorage: kept on reload, cleared when the tab closes.
// - Access token lasts 1 hour. With 5 minutes left it is renewed silently if the
//   user did something (mouse, keys, wheel, page or zoom changes) in the last 4 hours.
//   Background polling is not activity.
// - After 4 hours idle a "即將登出" prompt appears; no answer in 2 minutes logs out.
// - The Cognito refresh token (12 hours) is the hard cap.
// - Logout cancels running jobs and deletes the user's data on the server, revokes
//   the refresh token, clears browser state and ends the Cognito session.
const TOKENS = 'atco.tokens', PKCE = 'atco.pkce', ACTIVITY = 'atco.lastActivity';
export const IDLE_LIMIT_MS = 4 * 60 * 60 * 1000;
export const PROMPT_MS = 2 * 60 * 1000;
const REFRESH_BEFORE_MS = 5 * 60 * 1000;
const VIEW_STATE_PREFIX = 'atco:';

let config = null, refreshing = null, promptTimer = null, lastWrite = 0, loggingOut = false;
const $ = id => document.getElementById(id);

const read = key => { try { return JSON.parse(sessionStorage.getItem(key)); } catch { return null; } };
const tokens = () => read(TOKENS);
const now = () => Date.now();
export const lastActivity = () => Number(sessionStorage.getItem(ACTIVITY)) || 0;

export function markActivity() {
    if (!config?.auth || $('idleDialog')?.open) return;
    const t = now();
    if (t - lastWrite > 5000) { sessionStorage.setItem(ACTIVITY, String(t)); lastWrite = t; }
}

function base64url(bytes) {
    return btoa(String.fromCharCode(...new Uint8Array(bytes))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
function claims(jwt) {
    try { return JSON.parse(decodeURIComponent(escape(atob(jwt.split('.')[1].replace(/-/g, '+').replace(/_/g, '/'))))); }
    catch { return {}; }
}

async function tokenRequest(params) {
    const response = await fetch(config.auth.domain + '/oauth2/token', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ client_id: config.auth.clientId, ...params }),
    });
    if (!response.ok) throw Error('token request failed');
    const data = await response.json();
    const previous = tokens() || {};
    const next = {
        access_token: data.access_token,
        id_token: data.id_token || previous.id_token,
        refresh_token: data.refresh_token || previous.refresh_token,
        expires_at: now() + data.expires_in * 1000,
    };
    sessionStorage.setItem(TOKENS, JSON.stringify(next));
    return next;
}

export async function login() {
    const verifier = base64url(crypto.getRandomValues(new Uint8Array(48)));
    const state = base64url(crypto.getRandomValues(new Uint8Array(16)));
    const challenge = base64url(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier)));
    sessionStorage.setItem(PKCE, JSON.stringify({ verifier, state }));
    const { domain, clientId, redirectUri, scopes } = config.auth;
    location.assign(domain + '/oauth2/authorize?' + new URLSearchParams({
        response_type: 'code', client_id: clientId, redirect_uri: redirectUri, scope: scopes,
        state, code_challenge: challenge, code_challenge_method: 'S256',
    }));
}

async function finishLogin() {
    const params = new URLSearchParams(location.search);
    const code = params.get('code'), state = params.get('state');
    if (!code && !params.get('error')) return;
    history.replaceState(null, '', location.pathname);
    const pkce = read(PKCE);
    sessionStorage.removeItem(PKCE);
    if (!code || !pkce || pkce.state !== state) return;
    await tokenRequest({ grant_type: 'authorization_code', code, code_verifier: pkce.verifier,
                         redirect_uri: config.auth.redirectUri });
    sessionStorage.setItem(ACTIVITY, String(now()));
}

function refresh() {
    const current = tokens();
    if (!current?.refresh_token) return Promise.reject(Error('no session'));
    refreshing ??= tokenRequest({ grant_type: 'refresh_token', refresh_token: current.refresh_token })
        .finally(() => { refreshing = null; });
    return refreshing;
}

// Token for an API call; renews it only if the user has been active recently.
async function accessToken() {
    let current = tokens();
    if (!current) throw Error('no session');
    if (current.expires_at - now() < REFRESH_BEFORE_MS) {
        if (!loggingOut && now() - lastActivity() >= IDLE_LIMIT_MS && current.expires_at <= now()) throw Error('idle');
        current = await refresh();
    }
    return current.access_token;
}

export async function apiFetch(path, options = {}) {
    if (!config?.auth) return fetch(path, options);
    let token;
    try { token = await accessToken(); } catch { sessionEnded(); throw Error('登入已過期，請重新登入。'); }
    const send = t => fetch(path, { ...options, headers: { ...(options.headers || {}), Authorization: 'Bearer ' + t } });
    let response = await send(token);
    if (response.status === 401) {
        try { response = await send((await refresh()).access_token); }
        catch { sessionEnded(); throw Error('登入已過期，請重新登入。'); }
    }
    return response;
}

function clearBrowserState() {
    for (const key of [TOKENS, PKCE, ACTIVITY]) sessionStorage.removeItem(key);
    for (const key of Object.keys(localStorage)) if (key.startsWith(VIEW_STATE_PREFIX)) localStorage.removeItem(key);
}

function sessionEnded() {
    if (loggingOut) return;
    clearBrowserState();
    showSignIn('登入已過期，請重新登入。');
}

export async function logout() {
    if (!config?.auth || loggingOut) return;
    loggingOut = true;
    const current = tokens();
    try { if (current) await apiFetch('/api/logout', { method: 'POST' }); } catch { /* data still expires in 24 h */ }
    try {
        if (current?.refresh_token) {
            await fetch(config.auth.domain + '/oauth2/revoke', {
                method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
                body: new URLSearchParams({ token: current.refresh_token, client_id: config.auth.clientId }),
            });
        }
    } catch { /* the refresh token still expires after 12 h */ }
    clearBrowserState();
    location.assign(config.auth.domain + '/logout?' + new URLSearchParams({
        client_id: config.auth.clientId, logout_uri: config.auth.logoutUri }));
}

function showSignIn(message) {
    $('signin').hidden = false;
    $('app').hidden = true;
    $('signinMessage').textContent = message || '';
}

function showIdlePrompt() {
    const dialog = $('idleDialog');
    if (dialog.open) return;
    const deadline = lastActivity() + IDLE_LIMIT_MS + PROMPT_MS;
    const update = () => {
        const left = Math.max(0, Math.ceil((deadline - now()) / 1000));
        $('idleCountdown').textContent = `${Math.floor(left / 60)}:${String(left % 60).padStart(2, '0')}`;
        if (left === 0) { clearInterval(promptTimer); dialog.close(); logout(); }
    };
    dialog.showModal();
    update();
    promptTimer = setInterval(update, 1000);
}

function tick() {
    if (!tokens()) return;
    const idle = now() - lastActivity();
    if (idle >= IDLE_LIMIT_MS + PROMPT_MS) return logout();
    if (idle >= IDLE_LIMIT_MS) return showIdlePrompt();
    const current = tokens();
    if (current.expires_at - now() < REFRESH_BEFORE_MS) refresh().catch(sessionEnded);
}

// Returns {email} when signed in, null in local mode; shows the sign-in screen otherwise.
export async function init(appConfig) {
    config = appConfig;
    if (!config.auth) return { signedIn: true, email: '' };
    $('signinButton').onclick = () => login();
    $('logout').onclick = () => logout();
    $('idleContinue').onclick = async () => {
        clearInterval(promptTimer);
        $('idleDialog').close();
        sessionStorage.setItem(ACTIVITY, String(now()));
        try { await refresh(); } catch { sessionEnded(); }
    };
    $('idleLogout').onclick = () => { clearInterval(promptTimer); $('idleDialog').close(); logout(); };
    try { await finishLogin(); } catch { showSignIn('登入失敗，請再試一次。'); return { signedIn: false }; }
    if (!tokens()) { showSignIn(); return { signedIn: false }; }
    for (const type of ['pointerdown', 'keydown', 'wheel']) addEventListener(type, markActivity, { capture: true, passive: true });
    setInterval(tick, 15000);
    document.addEventListener('visibilitychange', () => { if (!document.hidden) tick(); });
    tick();
    if (!tokens()) return { signedIn: false };
    return { signedIn: true, email: claims(tokens().id_token || '').email || '' };
}
