# SMD for Android (Android Studio project)

A thin, locked-down WebView app that displays your hosted SMD server. Accounts, sessions and data
all live on the server (the `smd-app` project); nothing sensitive is stored in this app.

## Open and run

1. Android Studio: **File > Open** > select this `smd-android` folder (the one containing `settings.gradle.kts`).
2. Let **Gradle sync** finish (it downloads Gradle 8.7 and the Android libraries; needs internet). Accept any prompt to install the Android SDK 34.
3. Start the SMD server on your computer (`npm install`, `npm start` inside `smd-app`).
4. Pick an emulator (or a phone) and press **Run**.

## Pointing the app at your server (`gradle.properties`)

| Property | Used by | Value |
|---|---|---|
| `SMD_DEBUG_URL` | Run button / debug builds | USB phone (default): `http://localhost:3000` after running `adb reverse tcp:3000 tcp:3000`. Emulator: `http://10.0.2.2:3000`. Phone on the same Wi-Fi: `http://<your-computer-LAN-IP>:3000` |
| `SMD_RELEASE_URL` | Release builds | Your hosted server, **https only** |

Change a value, then **Sync Now**, run **Build > Clean Project**, and run again (the address is baked in when the app is built). A release build refuses to start if the URL is unset or not https.

## Testing notes

- **Pin button ("Share my current location"):** browsers only allow location on secure pages, and plain `http://10.0.2.2` is not one.
  Over http the app falls back to the paste-a-link option. To test location without hosting, run
  `adb reverse tcp:3000 tcp:3000` and set `SMD_DEBUG_URL=http://localhost:3000` (works on the emulator and a USB-connected phone).
  Your real https URL needs nothing special.
- Debug builds allow plain http (see `app/src/debug/res/xml/network_security_config.xml`). Release builds never do.

## Release build

**Build > Generate Signed App Bundle / APK**, create a keystore, and **back it up** (losing it means you can never update the app on Google Play). Keep `*.jks` out of version control.

## Security built in

- Only your server's origin loads inside the app; every other link (Google Maps, phone, email) opens in the right external app.
- HTTPS enforced in release; invalid certificates are always rejected; mixed content blocked.
- No access to local files; no JavaScript bridge; third-party cookies off; backup disabled; web debugging only in debug builds.
- Location is granted only to your own server, and only after the user accepts Android's permission prompt.

## Known limits

- **"Continue with Google" will not work inside this app**: Google blocks sign-in inside embedded WebViews. Email + password works. Leave `GOOGLE_CLIENT_ID` unset on the server for now, which hides the button. Native Google sign-in can be added later.
- No push notifications yet (the app refreshes jobs every 15 s while open).
- There is no Gradle wrapper script (`gradlew`); Android Studio handles Gradle for you.
- This project was written without an Android SDK available, so it has not been compiled yet. If Gradle sync or the build shows an error, send me the exact text and I'll fix it.

## Troubleshooting: "Can't reach the SMD server"

The error screen now shows the exact address tried and the reason. Check, in order:

1. **Is the server running?** In `smd-app`, run `npm start` and keep it open. On your computer open `http://localhost:3000`; you should see the login page.
2. **Emulator browser test:** open Chrome inside the emulator and go to `http://10.0.2.2:3000`. If that fails, the app will fail too (server stopped, wrong port, or firewall).
3. **Reason shows `net::ERR_CLEARTEXT_NOT_PERMITTED`:** you are running a release build, which only allows https. Run the **debug** variant (Build Variants panel > debug).
4. **Reason shows `net::ERR_CONNECTION_REFUSED`:** nothing is listening on that port. Start the server, or fix the port in `SMD_DEBUG_URL`, then Sync and Run.
5. **Reason shows `net::ERR_NAME_NOT_RESOLVED` or `ERR_ADDRESS_UNREACHABLE`:** the address is wrong (a real phone cannot use `10.0.2.2`; use your computer's Wi-Fi IP).
