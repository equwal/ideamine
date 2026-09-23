# ideamine for Android

A window on your ideamine dashboard, with two things that a browser tab cannot do:

- **Share into your ideas.** Send a text from any app to "ideamine", and the composer of the page opens with that text.
- **New idea from the icon.** Hold the icon and pick "New idea": the composer opens empty.

The app keeps no ideas of its own. It shows the page of your ideamine server, so it needs the network of that server, for example your WireGuard tunnel. The first screen is the board; when the server does not answer, the app says so and offers the address of the server, which you can change.

## Build

```bash
cd android
./gradlew assembleDebug
```

The APK is then `app/build/outputs/apk/debug/app-debug.apk`. Install it with `adb install -r <apk>`, or copy it to the phone and open it.

For a signed APK, put `keystore.properties` in this folder with `storeFile`, `storePassword`, `keyAlias`, and `keyPassword`, then run `./gradlew assembleRelease`. Without that file the release build still runs and makes an unsigned APK.

`node icons.mjs` draws the launcher icons again from the same drawing as the icons of the page.

## Why not Google Play

The dashboard answers only on your private network. A reviewer at Google or Apple cannot reach it, so the app would show them an error, and the store would refuse it. Install the APK directly, or put it in F-Droid, where a private server is normal.

## iPhone

There is no iOS app, and none is needed: open the dashboard in Safari and use "Add to Home Screen". The page then has its own icon and opens without the address bar. An iOS app with the same share button would need a Mac, a paid Apple account, and the same store review.
