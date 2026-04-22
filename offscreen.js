const canvas = document.getElementById("stitchCanvas");
let context = canvas.getContext("2d", { alpha: false });
const MAX_SEGMENT_HEIGHT = 2000;

// --- CRC32 for PNG chunk validation ---
const crcTable = new Uint32Array(256);
for (let n = 0; n < 256; n++) {
  let c = n;
  for (let k = 0; k < 8; k++) {
    c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  }
  crcTable[n] = c;
}

function crc32(bytes) {
  let crc = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) {
    crc = crcTable[(crc ^ bytes[i]) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function pngChunk(type, data) {
  const buf = new Uint8Array(12 + data.length);
  const view = new DataView(buf.buffer);
  view.setUint32(0, data.length);
  view.setUint32(4, type);
  buf.set(data, 8);
  view.setUint32(8 + data.length, crc32(buf.subarray(4, 8 + data.length)));
  return buf;
}

// --- Message handler ---
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.type !== "stitch-and-download") {
    return false;
  }

  stitchAndDownload(message.payload)
    .then((result) => sendResponse({ ok: true, ...result }))
    .catch((error) =>
      sendResponse({ ok: false, message: error?.message || "Stitch failed." })
    );

  return true;
});

// --- Main entry ---
async function stitchAndDownload({ captures, metrics }) {
  const bitmaps = await Promise.all(
    captures.map(async ({ dataUrl, scrollY }) => {
      const resp = await fetch(dataUrl);
      const blob = await resp.blob();
      const bitmap = await createImageBitmap(blob);
      return { bitmap, scrollY };
    })
  );

  if (!bitmaps.length) {
    throw new Error("No frames to stitch.");
  }

  try {
    const scale = bitmaps[0].bitmap.height / metrics.viewportHeight;
    const outputWidth = bitmaps[0].bitmap.width;
    const outputHeight = Math.round(metrics.totalHeight * scale);

    if (outputWidth <= 0 || outputHeight <= 0) {
      throw new Error("Invalid image dimensions.");
    }

    // Render one vertical segment onto the shared canvas and return raw RGBA pixels.
    function renderSegment(segStartY, segHeight) {
      canvas.width = outputWidth;
      canvas.height = segHeight;
      // Re-acquire context after dimension change to avoid stale state
      context = canvas.getContext("2d", { alpha: false });
      context.clearRect(0, 0, outputWidth, segHeight);
      context.imageSmoothingEnabled = false;

      for (const { bitmap, scrollY } of bitmaps) {
        const destY = Math.round(scrollY * scale);
        const overlapStart = Math.max(destY, segStartY);
        const overlapEnd = Math.min(destY + bitmap.height, segStartY + segHeight);
        if (overlapEnd <= overlapStart) continue;

        context.drawImage(
          bitmap,
          0,
          overlapStart - destY,
          bitmap.width,
          overlapEnd - overlapStart,
          0,
          overlapStart - segStartY,
          outputWidth,
          overlapEnd - overlapStart
        );
      }

      const imageData = context.getImageData(0, 0, outputWidth, segHeight);
      return imageData.data;
    }

    const pngBlob = await buildPng(outputWidth, outputHeight, renderSegment);
    const blobUrl = URL.createObjectURL(pngBlob);

    // blobUrl will be revoked by background.js after download completes
    return { blobUrl };
  } finally {
    for (const { bitmap } of bitmaps) {
      bitmap.close();
    }
  }
}

// --- Manual PNG encoder (streams scanlines through CompressionStream) ---
async function buildPng(width, height, renderSegment) {
  const segMaxH = Math.min(MAX_SEGMENT_HEIGHT, height);

  // IHDR payload: width(4) height(4) bitDepth(1) colorType(1) compression(1) filter(1) interlace(1)
  const ihdr = new Uint8Array(13);
  const iv = new DataView(ihdr.buffer);
  iv.setUint32(0, width);
  iv.setUint32(4, height);
  ihdr[8] = 8; // 8-bit
  ihdr[9] = 6; // RGBA

  // Stream raw scanlines → zlib via CompressionStream("deflate")
  let segStartY = 0;
  let segPixels = null;
  let segH = 0;
  let rowY = 0;
  const rowBytes = 1 + width * 4; // filter byte + RGBA

  const rawStream = new ReadableStream({
    pull(controller) {
      if (rowY >= height) {
        controller.close();
        return;
      }

      // Enqueue a batch of rows per pull for efficiency
      const batchEnd = Math.min(rowY + 64, height);
      while (rowY < batchEnd) {
        // Render the next canvas segment when needed
        if (!segPixels || rowY >= segStartY + segH) {
          segStartY = rowY;
          segH = Math.min(segMaxH, height - segStartY);
          segPixels = renderSegment(segStartY, segH);
        }

        const local = rowY - segStartY;
        const line = new Uint8Array(rowBytes);
        line[0] = 0; // PNG row filter: None
        line.set(
          segPixels.subarray(local * width * 4, (local + 1) * width * 4),
          1
        );
        controller.enqueue(line);
        rowY++;
      }
    },
  });

  const compressed = rawStream.pipeThrough(new CompressionStream("deflate"));
  const compressedBuf = await new Response(compressed).arrayBuffer();
  const compressedData = new Uint8Array(compressedBuf);

  // Assemble the PNG file
  const sig = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]);
  return new Blob(
    [
      sig,
      pngChunk(0x49484452, ihdr),
      pngChunk(0x49444154, compressedData),
      pngChunk(0x49454e44, new Uint8Array(0)),
    ],
    { type: "image/png" }
  );
}