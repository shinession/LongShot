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
async function stitchAndDownload({ captures, metrics, format }) {
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

    if (format === "pdf") {
      const pdfBlob = await buildPdf(outputWidth, outputHeight, renderSegment);
      const blobUrl = URL.createObjectURL(pdfBlob);
      return { blobUrl };
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

// --- PDF builder: multi-page, one image per page, each independently compressed ---
async function buildPdf(width, height, renderSegment) {
  const PX_TO_PT = 72 / 96;
  const pageW = Math.round(width * PX_TO_PT);
  const segMaxH = Math.min(MAX_SEGMENT_HEIGHT, height);

  // Pre-render each segment → compress RGB independently
  const segments = [];
  for (let y = 0; y < height; y += segMaxH) {
    const segH = Math.min(segMaxH, height - y);
    const rgba = renderSegment(y, segH);

    // RGBA → RGB
    const rgb = new Uint8Array(width * segH * 3);
    for (let i = 0, j = 0; i < rgba.length; i += 4, j += 3) {
      rgb[j] = rgba[i];
      rgb[j + 1] = rgba[i + 1];
      rgb[j + 2] = rgba[i + 2];
    }

    const compressed = await deflateBytes(rgb);
    segments.push({ segH, compressed });
  }

  const pageCount = segments.length;

  // PDF object layout:
  //   1 = Catalog
  //   2 = Pages
  //   For each page i (0-based):
  //     3 + i*3     = Page
  //     3 + i*3 + 1 = Contents stream
  //     3 + i*3 + 2 = Image XObject
  const totalObjects = 2 + pageCount * 3;

  const enc = new TextEncoder();
  const parts = [];
  const offsets = new Array(totalObjects + 1);
  let pos = 0;

  function write(str) {
    const bytes = enc.encode(str);
    parts.push(bytes);
    pos += bytes.length;
  }

  function writeBin(bytes) {
    parts.push(bytes);
    pos += bytes.length;
  }

  function objStart(id) {
    offsets[id] = pos;
    write(`${id} 0 obj\n`);
  }

  // Header
  write("%PDF-1.4\n%\xE2\xE3\xCF\xD3\n");

  // 1 - Catalog
  objStart(1);
  write("<< /Type /Catalog /Pages 2 0 R >>\nendobj\n");

  // 2 - Pages
  const kids = segments.map((_, i) => `${3 + i * 3} 0 R`).join(" ");
  objStart(2);
  write(`<< /Type /Pages /Kids [${kids}] /Count ${pageCount} >>\nendobj\n`);

  // Each page
  for (let i = 0; i < pageCount; i++) {
    const seg = segments[i];
    const pageHPt = Math.round(seg.segH * PX_TO_PT);
    const pageObjId = 3 + i * 3;
    const contentsId = pageObjId + 1;
    const imageId = pageObjId + 2;

    // Page object
    objStart(pageObjId);
    write(
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${pageW} ${pageHPt}] ` +
        `/Contents ${contentsId} 0 R ` +
        `/Resources << /XObject << /Img ${imageId} 0 R >> >> >>\nendobj\n`
    );

    // Contents stream
    const contentStr = `q ${pageW} 0 0 ${pageHPt} 0 0 cm /Img Do Q\n`;
    objStart(contentsId);
    write(`<< /Length ${contentStr.length} >>\nstream\n`);
    write(contentStr);
    write("endstream\nendobj\n");

    // Image XObject
    objStart(imageId);
    write(
      `<< /Type /XObject /Subtype /Image /Width ${width} /Height ${seg.segH} ` +
        `/ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /FlateDecode ` +
        `/Length ${seg.compressed.length} >>\nstream\n`
    );
    writeBin(seg.compressed);
    write("\nendstream\nendobj\n");
  }

  // xref
  const xrefPos = pos;
  write("xref\n");
  write(`0 ${totalObjects + 1}\n`);
  write("0000000000 65535 f \n");
  for (let i = 1; i <= totalObjects; i++) {
    write(`${String(offsets[i]).padStart(10, "0")} 00000 n \n`);
  }

  write("trailer\n");
  write(`<< /Size ${totalObjects + 1} /Root 1 0 R >>\n`);
  write("startxref\n");
  write(`${xrefPos}\n`);
  write("%%EOF\n");

  return new Blob(parts, { type: "application/pdf" });
}

async function deflateBytes(data) {
  const stream = new Blob([data]).stream().pipeThrough(new CompressionStream("deflate"));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}