'use strict';


const { dpapiProtectHex } = require('../src/dpapi');
const { execFile } = require('child_process');

const token = 'eyJhbGciOiJFZERTQSJ9.payload.sig-' + Date.now();
const entropy = 'myloginname';

function decrypt(hex, ent) {
  return new Promise((resolve, reject) => {
    const ps =
      "$ErrorActionPreference='Stop';" +
      'Add-Type -AssemblyName System.Security;' +
      "$hex=$env:HEX;" +
      '$blob=New-Object byte[] ($hex.Length/2);' +
      'for($i=0;$i -lt $blob.Length;$i++){$blob[$i]=[Convert]::ToByte($hex.Substring($i*2,2),16)}' +
      '$ent=[Text.Encoding]::UTF8.GetBytes($env:ENT);' +
      "$dec=[System.Security.Cryptography.ProtectedData]::Unprotect($blob,$ent,'CurrentUser');" +
      '[Console]::Out.Write([Text.Encoding]::UTF8.GetString($dec))';
    const enc = Buffer.from(ps, 'utf16le').toString('base64');
    execFile(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-EncodedCommand', enc],
      { env: { ...process.env, HEX: hex, ENT: ent }, windowsHide: true, maxBuffer: 1 << 20 },
      (err, stdout, stderr) => (err ? reject(new Error(String(stderr || err.message))) : resolve(String(stdout)))
    );
  });
}

(async () => {
  let failed = 0;
  const hex = await dpapiProtectHex(token, entropy);
  console.log('encrypted hex length     :', hex.length);
  const guidOk = hex.startsWith('01000000d08c9ddf');
  console.log('DPAPI CurrentUser blob   :', guidOk ? 'ok (01000000d08c9ddf…)' : 'UNEXPECTED PREFIX');
  if (!guidOk) failed++;

  const back = (await decrypt(hex, entropy)).trim();
  const rtOk = back === token;
  console.log('round-trip same entropy  :', rtOk ? 'ok' : 'FAIL');
  if (!rtOk) failed++;

  let wrongFails = false;
  try {
    await decrypt(hex, 'wrongname');
  } catch (_) {
    wrongFails = true;
  }
  console.log('wrong entropy rejected   :', wrongFails ? 'ok' : 'FAIL');
  if (!wrongFails) failed++;

  console.log(failed ? `\n${failed} check(s) failed` : '\nall DPAPI checks passed');
  process.exit(failed ? 1 : 0);
})().catch((e) => {
  console.error('error:', e.message);
  process.exit(1);
});
