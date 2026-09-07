'use strict';


const { execFile } = require('child_process');

const PS_SCRIPT = `
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Security
$data = [Convert]::FromBase64String($env:SC_DATA)
$entropy = [Convert]::FromBase64String($env:SC_ENTROPY)
$enc = [System.Security.Cryptography.ProtectedData]::Protect(
  $data, $entropy, [System.Security.Cryptography.DataProtectionScope]::CurrentUser)
$sb = New-Object System.Text.StringBuilder
foreach ($b in $enc) { [void]$sb.Append($b.ToString('x2')) }
[Console]::Out.Write($sb.ToString())
`;

function encodePowerShell(script) {
  return Buffer.from(script, 'utf16le').toString('base64');
}

/**
 * Encrypt dataStr with DPAPI (CurrentUser) using entropyStr as the entropy,
 * returning the blob as a lowercase hex string.
 * @param {string} dataStr    the login token
 * @param {string} entropyStr the Steam account name
 * @returns {Promise<string>} lowercase hex of the DPAPI blob
 */
function dpapiProtectHex(dataStr, entropyStr) {
  return new Promise((resolve, reject) => {
    const encoded = encodePowerShell(PS_SCRIPT);
    execFile(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', encoded],
      {
        env: {
          ...process.env,
          SC_DATA: Buffer.from(dataStr, 'utf8').toString('base64'),
          SC_ENTROPY: Buffer.from(entropyStr, 'utf8').toString('base64'),
        },
        windowsHide: true,
        timeout: 15000,
        maxBuffer: 4 * 1024 * 1024,
      },
      (err, stdout, stderr) => {
        if (err) {
          return reject(new Error('Token encryption (DPAPI) failed: ' + (String(stderr).trim() || err.message)));
        }
        const hex = String(stdout).trim().toLowerCase();
        if (!/^[0-9a-f]+$/.test(hex) || hex.length < 2) {
          return reject(new Error('Token encryption returned unexpected output.'));
        }
        resolve(hex);
      }
    );
  });
}

module.exports = { dpapiProtectHex };
