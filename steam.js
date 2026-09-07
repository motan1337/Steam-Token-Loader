'use strict';

// steam token login engine
// it only adds or updates the entries steam needs to sign in with the token
// HKCU\SOFTWARE\Valve\Steam\SteamPath (read to find Steam)
// config\config.vdf (add the account under accounts)
// config\loginusers.vdf (add/update this account block)
// %LOCALAPPDATA%\Steam\local.vdf (the DPAPI encrypted token)
// HKCU\SOFTWARE\Valve\Steam\AutoLoginUser + RememberPassword

const fs = require('fs');
const path = require('path');
const { execFile, spawn } = require('child_process');
const { dpapiProtectHex } = require('./dpapi');

const STEAM_REG_KEY = 'HKCU\\SOFTWARE\\Valve\\Steam';
const STEAM_PROCS = ['steam.exe', 'steamwebhelper.exe', 'steamerrorreporter.exe'];

function unixNow() {
  return Math.floor(Date.now() / 1000);
}
function delay(ms) {
  return new Promise((r) => setTimeout(r, ms));
}
function run(cmd, args, opts = {}) {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { windowsHide: true, timeout: 20000, ...opts }, (err, stdout, stderr) => {
      if (err) {
        err.stdout = String(stdout || '');
        err.stderr = String(stderr || '');
        return reject(err);
      }
      resolve(String(stdout || ''));
    });
  });
}
function permMessage(action, e) {
  const code = e && (e.code || e.errno);
  if (code === 'EPERM' || code === 'EACCES' || (e && e.errno === -4048)) {
    return 'Permission denied. Run Steam Token Loader as Administrator.';
  }
  return `Couldn't ${action} (${(e && e.message) || 'unknown error'}).`;
}

// token / id helpers

function base64UrlDecode(str) {
  const pad = str.length % 4 === 0 ? '' : '='.repeat(4 - (str.length % 4));
  return Buffer.from(str.replace(/-/g, '+').replace(/_/g, '/') + pad, 'base64');
}

function decodeJwtPayload(jwt) {
  const parts = String(jwt).trim().split('.');
  if (parts.length !== 3) throw new Error("That token doesn't look like a valid login token.");
  try {
    return JSON.parse(base64UrlDecode(parts[1]).toString('utf8'));
  } catch (_) {
    throw new Error('Could not read the login token.');
  }
}

function extractSteamIdFromJwt(jwt) {
  const payload = decodeJwtPayload(jwt);
  if (!payload.sub || typeof payload.sub !== 'string') throw new Error('Token is missing the SteamID.');
  return payload.sub;
}

function tokenExpiry(jwt) {
  try {
    const p = decodeJwtPayload(jwt);
    return typeof p.exp === 'number' ? p.exp : null;
  } catch (_) {
    return null;
  }
}

// null = unknown, false = a web token that wont drive the desktop client login
function hasClientAudience(jwt) {
  try {
    const a = decodeJwtPayload(jwt).aud;
    const arr = Array.isArray(a) ? a : typeof a === 'string' ? [a] : null;
    if (!arr) return null;
    return arr.some((x) => /client/i.test(String(x)));
  } catch (_) {
    return null;
  }
}

function crc32(buf) {
  let crc = 0xffffffff;
  for (let i = 0; i < buf.length; i++) {
    crc ^= buf[i];
    for (let j = 0; j < 8; j++) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
  }
  return (crc ^ 0xffffffff) >>> 0;
}

// connectcache key steam uses crc32 hex leading zeros stripped, trailing 1
// the identifier just has to match what we write as the account name everywhere else
function connectCacheKey(identifier) {
  const hex = crc32(Buffer.from(String(identifier), 'utf8')).toString(16).padStart(8, '0');
  const trimmed = hex.replace(/^0+/, '');
  return (trimmed === '' ? '0' : trimmed) + '1';
}

// accepts id----token or a bare token 
function parseCredentialLine(input) {
  const raw = String(input).trim();
  const i = raw.indexOf('----');
  if (i === -1) return { prefix: '', token: raw };
  return { prefix: raw.slice(0, i).trim(), token: raw.slice(i + 4).trim() };
}

function buildAccount(input) {
  const { prefix, token } =
    typeof input === 'string' ? parseCredentialLine(input) : { prefix: input.prefix || '', token: input.token };
  const tok = (token || '').trim();
  if (!tok) throw new Error('Paste a login token.');
  const steamid = extractSteamIdFromJwt(tok);
  const pfx = (prefix || '').trim();
  if (pfx && /^\d{17}$/.test(pfx) && pfx !== steamid) {
    throw new Error("The SteamID before ---- doesn't match the token.");
  }
  return { prefix: pfx || null, token: tok, steamid, expiry: tokenExpiry(tok), client_audience: hasClientAudience(tok) };
}

// if loginusers.vdf already has this account return the account name steam stored
// for it so we reuse the real name instead of overwriting it with a steamid
function existingAccountName(content, steamid) {
  const lines = content.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].includes(`"${steamid}"`)) {
      for (let j = i + 1; j < lines.length; j++) {
        const m = lines[j].match(/"AccountName"\s+"([^"]+)"/);
        if (m) return m[1];
        if (lines[j].trim() === '}') break;
      }
    }
  }
  return null;
}

// vdf

function injectAccountIntoConfig(content, loginName, steamid) {
  if (content.includes(`"SteamID"\t\t"${steamid}"`)) return content;
  const block = `\n\t\t\t\t\t"${loginName}"\n\t\t\t\t\t{\n\t\t\t\t\t\t"SteamID"\t\t"${steamid}"\n\t\t\t\t\t}\n`;
  const accIdx = content.lastIndexOf('"Accounts"');
  if (accIdx === -1) throw new Error('Could not find the accounts block in config.vdf.');
  const brace = content.indexOf('{', accIdx);
  if (brace === -1) throw new Error('Could not find the accounts block in config.vdf.');
  const pos = brace + 1;
  return content.slice(0, pos) + block + content.slice(pos);
}

function insertNewLoginUser(content, loginName, personaName, steamid, ts) {
  const block =
    `\n\t"${steamid}"\n\t{\n` +
    `\t\t"AccountName"\t\t"${loginName}"\n` +
    `\t\t"PersonaName"\t\t"${personaName}"\n` +
    `\t\t"RememberPassword"\t\t"1"\n` +
    `\t\t"WantsOfflineMode"\t\t"0"\n` +
    `\t\t"SkipOfflineModeWarning"\t\t"0"\n` +
    `\t\t"AllowAutoLogin"\t\t"1"\n` +
    `\t\t"AutoLogin"\t\t"1"\n` +
    `\t\t"MostRecent"\t\t"1"\n` +
    `\t\t"Timestamp"\t\t"${ts}"\n` +
    `\t}\n`;
  const pos = content.lastIndexOf('}');
  if (pos === -1) throw new Error('loginusers.vdf is malformed.');
  return content.slice(0, pos) + block + content.slice(pos);
}

function updateExistingLoginUser(content, loginName, personaName, steamid, ts) {
  const lines = content.split(/\r?\n/);
  const out = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    out.push(line);
    if (line.includes(`"${steamid}"`)) {
      for (i = i + 1; i < lines.length; i++) {
        const inner = lines[i];
        if (inner.includes('"AccountName"')) out.push(`\t\t\t"AccountName"\t\t"${loginName}"`);
        else if (inner.includes('"PersonaName"')) out.push(`\t\t\t"PersonaName"\t\t"${personaName}"`);
        else if (inner.includes('"AllowAutoLogin"')) out.push('\t\t\t"AllowAutoLogin"\t\t"1"');
        else if (inner.includes('"AutoLogin"')) out.push('\t\t\t"AutoLogin"\t\t"1"');
        else if (inner.includes('"MostRecent"')) out.push('\t\t\t"MostRecent"\t\t"1"');
        else if (inner.includes('"Timestamp"')) out.push(`\t\t\t"Timestamp"\t\t"${ts}"`);
        else out.push(inner);
        if (inner.trim() === '}') break;
      }
    }
  }
  return out.join('\n');
}

function updateLoginUsers(content, loginName, personaName, steamid, ts) {
  // only flip most recent so steam signs into the account we just loaded other
  // accounts keep all their own settings because i fucking hate messing up with config files of my own or others
  let c = content.split('"MostRecent"\t\t"1"').join('"MostRecent"\t\t"0"');
  if (c.includes(`"${steamid}"`)) c = updateExistingLoginUser(c, loginName, personaName, steamid, ts);
  else c = insertNewLoginUser(c, loginName, personaName, steamid, ts);
  return c;
}

function createNewLocalVdf(crc, encrypted) {
  return (
    '"MachineUserConfigStore"\n{\n' +
    '\t"Software"\n\t{\n' +
    '\t\t"Valve"\n\t\t{\n' +
    '\t\t\t"Steam"\n\t\t\t{\n' +
    '\t\t\t\t"ConnectCache"\n\t\t\t\t{\n' +
    `\t\t\t\t\t"${crc}"\t\t"${encrypted}"\n` +
    '\t\t\t\t}\n\t\t\t}\n\t\t}\n\t}\n}\n'
  );
}

function injectConnectCache(content, crc, encrypted) {
  const lines = content.split(/\r?\n/);
  const out = [];
  let inCc = false;
  let depth = 0;
  let replaced = false;
  for (let idx = 0; idx < lines.length; idx++) {
    const line = lines[idx];
    const t = line.trim();
    if (t === '"ConnectCache"') {
      inCc = true;
      depth = 0;
      out.push(line);
      continue;
    }
    if (inCc) {
      if (t.startsWith('{')) {
        depth += 1;
      } else if (t.startsWith('}')) {
        depth -= 1;
        if (depth === 0 && !replaced) {
          out.push(`\t\t\t\t\t"${crc}"\t\t"${encrypted}"`);
          replaced = true;
        }
      }
      if (t.startsWith(`"${crc}"`)) {
        out.push(`\t\t\t\t\t"${crc}"\t\t"${encrypted}"`);
        replaced = true;
        continue;
      }
    }
    out.push(line);
  }
  if (!replaced) return createNewLocalVdf(crc, encrypted);
  return out.join('\n');
}

// registry

async function regQuery(keyPath, valueName) {
  let stdout;
  try {
    stdout = await run('reg', ['query', keyPath, '/v', valueName]);
  } catch (_) {
    return null;
  }
  const re = new RegExp(valueName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\s+REG_[A-Z_]+\\s+(.*)');
  for (const raw of stdout.split(/\r?\n/)) {
    const m = raw.match(re);
    if (m) return m[1].trim();
  }
  return null;
}

async function getSteamPath() {
  const p = await regQuery(STEAM_REG_KEY, 'SteamPath');
  if (!p) throw new Error('Steam not found. Is it installed and signed in once?');
  return path.normalize(p);
}

async function readAutoLoginUser() {
  const v = await regQuery(STEAM_REG_KEY, 'AutoLoginUser');
  return v && v.length ? v : null;
}

async function writeAutoLoginUser(name) {
  await run('reg', ['add', STEAM_REG_KEY, '/v', 'AutoLoginUser', '/t', 'REG_SZ', '/d', name, '/f']);
  try {
    await run('reg', ['add', STEAM_REG_KEY, '/v', 'RememberPassword', '/t', 'REG_DWORD', '/d', '1', '/f']);
  } catch (_) {
  }
}

// process control

async function isSteamRunning() {
  try {
    const out = await run('tasklist', ['/FI', 'IMAGENAME eq steam.exe', '/NH']);
    return /steam\.exe/i.test(out);
  } catch (_) {
    return false;
  }
}

async function forceKillSteam() {
  let killedSteam = false;
  for (const p of STEAM_PROCS) {
    try {
      await run('taskkill', ['/F', '/IM', p, '/T']);
      if (p === 'steam.exe') killedSteam = true;
    } catch (_) {
    }
  }
  if (killedSteam) await delay(1200);
}

async function stopSteam(steamPath) {
  if (!(await isSteamRunning())) return;
  if (steamPath) {
    try {
      await run(path.join(steamPath, 'steam.exe'), ['-shutdown']);
    } catch (_) {
    }
    for (let i = 0; i < 16; i++) {
      if (!(await isSteamRunning())) return;
      await delay(500);
    }
  }
  await forceKillSteam();
}

function launchSteam(steamPath) {
  const child = spawn(path.join(steamPath, 'steam.exe'), [], {
    detached: true,
    stdio: 'ignore',
    windowsHide: false,
  });
  child.unref();
}

async function writeLocalVdf(loginName, token) {
  const crc = connectCacheKey(loginName);
  const encrypted = await dpapiProtectHex(token, loginName); // entropy = lowercased login name
  const base = path.join(process.env.LOCALAPPDATA || '', 'Steam');
  const file = path.join(base, 'local.vdf');
  fs.mkdirSync(base, { recursive: true });
  const content = fs.existsSync(file)
    ? injectConnectCache(fs.readFileSync(file, 'utf8'), crc, encrypted)
    : createNewLocalVdf(crc, encrypted);
  fs.writeFileSync(file, content);
}

function configFilesExist(configDir) {
  return (
    fs.existsSync(path.join(configDir, 'config.vdf')) &&
    fs.existsSync(path.join(configDir, 'loginusers.vdf'))
  );
}

async function loginAccount(acc) {
  const steamPath = await getSteamPath();
  const configDir = path.join(steamPath, 'config');
  if (!configFilesExist(configDir)) {
    throw new Error('Open Steam and sign into any account once first, then try again.');
  }

  const ts = unixNow().toString();
  const configPath = path.join(configDir, 'config.vdf');
  const loginPath = path.join(configDir, 'loginusers.vdf');

  await stopSteam(steamPath);

  // one identifier and use it consistently for every file and the registry
  // prefer the name steam already has for this account then the pasted prefix
  // then the steamid from the token
  const loginContent = fs.readFileSync(loginPath, 'utf8');
  const accountKey = existingAccountName(loginContent, acc.steamid) || acc.prefix || acc.steamid;
  const personaName = accountKey;

  try {
    fs.writeFileSync(configPath, injectAccountIntoConfig(fs.readFileSync(configPath, 'utf8'), accountKey, acc.steamid));
  } catch (e) {
    throw new Error(permMessage('update config.vdf', e));
  }
  try {
    fs.writeFileSync(loginPath, updateLoginUsers(loginContent, accountKey, personaName, acc.steamid, ts));
  } catch (e) {
    throw new Error(permMessage('update loginusers.vdf', e));
  }

  await writeLocalVdf(accountKey, acc.token);
  await writeAutoLoginUser(accountKey);
  launchSteam(steamPath);

  return `Logged in as '${accountKey}'. Steam is starting.`;
}

module.exports = {
  crc32,
  connectCacheKey,
  decodeJwtPayload,
  extractSteamIdFromJwt,
  tokenExpiry,
  hasClientAudience,
  parseCredentialLine,
  buildAccount,
  existingAccountName,
  injectAccountIntoConfig,
  insertNewLoginUser,
  updateExistingLoginUser,
  updateLoginUsers,
  createNewLocalVdf,
  injectConnectCache,
  getSteamPath,
  readAutoLoginUser,
  loginAccount,
  stopSteam,
  isSteamRunning,
};
