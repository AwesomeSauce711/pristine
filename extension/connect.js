'use strict';
/**
 * connect.js — account connection, handled inside the extension.
 *
 * WHAT THIS DOES AND DOES NOT TOUCH
 * Sign-in happens on the platform's own page, inside a window Chrome opens and
 * controls. This code never sees a password and never asks for one; what comes
 * back is an access token scoped to publishing. That is the whole reason to use
 * OAuth rather than the obvious shortcut of reusing the browser's cookies —
 * cookies would mean impersonating the user everywhere, forever, with no scope
 * and no way to revoke just this.
 *
 * WHAT THE USER STILL HAS TO DO
 * Register an app with each platform and paste its client ID. There is no way
 * around that: publishing scopes are granted to a registered application, and
 * this extension is not one. Shipping a shared client ID would put everyone's
 * uploads through one quota and one revocable key, which is worse than asking.
 *
 * Each platform below carries the exact steps, the exact console URL, and the
 * exact redirect URI to paste — because "register an OAuth app" is the step
 * where people give up, and it is only three fields.
 */

/** Chrome mints this per extension; the platform must be told the same value. */
/*
 * Lazy, because this file is imported into the service worker at module
 * scope. Anything that throws here takes the whole worker down with it — and
 * every listener registered AFTER the importScripts call silently fails to
 * register, which presents as 'the extension is running but never answers'.
 */
const REDIRECT = (() => {
  try { return chrome.identity.getRedirectURL(); } catch (_) { return ''; }
})();

const PLATFORMS = {
  tiktok: {
    label: 'TikTok',
    console: 'https://developers.tiktok.com/apps',
    authUrl: 'https://www.tiktok.com/v2/auth/authorize/',
    scope: 'user.info.basic,video.publish',
    // TikTok calls it client_key, not client_id. Getting this wrong produces
    // an error page that does not say which field was missing.
    idParam: 'client_key',
    // A person at TikTok reads the app description during review. Worth
    // knowing before starting, not after.
    review: true,
    cost: 'Needs TikTok review of your app before publishing works — days, and a person reads what you wrote.',
    steps: [
      'Open the TikTok for Developers portal and create an app.',
      'Add the "Login Kit" and "Content Posting API" products to it.',
      'Under Login Kit, paste the redirect URI below.',
      'Request the video.publish scope — it needs review before it works.',
      'Copy the Client Key and paste it here.',
    ],
    me: async (token) => {
      const r = await fetch('https://open.tiktokapis.com/v2/user/info/?fields=display_name', {
        headers: { authorization: 'Bearer ' + token },
      });
      const d = await r.json();
      return d && d.data && d.data.user && d.data.user.display_name;
    },
  },

  youtube: {
    label: 'YouTube',
    console: 'https://console.cloud.google.com/apis/credentials',
    authUrl: 'https://accounts.google.com/o/oauth2/v2/auth',
    scope: 'https://www.googleapis.com/auth/youtube.upload ' +
           'https://www.googleapis.com/auth/youtube.readonly',
    idParam: 'client_id',
    // No review needed for your own channel: an OAuth consent screen left in
    // Testing mode allows up to 100 users, and nobody at Google reads it.
    review: false,
    cost: 'No Google review. Leave the consent screen in Testing mode and add yourself as a test user.',
    steps: [
      'Open Google Cloud Console and create a project.',
      'Enable the "YouTube Data API v3" for it.',
      'Create an OAuth client ID of type "Web application".',
      'Paste the redirect URI below into Authorised redirect URIs.',
      'Copy the Client ID and paste it here.',
    ],
    me: async (token) => {
      const r = await fetch(
        'https://www.googleapis.com/youtube/v3/channels?part=snippet&mine=true',
        { headers: { authorization: 'Bearer ' + token } });
      const d = await r.json();
      return d && d.items && d.items[0] && d.items[0].snippet && d.items[0].snippet.title;
    },
  },

  instagram: {
    label: 'Instagram',
    console: 'https://developers.facebook.com/apps',
    authUrl: 'https://www.facebook.com/v21.0/dialog/oauth',
    scope: 'instagram_basic,instagram_content_publish,pages_show_list',
    idParam: 'client_id',
    review: true,
    cost: 'Needs Meta review of your app before publishing works, plus a Business account linked to a Facebook Page.',
    steps: [
      'Your Instagram account must be a Business or Creator account,',
      'and linked to a Facebook Page — publishing needs both.',
      'Create an app at Meta for Developers and add "Instagram Graph API".',
      'Paste the redirect URI below into Valid OAuth Redirect URIs.',
      'Copy the App ID and paste it here.',
    ],
    me: async (token) => {
      const r = await fetch(
        'https://graph.facebook.com/v21.0/me/accounts' +
        '?fields=instagram_business_account{username}&access_token=' + encodeURIComponent(token));
      const d = await r.json();
      const page = d && d.data && d.data.find((p) => p.instagram_business_account);
      return page && page.instagram_business_account && page.instagram_business_account.username;
    },
  },
};

const keyFor = (id) => 'auth_' + id;

/** What the panel needs to draw a row: connected or not, and to whom. */
async function statusOf(id) {
  const k = keyFor(id);
  const store = await chrome.storage.local.get([k]);
  const a = store[k];
  if (!a || !a.token) return { id, connected: false, clientId: (a && a.clientId) || '' };
  // A token past its expiry is not a connection, however it is stored.
  if (a.expiresAt && Date.now() > a.expiresAt) {
    return { id, connected: false, expired: true, clientId: a.clientId || '' };
  }
  return { id, connected: true, name: a.name || '', clientId: a.clientId || '' };
}

/**
 * Runs the OAuth flow for one platform.
 *
 * launchWebAuthFlow opens the platform's own sign-in page in a window Chrome
 * owns, waits for the redirect, and hands back the URL it landed on. The
 * password is typed into the platform's page, not ours, and never passes
 * through this code.
 */
async function connect(id, clientId) {
  const p = PLATFORMS[id];
  if (!p) throw new Error('unknown platform');
  if (!clientId) throw new Error('a client ID is needed first');

  // The token comes back in the fragment, so nothing sensitive lands in a
  // server log or a browser history entry.
  const url = p.authUrl +
    '?response_type=token' +
    '&' + p.idParam + '=' + encodeURIComponent(clientId) +
    '&redirect_uri=' + encodeURIComponent(REDIRECT) +
    '&scope=' + encodeURIComponent(p.scope) +
    '&state=' + Math.random().toString(36).slice(2);

  const landed = await chrome.identity.launchWebAuthFlow({ url, interactive: true });
  if (!landed) throw new Error('sign-in was closed');

  const frag = String(landed).split('#')[1] || String(landed).split('?')[1] || '';
  const params = new URLSearchParams(frag);
  const token = params.get('access_token');
  if (!token) {
    throw new Error(params.get('error_description') || params.get('error') || 'no token returned');
  }

  const ttl = Number(params.get('expires_in')) || 0;
  let name = '';
  try { name = (await p.me(token)) || ''; } catch (_) {}

  await chrome.storage.local.set({
    [keyFor(id)]: {
      clientId, token, name,
      expiresAt: ttl ? Date.now() + ttl * 1000 : 0,
      at: Date.now(),
    },
  });
  return { id, connected: true, name };
}

/** Forgets a connection. The token is dropped here; revoke it at the platform. */
async function disconnect(id) {
  const k = keyFor(id);
  const store = await chrome.storage.local.get([k]);
  const a = store[k] || {};
  // The client ID is kept: it is not a secret and re-entering it every time
  // would be the most annoying part of reconnecting.
  await chrome.storage.local.set({ [k]: { clientId: a.clientId || '' } });
  return { id, connected: false, clientId: a.clientId || '' };
}

self.TTHD_CONNECT = { PLATFORMS, REDIRECT, statusOf, connect, disconnect };
