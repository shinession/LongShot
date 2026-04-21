const canvas = document.getElementById("stitchCanvas");
const context = canvas.getContext("2d", { alpha: false });
const MAX_CANVAS_DIMENSION = 32000;

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.type !== "stitch-captures") {
    return false;
  }

  stitch(message.payload)
    .then((parts) => {
      sendResponse({ ok: true, parts });
    })
    .catch((error) => {
      sendResponse({
        ok: false,
        message: error?.message || "Unable to stitch captures.",
      });
    });

  return true;
});

async function stitch({ captures, metrics }) {
  const bitmaps = await Promise.all(
    captures.map(async ({ dataUrl, scrollY }) => {
      const response = await fetch(dataUrl);
      const blob = await response.blob();
      const bitmap = await createImageBitmap(blob);

      return {
        bitmap,
        scrollY,
      };
    })
  );

  if (!bitmaps.length) {
    throw new Error("There are no frames to stitch.");
  }

  try {
    const baseBitmap = bitmaps[0].bitmap;
    const scale = baseBitmap.height / metrics.viewportHeight;
    const outputWidth = baseBitmap.width;
    const outputHeight = Math.round(metrics.totalHeight * scale);

    if (outputHeight <= 0 || outputWidth <= 0) {
      throw new Error("The stitched image has invalid dimensions.");
    }

    if (outputWidth > MAX_CANVAS_DIMENSION) {
      throw new Error("The page is too wide to stitch into an image.");
    }

    const partHeightLimit = Math.min(MAX_CANVAS_DIMENSION, outputHeight);
    const totalParts = Math.ceil(outputHeight / partHeightLimit);
    const parts = [];

    for (let partIndex = 0; partIndex < totalParts; partIndex += 1) {
      const partStartY = partIndex * partHeightLimit;
      const partHeight = Math.min(partHeightLimit, outputHeight - partStartY);
      const partEndY = partStartY + partHeight;

      canvas.width = outputWidth;
      canvas.height = partHeight;
      context.clearRect(0, 0, outputWidth, partHeight);
      context.imageSmoothingEnabled = false;

      for (const { bitmap, scrollY } of bitmaps) {
        const destinationY = Math.round(scrollY * scale);
        const bitmapEndY = destinationY + bitmap.height;
        const overlapStartY = Math.max(destinationY, partStartY);
        const overlapEndY = Math.min(bitmapEndY, partEndY);
        const overlapHeight = overlapEndY - overlapStartY;

        if (overlapHeight <= 0) {
          continue;
        }

        const sourceY = overlapStartY - destinationY;
        const partDestinationY = overlapStartY - partStartY;

        context.drawImage(
          bitmap,
          0,
          sourceY,
          bitmap.width,
          overlapHeight,
          0,
          partDestinationY,
          outputWidth,
          overlapHeight
        );
      }

      parts.push({
        index: partIndex + 1,
        totalParts,
        dataUrl: canvas.toDataURL("image/png"),
      });
    }

    return parts;
  } finally {
    for (const { bitmap } of bitmaps) {
      bitmap.close();
    }
  }
}