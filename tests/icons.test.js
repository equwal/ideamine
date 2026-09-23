import assert from 'node:assert/strict';
import fs from 'node:fs';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { inflateSync } from 'node:zlib';
import { icon, ICONS } from '../dashboard/icons.mjs';

/** The pixels of a PNG that icons.mjs wrote: signature, size, and RGBA rows without a filter. */
function decode(png) {
  assert.deepEqual([...png.subarray(0, 8)], [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 'PNG signature');
  assert.equal(png.subarray(12, 16).toString('ascii'), 'IHDR');
  const width = png.readUInt32BE(16);
  const height = png.readUInt32BE(20);
  assert.equal(png.subarray(37, 41).toString('ascii'), 'IDAT');
  const rows = inflateSync(png.subarray(41, 41 + png.readUInt32BE(33)));
  const at = (x, y) => {
    const start = y * (width * 4 + 1);
    assert.equal(rows[start], 0, 'each row says "no filter"');
    return [...rows.subarray(start + 1 + x * 4, start + 5 + x * 4)];
  };
  return { width, height, at };
}

test('each icon in the repository is the PNG that the drawing makes now', () => {
  for (const [name, wanted, opts] of ICONS) {
    const made = icon(wanted, opts);
    const { width, height } = decode(made);
    assert.deepEqual([width, height], [wanted, wanted], name);
    const file = fs.readFileSync(fileURLToPath(new URL(`../dashboard/${name}`, import.meta.url)));
    assert.ok(made.equals(file), `${name} differs from the drawing. Run: node dashboard/icons.mjs`);
  }
});

test('the icon is a blue lamp on a dark tile with round corners, and the maskable icon is a full square', () => {
  const plain = decode(icon(192));
  assert.deepEqual(plain.at(0, 0), [0, 0, 0, 0], 'the corner is outside the rounded tile');
  assert.deepEqual(plain.at(96, 4), [11, 11, 11, 255], 'the top middle is the dark tile');
  const middle = Math.round(192 * 0.44);
  const inside = Math.round(96 + 0.75 * 0.21 * 192); // in the glass, beside the filament
  assert.deepEqual(plain.at(inside, middle), [57, 135, 229, 255], 'the glass of the lamp is the accent colour');
  assert.deepEqual(plain.at(96, middle), [11, 11, 11, 255], 'the filament crosses the middle and is dark');

  const maskable = decode(icon(512, { maskable: true }));
  assert.equal(maskable.at(0, 0)[3], 255, 'a maskable icon fills its square, so a phone can cut any shape');
});
