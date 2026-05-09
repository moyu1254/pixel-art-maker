"use client";

import Image from "next/image";
import { useCallback, useEffect, useRef, useState } from "react";

const DOT_SIZES = [16, 32, 64, 128] as const;
const PALETTES = [
  { value: "full-color", label: "フルカラー" },
  { value: "famicom", label: "ファミコン風" },
  { value: "gameboy", label: "ゲームボーイ風" },
  { value: "monochrome", label: "モノクロ" },
] as const;
const REMOVE_BG_ENDPOINT = "https://api.remove.bg/v1.0/removebg";
const PREPROCESS_FILTER = "contrast(1.2) saturate(1.2)";
const ALPHA_THRESHOLD = 64;
const MIN_BLOCK_OPAQUE_RATIO = 0.12;
const TRANSPARENT_MIN_BLOCK_OPAQUE_RATIO = 0.35;
const TRANSPARENT_BLOCK_SCALE = 0.5;
const COLOR_PALETTES = {
  "full-color": null,
  famicom: [
    [0, 0, 0],
    [84, 84, 84],
    [0, 30, 116],
    [8, 16, 144],
    [48, 0, 136],
    [68, 0, 100],
    [92, 0, 48],
    [84, 4, 0],
    [60, 24, 0],
    [32, 42, 0],
    [8, 58, 0],
    [0, 64, 0],
    [0, 60, 0],
    [0, 50, 60],
    [0, 0, 0],
    [152, 150, 152],
    [8, 76, 196],
    [48, 50, 236],
    [92, 30, 228],
    [136, 20, 176],
    [160, 20, 100],
    [152, 34, 32],
    [120, 60, 0],
    [84, 90, 0],
    [40, 114, 0],
    [8, 124, 0],
    [0, 118, 40],
    [0, 102, 120],
    [0, 0, 0],
    [236, 238, 236],
    [76, 154, 236],
    [120, 124, 236],
    [176, 98, 236],
    [228, 84, 236],
    [236, 88, 180],
    [236, 106, 100],
    [212, 136, 32],
    [160, 170, 0],
    [116, 196, 0],
    [76, 208, 32],
    [56, 204, 108],
    [56, 180, 204],
    [60, 60, 60],
    [236, 238, 236],
  ],
  gameboy: [
    [15, 56, 15],
    [48, 98, 48],
    [139, 172, 15],
    [155, 188, 15],
  ],
  monochrome: [
    [0, 0, 0],
    [85, 85, 85],
    [170, 170, 170],
    [255, 255, 255],
  ],
} as const;

type PreviewMode = "side-by-side" | "toggle";
type PreviewTab = "original" | "converted";
type PaletteValue = (typeof PALETTES)[number]["value"];
type RgbColor = readonly [number, number, number];
type SampledPixel = {
  r: number;
  g: number;
  b: number;
};

async function removeBackground(file: File): Promise<Blob> {
  const apiKey = process.env.NEXT_PUBLIC_REMOVE_BG_API_KEY;

  if (!apiKey) {
    throw new Error("NEXT_PUBLIC_REMOVE_BG_API_KEY が設定されていません。");
  }

  const formData = new FormData();
  formData.append("image_file", file);
  formData.append("size", "auto");

  const response = await fetch(REMOVE_BG_ENDPOINT, {
    method: "POST",
    headers: {
      "X-Api-Key": apiKey,
    },
    body: formData,
  });

  if (!response.ok) {
    const detail = await response.text();
    throw new Error(
      `背景透過APIの呼び出しに失敗しました (status: ${response.status})${
        detail ? ` - ${detail}` : ""
      }`,
    );
  }

  return response.blob();
}

async function loadImageFromUrl(url: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const image = new window.Image();

    image.onload = () => resolve(image);
    image.onerror = () => reject(new Error("画像の読み込みに失敗しました。"));
    image.src = url;
  });
}

function findNearestColor(
  r: number,
  g: number,
  b: number,
  palette: readonly RgbColor[],
): RgbColor {
  let nearest = palette[0];
  let nearestDistance = Number.POSITIVE_INFINITY;

  for (const color of palette) {
    const dr = r - color[0];
    const dg = g - color[1];
    const db = b - color[2];
    const distance = dr * dr + dg * dg + db * db;

    if (distance < nearestDistance) {
      nearestDistance = distance;
      nearest = color;
    }
  }

  return nearest;
}

function sampleRepresentativePixelFromBlock(
  sourceData: Uint8ClampedArray,
  width: number,
  height: number,
  blockX: number,
  blockY: number,
  blockSize: number,
  minOpaqueRatio: number,
): SampledPixel | null {
  const endX = Math.min(width, blockX + blockSize);
  const endY = Math.min(height, blockY + blockSize);
  const centerX = Math.min(endX - 1, blockX + Math.floor((endX - blockX) / 2));
  const centerY = Math.min(endY - 1, blockY + Math.floor((endY - blockY) / 2));
  const centerIndex = (centerY * width + centerX) * 4;
  const centerAlpha = sourceData[centerIndex + 3];

  if (centerAlpha >= ALPHA_THRESHOLD) {
    return {
      r: sourceData[centerIndex],
      g: sourceData[centerIndex + 1],
      b: sourceData[centerIndex + 2],
    };
  }

  let bestIndex = -1;
  let bestAlpha = -1;
  let bestDistance = Number.POSITIVE_INFINITY;
  let opaqueCount = 0;
  const blockArea = (endX - blockX) * (endY - blockY);

  for (let y = blockY; y < endY; y += 1) {
    for (let x = blockX; x < endX; x += 1) {
      const index = (y * width + x) * 4;
      const alpha = sourceData[index + 3];

      if (alpha < ALPHA_THRESHOLD) {
        continue;
      }

      opaqueCount += 1;
      const distance = (x - centerX) ** 2 + (y - centerY) ** 2;

      if (alpha > bestAlpha || (alpha === bestAlpha && distance < bestDistance)) {
        bestAlpha = alpha;
        bestDistance = distance;
        bestIndex = index;
      }
    }
  }

  if (bestIndex === -1 || opaqueCount / blockArea < minOpaqueRatio) {
    return null;
  }

  return {
    r: sourceData[bestIndex],
    g: sourceData[bestIndex + 1],
    b: sourceData[bestIndex + 2],
  };
}

async function convertImageToPixelArt(
  imageUrl: string,
  dotSize: number,
  palette: PaletteValue,
  preserveTransparentEdges = false,
): Promise<string> {
  const image = await loadImageFromUrl(imageUrl);
  const width = Math.max(1, image.naturalWidth || image.width);
  const height = Math.max(1, image.naturalHeight || image.height);
  const blockSize = preserveTransparentEdges
    ? Math.max(1, Math.floor(dotSize * TRANSPARENT_BLOCK_SCALE))
    : Math.max(1, dotSize);
  const minOpaqueRatio = preserveTransparentEdges
    ? TRANSPARENT_MIN_BLOCK_OPAQUE_RATIO
    : MIN_BLOCK_OPAQUE_RATIO;
  const sourceCanvas = document.createElement("canvas");
  sourceCanvas.width = width;
  sourceCanvas.height = height;
  const sourceCtx = sourceCanvas.getContext("2d", { willReadFrequently: true });

  if (!sourceCtx) {
    throw new Error("入力用Canvasの初期化に失敗しました。");
  }

  sourceCtx.clearRect(0, 0, width, height);
  sourceCtx.filter = PREPROCESS_FILTER;
  sourceCtx.drawImage(image, 0, 0, width, height);
  sourceCtx.filter = "none";
  const sourceImageData = sourceCtx.getImageData(0, 0, width, height);
  const sourceData = sourceImageData.data;

  const outputCanvas = document.createElement("canvas");
  outputCanvas.width = width;
  outputCanvas.height = height;
  const outputCtx = outputCanvas.getContext("2d");

  if (!outputCtx) {
    throw new Error("出力用Canvasの初期化に失敗しました。");
  }

  outputCtx.clearRect(0, 0, width, height);
  const paletteColors = COLOR_PALETTES[palette];

  for (let y = 0; y < height; y += blockSize) {
    for (let x = 0; x < width; x += blockSize) {
      const representative = sampleRepresentativePixelFromBlock(
        sourceData,
        width,
        height,
        x,
        y,
        blockSize,
        minOpaqueRatio,
      );

      if (!representative) {
        continue;
      }

      let { r, g, b } = representative;

      if (paletteColors) {
        const nearest = findNearestColor(r, g, b, paletteColors);
        r = nearest[0];
        g = nearest[1];
        b = nearest[2];
      }

      outputCtx.fillStyle = `rgba(${r}, ${g}, ${b}, 1)`;
      outputCtx.fillRect(
        x,
        y,
        Math.min(blockSize, width - x),
        Math.min(blockSize, height - y),
      );
    }
  }

  return outputCanvas.toDataURL("image/png");
}

export default function Home() {
  const fileInputRef = useRef<HTMLInputElement>(null);
  const removeRequestIdRef = useRef(0);
  const convertRequestIdRef = useRef(0);
  const sourceImageUrlRef = useRef<string | null>(null);
  const transparentImageUrlRef = useRef<string | null>(null);
  const [dotSizeIndex, setDotSizeIndex] = useState(1);
  const [palette, setPalette] = useState<PaletteValue>("full-color");
  const [transparentBackground, setTransparentBackground] = useState(false);
  const [previewMode, setPreviewMode] = useState<PreviewMode>("side-by-side");
  const [previewTab, setPreviewTab] = useState<PreviewTab>("original");
  const [isDragging, setIsDragging] = useState(false);
  const [uploadedFile, setUploadedFile] = useState<File | null>(null);
  const [sourceImageUrl, setSourceImageUrl] = useState<string | null>(null);
  const [transparentImageUrl, setTransparentImageUrl] = useState<string | null>(
    null,
  );
  const [isRemovingBackground, setIsRemovingBackground] = useState(false);
  const [removeBgError, setRemoveBgError] = useState<string | null>(null);
  const [isConverting, setIsConverting] = useState(false);
  const [convertError, setConvertError] = useState<string | null>(null);
  const [convertedImageUrl, setConvertedImageUrl] = useState<string | null>(null);

  useEffect(() => {
    return () => {
      if (sourceImageUrlRef.current) {
        URL.revokeObjectURL(sourceImageUrlRef.current);
      }
      if (transparentImageUrlRef.current) {
        URL.revokeObjectURL(transparentImageUrlRef.current);
      }
    };
  }, []);

  const dotSize = DOT_SIZES[dotSizeIndex];
  const baseImageUrl =
    transparentBackground && transparentImageUrl
      ? transparentImageUrl
      : sourceImageUrl;
  const previewConvertedImageUrl = sourceImageUrl
    ? convertedImageUrl ?? baseImageUrl
    : null;

  const setSourceImageUrlSafely = (nextUrl: string | null) => {
    if (sourceImageUrlRef.current) {
      URL.revokeObjectURL(sourceImageUrlRef.current);
    }

    sourceImageUrlRef.current = nextUrl;
    setSourceImageUrl(nextUrl);
  };

  const setTransparentImageUrlSafely = (nextUrl: string | null) => {
    if (transparentImageUrlRef.current) {
      URL.revokeObjectURL(transparentImageUrlRef.current);
    }

    transparentImageUrlRef.current = nextUrl;
    setTransparentImageUrl(nextUrl);
  };

  const runPixelArtConversion = useCallback(
    async (
      inputImageUrl: string,
      options?: { preserveTransparentEdges?: boolean },
    ) => {
      const requestId = ++convertRequestIdRef.current;

      setIsConverting(true);
      setConvertError(null);

      try {
        const convertedDataUrl = await convertImageToPixelArt(
          inputImageUrl,
          dotSize,
          palette,
          options?.preserveTransparentEdges ?? false,
        );

        if (requestId !== convertRequestIdRef.current) {
          return;
        }

        setConvertedImageUrl(convertedDataUrl);
      } catch (error) {
        if (requestId !== convertRequestIdRef.current) {
          return;
        }

        setConvertedImageUrl(null);
        setConvertError(
          error instanceof Error
            ? error.message
            : "画像の変換中にエラーが発生しました。",
        );
      } finally {
        if (requestId === convertRequestIdRef.current) {
          setIsConverting(false);
        }
      }
    },
    [dotSize, palette],
  );

  const runBackgroundRemoval = async (file: File) => {
    const requestId = ++removeRequestIdRef.current;

    setIsRemovingBackground(true);
    setRemoveBgError(null);

    try {
      const transparentBlob = await removeBackground(file);
      const nextTransparentUrl = URL.createObjectURL(transparentBlob);

      if (requestId !== removeRequestIdRef.current) {
        URL.revokeObjectURL(nextTransparentUrl);
        return;
      }

      setTransparentImageUrlSafely(nextTransparentUrl);
      void runPixelArtConversion(nextTransparentUrl, {
        preserveTransparentEdges: true,
      });
    } catch (error) {
      if (requestId !== removeRequestIdRef.current) {
        return;
      }

      setTransparentImageUrlSafely(null);
      setRemoveBgError(
        error instanceof Error
          ? error.message
          : "背景透過処理中にエラーが発生しました。",
      );

      if (sourceImageUrlRef.current) {
        void runPixelArtConversion(sourceImageUrlRef.current, {
          preserveTransparentEdges: false,
        });
      }
    } finally {
      if (requestId === removeRequestIdRef.current) {
        setIsRemovingBackground(false);
      }
    }
  };

  const handleFiles = (files: FileList | null) => {
    const nextFile = files?.[0];

    if (!nextFile || !nextFile.type.startsWith("image/")) {
      return;
    }

    const sourceUrl = URL.createObjectURL(nextFile);
    convertRequestIdRef.current += 1;
    setIsConverting(false);
    setConvertError(null);
    setConvertedImageUrl(null);
    setSourceImageUrlSafely(sourceUrl);
    setTransparentImageUrlSafely(null);
    setRemoveBgError(null);
    setUploadedFile(nextFile);

    if (transparentBackground) {
      void runBackgroundRemoval(nextFile);
    } else {
      void runPixelArtConversion(sourceUrl, { preserveTransparentEdges: false });
    }
  };

  const handleTransparentBackgroundChange = (checked: boolean) => {
    setTransparentBackground(checked);
    setRemoveBgError(null);

    if (!checked) {
      removeRequestIdRef.current += 1;
      setIsRemovingBackground(false);
      setTransparentImageUrlSafely(null);

      if (sourceImageUrlRef.current) {
        void runPixelArtConversion(sourceImageUrlRef.current, {
          preserveTransparentEdges: false,
        });
      }
      return;
    }

    if (uploadedFile) {
      void runBackgroundRemoval(uploadedFile);
    }
  };

  const handleConvertClick = () => {
    if (!baseImageUrl || (transparentBackground && isRemovingBackground)) {
      return;
    }

    void runPixelArtConversion(baseImageUrl, {
      preserveTransparentEdges: transparentBackground && !!transparentImageUrl,
    });
  };

  const handleDownload = () => {
    const downloadTarget = previewConvertedImageUrl;

    if (!downloadTarget) {
      return;
    }

    const link = document.createElement("a");
    link.href = downloadTarget;
    link.download =
      transparentBackground && transparentImageUrl
        ? "pixel-art-transparent.png"
        : "pixel-art-image.png";
    link.click();
  };

  return (
    <div className="min-h-full bg-gradient-to-br from-slate-100 to-slate-200 px-4 py-6 text-slate-900 sm:px-6 lg:px-8">
      <div className="mx-auto flex w-full max-w-7xl flex-col gap-6">
        <header className="rounded-2xl border border-white/70 bg-white/80 px-6 py-5 shadow-sm backdrop-blur">
          <h1 className="text-2xl font-bold tracking-tight sm:text-3xl">
            Pixel Art Maker
          </h1>
        </header>

        <main className="grid gap-6 lg:grid-cols-[minmax(300px,380px)_1fr]">
          <section className="space-y-5 rounded-2xl border border-white/70 bg-white p-5 shadow-sm">
            <button
              type="button"
              className={`w-full rounded-xl border-2 border-dashed p-6 text-left transition ${
                isDragging
                  ? "border-indigo-500 bg-indigo-50"
                  : "border-slate-300 bg-slate-50 hover:border-indigo-400 hover:bg-indigo-50/50"
              }`}
              onClick={() => fileInputRef.current?.click()}
              onDragEnter={(event) => {
                event.preventDefault();
                setIsDragging(true);
              }}
              onDragOver={(event) => {
                event.preventDefault();
                setIsDragging(true);
              }}
              onDragLeave={(event) => {
                event.preventDefault();
                setIsDragging(false);
              }}
              onDrop={(event) => {
                event.preventDefault();
                setIsDragging(false);
                handleFiles(event.dataTransfer.files);
              }}
            >
              <input
                ref={fileInputRef}
                type="file"
                accept="image/*"
                className="hidden"
                onChange={(event) => handleFiles(event.target.files)}
              />
              <p className="text-sm font-semibold text-slate-900">
                画像をドラッグ＆ドロップ
              </p>
              <p className="mt-1 text-sm text-slate-600">
                またはクリックして画像をアップロード
              </p>
              <p className="mt-4 text-xs text-slate-500">
                PNG / JPG / GIF を想定
              </p>
            </button>

            <div className="space-y-5 rounded-xl border border-slate-200 bg-slate-50 p-4">
              <div>
                <div className="flex items-center justify-between">
                  <label
                    htmlFor="dot-size"
                    className="text-sm font-medium text-slate-700"
                  >
                    ドットの粗さ
                  </label>
                  <span className="rounded-full bg-indigo-100 px-2 py-0.5 text-xs font-semibold text-indigo-700">
                    {dotSize}px
                  </span>
                </div>
                <input
                  id="dot-size"
                  type="range"
                  min={0}
                  max={DOT_SIZES.length - 1}
                  step={1}
                  value={dotSizeIndex}
                  onChange={(event) => setDotSizeIndex(Number(event.target.value))}
                  className="mt-3 w-full accent-indigo-600"
                />
                <div className="mt-2 grid grid-cols-4 text-center text-xs text-slate-500">
                  {DOT_SIZES.map((size) => (
                    <span key={size}>{size}px</span>
                  ))}
                </div>
              </div>

              <div>
                <label
                  htmlFor="palette"
                  className="text-sm font-medium text-slate-700"
                >
                  カラーパレット
                </label>
                <select
                  id="palette"
                  value={palette}
                  onChange={(event) =>
                    setPalette(event.target.value as PaletteValue)
                  }
                  className="mt-2 w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm shadow-sm outline-none transition focus:border-indigo-500 focus:ring-2 focus:ring-indigo-200"
                >
                  {PALETTES.map((option) => (
                    <option key={option.value} value={option.value}>
                      {option.label}
                    </option>
                  ))}
                </select>
              </div>

              <label className="flex items-center gap-3 text-sm text-slate-700">
                <input
                  type="checkbox"
                  checked={transparentBackground}
                  onChange={(event) =>
                    handleTransparentBackgroundChange(event.target.checked)
                  }
                  className="h-4 w-4 rounded border-slate-300 accent-indigo-600"
                />
                背景を透過する
              </label>

              <button
                type="button"
                disabled={!baseImageUrl || isConverting || isRemovingBackground}
                onClick={handleConvertClick}
                className="w-full rounded-lg border border-indigo-300 bg-white px-4 py-2.5 text-sm font-semibold text-indigo-700 shadow-sm transition hover:bg-indigo-50 disabled:cursor-not-allowed disabled:border-slate-300 disabled:text-slate-400"
              >
                {isConverting ? "画像を変換中..." : "画像を変換"}
              </button>

              <button
                type="button"
                disabled={!previewConvertedImageUrl || isRemovingBackground || isConverting}
                onClick={handleDownload}
                className="w-full rounded-lg bg-indigo-600 px-4 py-2.5 text-sm font-semibold text-white shadow-sm transition hover:bg-indigo-500 disabled:cursor-not-allowed disabled:bg-slate-300"
              >
                画像をダウンロード
              </button>
            </div>
          </section>

          <section className="rounded-2xl border border-white/70 bg-white p-5 shadow-sm">
            <div className="mb-4 flex items-center justify-between">
              <h2 className="text-lg font-semibold text-slate-900">プレビュー</h2>
              <div className="rounded-lg bg-slate-100 p-1 text-xs font-medium">
                <button
                  type="button"
                  onClick={() => setPreviewMode("side-by-side")}
                  className={`rounded-md px-3 py-1.5 transition ${
                    previewMode === "side-by-side"
                      ? "bg-white text-slate-900 shadow-sm"
                      : "text-slate-600"
                  }`}
                >
                  並べて表示
                </button>
                <button
                  type="button"
                  onClick={() => setPreviewMode("toggle")}
                  className={`rounded-md px-3 py-1.5 transition ${
                    previewMode === "toggle"
                      ? "bg-white text-slate-900 shadow-sm"
                      : "text-slate-600"
                  }`}
                >
                  切り替え表示
                </button>
              </div>
            </div>

            {removeBgError ? (
              <p className="mb-4 rounded-lg border border-rose-200 bg-rose-50 px-3 py-2 text-sm text-rose-700">
                {removeBgError}
              </p>
            ) : null}
            {convertError ? (
              <p className="mb-4 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-800">
                {convertError}
              </p>
            ) : null}

            {sourceImageUrl ? (
              previewMode === "side-by-side" ? (
                <div className="grid gap-4 md:grid-cols-2">
                  <div className="overflow-hidden rounded-xl border border-slate-200">
                    <p className="border-b border-slate-200 bg-slate-50 px-3 py-2 text-sm font-medium text-slate-700">
                      元画像
                    </p>
                    <div className="relative h-72 w-full bg-slate-100 p-3">
                      <Image
                        src={sourceImageUrl}
                        alt="アップロードした元画像"
                        fill
                        unoptimized
                        className="object-contain p-3"
                      />
                    </div>
                  </div>
                  <div className="overflow-hidden rounded-xl border border-slate-200">
                    <p className="border-b border-slate-200 bg-slate-50 px-3 py-2 text-sm font-medium text-slate-700">
                      変換後
                    </p>
                    <div className="relative">
                      <div className="relative h-72 w-full bg-slate-100 p-3">
                        <Image
                          src={previewConvertedImageUrl ?? sourceImageUrl}
                          alt="変換後画像"
                          fill
                          unoptimized
                          className="object-contain p-3 [image-rendering:pixelated]"
                        />
                      </div>
                      {isRemovingBackground || isConverting ? (
                        <div className="absolute inset-0 z-10 flex flex-col items-center justify-center gap-3 bg-slate-950/60 text-white">
                          <span className="h-8 w-8 animate-spin rounded-full border-4 border-white/30 border-t-white" />
                          <p className="text-sm font-medium">
                            {isRemovingBackground ? "背景を処理中..." : "画像を変換中..."}
                          </p>
                        </div>
                      ) : null}
                      <div className="absolute bottom-3 left-3 rounded-md bg-slate-900/80 px-2 py-1 text-xs text-white">
                        {dotSize}px /{" "}
                        {PALETTES.find((item) => item.value === palette)?.label} /{" "}
                        {transparentBackground ? "透過ON" : "透過OFF"}
                      </div>
                    </div>
                  </div>
                </div>
              ) : (
                <div className="space-y-3">
                  <div className="inline-flex rounded-lg bg-slate-100 p-1 text-sm font-medium">
                    <button
                      type="button"
                      onClick={() => setPreviewTab("original")}
                      className={`rounded-md px-3 py-1.5 transition ${
                        previewTab === "original"
                          ? "bg-white text-slate-900 shadow-sm"
                          : "text-slate-600"
                      }`}
                    >
                      元画像
                    </button>
                    <button
                      type="button"
                      onClick={() => setPreviewTab("converted")}
                      className={`rounded-md px-3 py-1.5 transition ${
                        previewTab === "converted"
                          ? "bg-white text-slate-900 shadow-sm"
                          : "text-slate-600"
                      }`}
                    >
                      変換後
                    </button>
                  </div>
                  <div className="overflow-hidden rounded-xl border border-slate-200">
                    <div className="relative h-[420px] w-full bg-slate-100 p-4">
                      <Image
                        src={
                          previewTab === "original"
                            ? sourceImageUrl
                            : previewConvertedImageUrl ?? sourceImageUrl
                        }
                        alt={
                          previewTab === "original"
                            ? "アップロードした元画像"
                            : "変換後画像"
                        }
                        fill
                        unoptimized
                        className={`object-contain p-4 ${
                          previewTab === "converted" ? "[image-rendering:pixelated]" : ""
                        }`}
                      />
                      {previewTab === "converted" &&
                      (isRemovingBackground || isConverting) ? (
                        <div className="absolute inset-0 z-10 flex flex-col items-center justify-center gap-3 bg-slate-950/60 text-white">
                          <span className="h-8 w-8 animate-spin rounded-full border-4 border-white/30 border-t-white" />
                          <p className="text-sm font-medium">
                            {isRemovingBackground ? "背景を処理中..." : "画像を変換中..."}
                          </p>
                        </div>
                      ) : null}
                    </div>
                  </div>
                </div>
              )
            ) : (
              <div className="flex h-[420px] items-center justify-center rounded-xl border border-dashed border-slate-300 bg-slate-50 px-6 text-center text-sm text-slate-500">
                画像をアップロードすると、元画像と変換後画像のプレビューが表示されます。
              </div>
            )}
          </section>
        </main>
      </div>
    </div>
  );
}
