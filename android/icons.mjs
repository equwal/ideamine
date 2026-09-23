// The launcher icons of the app, from the same drawing as the icons of the page.
// `node android/icons.mjs` writes them again.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { icon } from '../dashboard/icons.mjs';

const RES = path.join(path.dirname(fileURLToPath(import.meta.url)), 'app', 'src', 'main', 'res');

// The launcher icon of older Android, and the front layer of the adaptive icon. The front layer is
// 108dp wide, and a phone can cut any shape from the middle 72dp, so the lamp stays small there.
const DENSITIES = [['mdpi', 1], ['hdpi', 1.5], ['xhdpi', 2], ['xxhdpi', 3], ['xxxhdpi', 4]];

for (const [name, scale] of DENSITIES) {
  const dir = path.join(RES, `mipmap-${name}`);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'ic_launcher.png'), icon(Math.round(48 * scale)));
  fs.writeFileSync(path.join(dir, 'ic_foreground.png'), icon(Math.round(108 * scale), { maskable: true }));
  console.log(`mipmap-${name}: ${Math.round(48 * scale)} and ${Math.round(108 * scale)}`);
}

const adaptive = `<?xml version="1.0" encoding="utf-8"?>
<adaptive-icon xmlns:android="http://schemas.android.com/apk/res/android">
    <background android:drawable="@color/background" />
    <foreground android:drawable="@mipmap/ic_foreground" />
</adaptive-icon>
`;
fs.mkdirSync(path.join(RES, 'mipmap-anydpi-v26'), { recursive: true });
fs.writeFileSync(path.join(RES, 'mipmap-anydpi-v26', 'ic_launcher.xml'), adaptive);
console.log('mipmap-anydpi-v26/ic_launcher.xml');
