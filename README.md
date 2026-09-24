# Steam Token Loader by motan1337

A tiny Windows app that logs Steam into an account using a login token no
password needed, and no Steam Guard prompt. Paste a token, press
Log in, and Steam launches already signed in.

Built with Electron (HTML/CSS/JS). Not affiliated with or endorsed by Valve or
Steam. Use only accounts you own or are allowed to use and use at your own risk,
I am not legally responsible for any damages that this software may cause, this is PoC. 
Expect minor bugs since the development of this software was made when I was under the influence of alcohol (a lot of beer and nicotine). Same can be said with everything
in my github or whatever I build xP.

## What it does:

1. Finds Steam via `HKCU\SOFTWARE\Valve\Steam\SteamPath`.
2. Closes Steam (asks it to shut down, force closes only if it won't quit).
3. Adds the account to `config\config.vdf` (under `Accounts`).
4. Adds/updates the account block in `config\loginusers.vdf`.
5. Stores the token, DPAPI encrypted, in `%LOCALAPPDATA%\Steam\local.vdf`.
6. Sets it as the auto login user in the registry and starts Steam.

It only adds or updates that one account. It never deletes files and never
removes your other accounts they only get `MostRecent` flipped to `0` so Steam
signs into the one you just loaded (normal, reversible Steam behaviour). Nothing
is saved by the app itself, you launch it and paste a token each time.

## The token format:

Paste either a bare token, or the `id----token` line as your source gives it:

```
76561199XXXXXXXXX----token      (id = SteamID, as most token exports use)
someaccountname----token        (id = the account login name)
token                           (bare token, the app reads the account from it)
```

- token is the Steam login (JWT). The app reads the SteamID (sub) out of it and
  rejects anything that isn't a valid token. A desktop client token works a
  web only token may not sign the desktop client in, and the app warns you.
- The `id` before `----` is optional. The app only needs one identifier to write
  consistently across Steam files it uses, in order the account name Steam
  already has for that SteamID, then the pasted `id`, then the SteamID from the
  token. If you paste an `id----token` where the `id` is a SteamID that doesn't
  match the token, it's rejected.

## Requirements:

- Windows 10 or 11.
- Steam installed and signed into any account **once before first use**, so its
  config files exist.
- **Administrator** the app writes into Steam install folder. Packaged builds
  request elevation automatically in development, run your terminal as Admin.

## Run from source:

```
npm install
npm start
```

## Build a Windows executable:

```
npm run dist
```

Output goes to release/

## Tests:

Pure logic tests (no Steam needed) and a live DPAPI round trip check:

```
node test/pure.test.js
node test/dpapi_roundtrip.js
```

## How the token encryption works:

Steam stores the remembered token in `local.vdf` as a Windows DPAPI blob
`CryptProtectData`, current user scope, with the account name as entropy,
rendered as hex. The app reproduces that exactly via `ProtectedData.Protect`, so
the official Steam client decrypts and uses it on the same Windows user. The
description string and audit flag Steam sets don't affect decryption only the
entropy (account name) and the user's DPAPI master key do.

## License

MIT.
