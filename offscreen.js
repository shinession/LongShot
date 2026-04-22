const canvas = document.getElementById("stitchCanvas");
let context = canvas.getContext("2d", { alpha: false });
const MAX_SEGMENT_HEIGHT = 2000;
const CAPTURE_BOTTOM_CROP_PX = 8;

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
    const frames = bitmaps.map(({ bitmap, scrollY }, index) => {
      const cropBottom =
        index < bitmaps.length - 1
          ? Math.min(CAPTURE_BOTTOM_CROP_PX, Math.max(0, bitmap.height - 1))
          : 0;

      return {
        bitmap,
        destY: Math.floor(scrollY * scale),
        drawHeight: bitmap.height - cropBottom,
      };
    });

    if (outputWidth <= 0 || outputHeight <= 0) {
      throw new Error("Invalid image dimensions.");
    }

    // Render one vertical segment onto the shared canvas and return raw RGBA pixels.
    function renderSegment(segStartY, segHeight) {
      canvas.width = outputWidth;
      canvas.height = segHeight;
      context = canvas.getContext("2d", { alpha: false });
      context.fillStyle = "#ffffff";
      context.fillRect(0, 0, outputWidth, segHeight);

      for (const { bitmap, destY, drawHeight } of frames) {
        if (destY >= segStartY + segHeight || destY + drawHeight <= segStartY) {
          continue;
        }

        context.drawImage(
          bitmap,
          0,
          0,
          bitmap.width,
          drawHeight,
          0,
          destY - segStartY,
          outputWidth,
          drawHeight
        );
      }

      return context.getImageData(0, 0, outputWidth, segHeight).data;
    }

    if (format === "pdf-multi") {
      const pdfBlob = await buildMultiPagePdf(outputWidth, outputHeight, renderSegment);
      const blobUrl = URL.createObjectURL(pdfBlob);
      return { blobUrl };
    }

    if (format === "pdf-single") {
      const pdfBlob = await buildSinglePagePdf(outputWidth, outputHeight, renderSegment);
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

// --- PDF builder: single tall page composed of independently compressed image strips ---
async function buildSinglePagePdf(width, height, renderSegment) {
  const PX_TO_PT = 72 / 96;
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
    segments.push({ startY: y, segH, compressed });
  }

  const pageWPt = Math.max(1, width * PX_TO_PT);
  const pageHPt = Math.max(1, height * PX_TO_PT);
  const maxPdfUnits = 14400;
  const userUnit = Math.max(1, Math.ceil(Math.max(pageWPt, pageHPt) / maxPdfUnits));
  const mediaBoxW = pageWPt / userUnit;
  const mediaBoxH = pageHPt / userUnit;

  // PDF object layout:
  //   1 = Catalog
  //   2 = Pages
  //   3 = Page
  //   4 = Contents stream
  //   5... = Image XObjects
  const firstImageId = 5;
  const totalObjects = 4 + segments.length;

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
  objStart(2);
  write("<< /Type /Pages /Kids [3 0 R] /Count 1 >>\nendobj\n");

  const xObjectEntries = segments
    .map((_, index) => `/Img${index} ${firstImageId + index} 0 R`)
    .join(" ");

  // 3 - Single tall page
  objStart(3);
  write(
    `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${mediaBoxW} ${mediaBoxH}] ` +
      (userUnit > 1 ? `/UserUnit ${userUnit} ` : "") +
      `/Contents 4 0 R /Resources << /XObject << ${xObjectEntries} >> >> >>\nendobj\n`
  );

  // 4 - Contents stream for all strips on one page
  const contentStr = segments
    .map((seg, index) => {
      const drawW = pageWPt / userUnit;
      const drawH = (seg.segH * PX_TO_PT) / userUnit;
      const drawY = ((height - (seg.startY + seg.segH)) * PX_TO_PT) / userUnit;
      return `q ${drawW} 0 0 ${drawH} 0 ${drawY} cm /Img${index} Do Q`;
    })
    .join("\n") + "\n";
  objStart(4);
  write(`<< /Length ${contentStr.length} >>\nstream\n`);
  write(contentStr);
  write("endstream\nendobj\n");

  // 5... - Image XObjects
  for (let index = 0; index < segments.length; index += 1) {
    const seg = segments[index];
    const imageId = firstImageId + index;
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

// --- PDF builder: multiple pages, one image strip per page ---
async function buildMultiPagePdf(width, height, renderSegment) {
  const PX_TO_PT = 72 / 96;
  const pageW = Math.round(width * PX_TO_PT);
  const segMaxH = Math.min(MAX_SEGMENT_HEIGHT, height);

  const segments = [];
  for (let y = 0; y < height; y += segMaxH) {
    const segH = Math.min(segMaxH, height - y);
    const rgba = renderSegment(y, segH);

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

  write("%PDF-1.4\n%\xE2\xE3\xCF\xD3\n");

  objStart(1);
  write("<< /Type /Catalog /Pages 2 0 R >>\nendobj\n");

  const kids = segments.map((_, index) => `${3 + index * 3} 0 R`).join(" ");
  objStart(2);
  write(`<< /Type /Pages /Kids [${kids}] /Count ${pageCount} >>\nendobj\n`);

  for (let index = 0; index < pageCount; index += 1) {
    const seg = segments[index];
    const pageHPt = Math.round(seg.segH * PX_TO_PT);
    const pageObjId = 3 + index * 3;
    const contentsId = pageObjId + 1;
    const imageId = pageObjId + 2;

    objStart(pageObjId);
    write(
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${pageW} ${pageHPt}] ` +
        `/Contents ${contentsId} 0 R ` +
        `/Resources << /XObject << /Img ${imageId} 0 R >> >> >>\nendobj\n`
    );

    const contentStr = `q ${pageW} 0 0 ${pageHPt} 0 0 cm /Img Do Q\n`;
    objStart(contentsId);
    write(`<< /Length ${contentStr.length} >>\nstream\n`);
    write(contentStr);
    write("endstream\nendobj\n");

    objStart(imageId);
    write(
      `<< /Type /XObject /Subtype /Image /Width ${width} /Height ${seg.segH} ` +
        `/ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /FlateDecode ` +
        `/Length ${seg.compressed.length} >>\nstream\n`
    );
    writeBin(seg.compressed);
    write("\nendstream\nendobj\n");
  }

  const xrefPos = pos;
  write("xref\n");
  write(`0 ${totalObjects + 1}\n`);
  write("0000000000 65535 f \n");
  for (let i = 1; i <= totalObjects; i += 1) {
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