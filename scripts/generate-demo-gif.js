const fs = require('node:fs');
const path = require('node:path');
const { PNG } = require('pngjs');
const { GIFEncoder, quantize, applyPalette } = require('gifenc');

const ROOT = process.cwd();
const INPUTS = [
  'docs/screenshots/overlay-centered-card.png',
  'docs/screenshots/overlay-lower-third.png',
  'docs/screenshots/overlay-sidebar-two-up.png',
  'docs/screenshots/overlay-bottom-ticker.png'
].map((p) => path.resolve(ROOT, p));

const OUTPUT = path.resolve(ROOT, 'docs/screenshots/overlay-demo.gif');
const TARGET_WIDTH = 960;
const TARGET_HEIGHT = 540;
const HOLD_FRAMES = 9;
const TRANSITION_FRAMES = 5;
const FRAME_DELAY_MS = 90;
const MAX_COLORS = 96;

function loadPng(filePath) {
  if (!fs.existsSync(filePath)) {
    throw new Error(`Missing input screenshot: ${filePath}`);
  }

  const png = PNG.sync.read(fs.readFileSync(filePath));
  return {
    width: png.width,
    height: png.height,
    data: new Uint8Array(png.data)
  };
}

function scaleNearest(src, srcWidth, srcHeight, targetWidth, targetHeight) {
  const out = new Uint8Array(targetWidth * targetHeight * 4);

  for (let y = 0; y < targetHeight; y += 1) {
    const srcY = Math.min(srcHeight - 1, Math.floor((y * srcHeight) / targetHeight));
    for (let x = 0; x < targetWidth; x += 1) {
      const srcX = Math.min(srcWidth - 1, Math.floor((x * srcWidth) / targetWidth));
      const srcIdx = (srcY * srcWidth + srcX) * 4;
      const dstIdx = (y * targetWidth + x) * 4;
      out[dstIdx] = src[srcIdx];
      out[dstIdx + 1] = src[srcIdx + 1];
      out[dstIdx + 2] = src[srcIdx + 2];
      out[dstIdx + 3] = src[srcIdx + 3];
    }
  }

  return out;
}

function blendFrames(frameA, frameB, t) {
  const out = new Uint8Array(frameA.length);
  const inv = 1 - t;
  for (let i = 0; i < frameA.length; i += 1) {
    out[i] = Math.round(frameA[i] * inv + frameB[i] * t);
  }
  return out;
}

function writeGif(frames, width, height, outPath) {
  const gif = GIFEncoder();
  gif.writeHeader();

  for (const rgba of frames) {
    const palette = quantize(rgba, MAX_COLORS);
    const index = applyPalette(rgba, palette);
    gif.writeFrame(index, width, height, {
      palette,
      delay: FRAME_DELAY_MS
    });
  }

  gif.finish();
  fs.writeFileSync(outPath, gif.bytesView());
}

function buildFrameSequence(baseFrames) {
  const output = [];

  for (let i = 0; i < baseFrames.length; i += 1) {
    const current = baseFrames[i];
    const next = baseFrames[(i + 1) % baseFrames.length];

    for (let hold = 0; hold < HOLD_FRAMES; hold += 1) {
      output.push(current);
    }

    for (let step = 1; step <= TRANSITION_FRAMES; step += 1) {
      const t = step / (TRANSITION_FRAMES + 1);
      output.push(blendFrames(current, next, t));
    }
  }

  return output;
}

function main() {
  const scaledFrames = INPUTS.map((filePath) => {
    const png = loadPng(filePath);
    return scaleNearest(png.data, png.width, png.height, TARGET_WIDTH, TARGET_HEIGHT);
  });

  const sequence = buildFrameSequence(scaledFrames);
  writeGif(sequence, TARGET_WIDTH, TARGET_HEIGHT, OUTPUT);

  const sizeKb = Math.round(fs.statSync(OUTPUT).size / 1024);
  process.stdout.write(`Created ${path.relative(ROOT, OUTPUT)} (${sizeKb} KB)\n`);
}

main();
