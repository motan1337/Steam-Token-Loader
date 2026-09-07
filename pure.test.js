'use strict';


const s = require('../src/steam');

let pass = 0;
let fail = 0;
function eq(name, got, want) {
  const g = JSON.stringify(got);
  const w = JSON.stringify(want);
  if (g === w) { pass++; console.log('  ok  ', name); }
  else { fail++; console.error('  FAIL', name, '\n       got : ' + g + '\n       want: ' + w); }
}
function ok(name, cond) {
  if (cond) { pass++; console.log('  ok  ', name); }
  else { fail++; console.error('  FAIL', name); }
}

function b64url(objOrStr) {
  const buf = Buffer.from(typeof objOrStr === 'string' ? objOrStr : JSON.stringify(objOrStr), 'utf8');
  return buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
function makeJwt(payload) {
  return [b64url({ typ: 'JWT', alg: 'EdDSA' }), b64url(payload), b64url('sig')].join('.');
}

console.log('crc32 / connectCacheKey');
eq('crc32("123456789") == 0xCBF43926', s.crc32(Buffer.from('123456789')), 0xcbf43926);
(() => {
  const hex = (0xacea9a67).toString(16).padStart(8, '0');
  const key = hex.replace(/^0+/, '') + '1';
  eq('key transform shape (acea9a67 -> acea9a671)', key, 'acea9a671');
})();
ok('connectCacheKey deterministic', s.connectCacheKey('MyName') === s.connectCacheKey('MyName'));
ok('connectCacheKey ends with "1"', s.connectCacheKey('whatever').endsWith('1'));

console.log('jwt');
const jwt = makeJwt({ iss: 'steam', sub: '76561198012345678', aud: ['web', 'client'], exp: 4102444800 });
eq('extractSteamIdFromJwt', s.extractSteamIdFromJwt(jwt), '76561198012345678');
eq('tokenExpiry', s.tokenExpiry(jwt), 4102444800);
eq('hasClientAudience(client token) == true', s.hasClientAudience(jwt), true);
eq('hasClientAudience(web token) == false', s.hasClientAudience(makeJwt({ sub: '1', aud: ['web'] })), false);
eq('hasClientAudience(no aud) == null', s.hasClientAudience(makeJwt({ sub: '1' })), null);
ok('bad jwt throws', (() => { try { s.extractSteamIdFromJwt('nope'); return false; } catch (_) { return true; } })());

console.log('buildAccount');
const acc = s.buildAccount('76561198012345678----' + jwt);
eq('buildAccount prefix', acc.prefix, '76561198012345678');
eq('buildAccount steamid', acc.steamid, '76561198012345678');
eq('buildAccount client_audience', acc.client_audience, true);
const bare = s.buildAccount(jwt);
eq('buildAccount bare token: no prefix', bare.prefix, null);
eq('buildAccount bare token: steamid from sub', bare.steamid, '76561198012345678');
ok('buildAccount rejects a non-token', (() => { try { s.buildAccount('onlyname'); return false; } catch (_) { return true; } })());
ok('buildAccount rejects steamid/token mismatch', (() => { try { s.buildAccount('76561190000000000----' + jwt); return false; } catch (_) { return true; } })());

console.log('existingAccountName');
const luKnown = '"users"\n{\n\t"76561198012345678"\n\t{\n\t\t"AccountName"\t\t"realname"\n\t}\n}\n';
eq('finds stored AccountName', s.existingAccountName(luKnown, '76561198012345678'), 'realname');
eq('null when absent', s.existingAccountName(luKnown, '76561190000000000'), null);

console.log('config.vdf injection');
const configVdf =
  '"InstallConfigStore"\n{\n\t"Software"\n\t{\n\t\t"Valve"\n\t\t{\n\t\t\t"Steam"\n\t\t\t{\n' +
  '\t\t\t\t"Accounts"\n\t\t\t\t{\n\t\t\t\t}\n' +
  '\t\t\t}\n\t\t}\n\t}\n}\n';
const cfg2 = s.injectAccountIntoConfig(configVdf, 'mylogin', '76561198012345678');
ok('config: account name present', cfg2.includes('"mylogin"'));
ok('config: SteamID present', cfg2.includes('"SteamID"\t\t"76561198012345678"'));
ok('config: idempotent on same steamid', !s.injectAccountIntoConfig(cfg2, 'mylogin', '76561198012345678').match(/"mylogin"[\s\S]*"mylogin"/));

console.log('loginusers.vdf');
const loginVdf =
  '"users"\n{\n\t"76561190000000000"\n\t{\n' +
  '\t\t"AccountName"\t\t"other"\n\t\t"MostRecent"\t\t"1"\n\t\t"AllowAutoLogin"\t\t"1"\n\t}\n}\n';
const lu2 = s.updateLoginUsers(loginVdf, 'mylogin', 'MyLogin', '76561198012345678', '1700000000');
ok('login: new block inserted', lu2.includes('"76561198012345678"'));
ok('login: AccountName as given', lu2.includes('"AccountName"\t\t"mylogin"'));
ok('login: PersonaName as given', lu2.includes('"PersonaName"\t\t"MyLogin"'));
ok('login: AllowAutoLogin=1 on target', lu2.includes('"AllowAutoLogin"\t\t"1"'));
ok('login: AutoLogin=1 on target', lu2.includes('"AutoLogin"\t\t"1"'));
ok('login: other account deactivated', lu2.includes('"AccountName"\t\t"other"') && /"other"[\s\S]*?"MostRecent"\t\t"0"/.test(lu2));
// update path
const luExisting =
  '"users"\n{\n\t"76561198012345678"\n\t{\n' +
  '\t\t"AccountName"\t\t"OLD"\n\t\t"PersonaName"\t\t"OLD"\n\t\t"MostRecent"\t\t"1"\n\t\t"AllowAutoLogin"\t\t"1"\n\t}\n}\n';
const lu3 = s.updateLoginUsers(luExisting, 'mylogin', 'MyLogin', '76561198012345678', '1700000000');
ok('login(update): AccountName replaced', lu3.includes('"AccountName"\t\t"mylogin"') && !lu3.includes('"AccountName"\t\t"OLD"'));
ok('login(update): MostRecent forced to 1', lu3.includes('"MostRecent"\t\t"1"'));

console.log('local.vdf ConnectCache');
const fresh = s.createNewLocalVdf('acea9a671', 'deadbeef');
ok('local: fresh has ConnectCache', fresh.includes('"ConnectCache"'));
ok('local: fresh has key/value', fresh.includes('"acea9a671"\t\t"deadbeef"'));
const inj = s.injectConnectCache(fresh, 'bbbb1', 'cafef00d');
ok('local: injected new key kept old', inj.includes('"acea9a671"') && inj.includes('"bbbb1"\t\t"cafef00d"'));
const injReplace = s.injectConnectCache(fresh, 'acea9a671', 'newvalue');
ok('local: replacing existing key updates value', injReplace.includes('"acea9a671"\t\t"newvalue"') && !injReplace.includes('deadbeef'));

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
