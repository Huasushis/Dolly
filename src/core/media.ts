import { randomUUID } from "crypto";
import { existsSync, mkdirSync } from "fs";
import { readFile, writeFile, unlink } from "fs/promises";
import path from "path";
import sharp from "sharp";
import type { Media } from "./types.js";
import { materializeCropBounds, type Rect } from "./block-content.js";

// ─── OSS Configuration ───────────────────────────────────────────────────────

export interface OSSConfig {
  accessKeyId: string;
  accessKeySecret: string;
  endpoint: string;
  bucket: string;
  /** Public URL prefix for generating accessible URLs (e.g. https://bucket.oss-cn-hangzhou.aliyuncs.com) */
  publicUrlPrefix?: string;
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

const MIME_EXT: Record<string, string> = {
  "image/png": ".png",
  "image/jpeg": ".jpg",
  "image/gif": ".gif",
  "image/webp": ".webp",
  "audio/mpeg": ".mp3",
  "audio/wav": ".wav",
  "video/mp4": ".mp4",
  "application/pdf": ".pdf",
  "text/plain": ".txt",
};

function getExt(mimeType: string): string {
  return MIME_EXT[mimeType] ?? ".bin";
}

function isBase64(str: string): boolean {
  return str.startsWith("data:") || /^[A-Za-z0-9+/=]{100,}$/.test(str);
}

function isUrl(str: string): boolean {
  return str.startsWith("http://") || str.startsWith("https://");
}

function isFilePath(str: string): boolean {
  return str.startsWith("file://") || str.startsWith("/") || /^[A-Z]:\\/i.test(str);
}

function isImageMime(mimeType: string): boolean {
  return mimeType.startsWith("image/");
}

// ─── MediaManager ────────────────────────────────────────────────────────────

export class MediaManager {
  private mediaDir: string;
  private store = new Map<string, Media>();
  private cleanupTimer: ReturnType<typeof setInterval> | null = null;
  private ossConfig: OSSConfig | null = null;
  private ossClient: any = null;

  constructor(mediaDir: string, ossConfig?: OSSConfig) {
    this.mediaDir = mediaDir;
    if (!existsSync(this.mediaDir)) {
      mkdirSync(this.mediaDir, { recursive: true });
    }
    if (ossConfig) {
      this.ossConfig = ossConfig;
    }
  }

  /** Lazily initialise the OSS client */
  private async getOSSClient(): Promise<any> {
    if (!this.ossConfig) return null;
    if (this.ossClient) return this.ossClient;
    const OSS = (await import("ali-oss")).default;
    this.ossClient = new OSS({
      accessKeyId: this.ossConfig.accessKeyId,
      accessKeySecret: this.ossConfig.accessKeySecret,
      endpoint: this.ossConfig.endpoint,
      bucket: this.ossConfig.bucket,
    });
    return this.ossClient;
  }

  /** Build the public URL for an OSS object key */
  private ossPublicUrl(objectKey: string): string {
    if (this.ossConfig?.publicUrlPrefix) {
      return `${this.ossConfig.publicUrlPrefix.replace(/\/$/, "")}/${objectKey}`;
    }
    // Fallback: construct from endpoint + bucket
    const { endpoint, bucket } = this.ossConfig!;
    const host = endpoint.replace(/^https?:\/\//, "").replace(/\/$/, "");
    return `https://${bucket}.${host}/${objectKey}`;
  }

  /**
   * 注册媒体资源，支持 Buffer / base64 / URL / file://
   * G4: 自动提取图片 width/height 元数据
   * G3: 如果启用 OSS，上传到 OSS
   * @returns mediaId
   */
  async register(source: Buffer | string, mimeType: string): Promise<string> {
    const id = randomUUID().replace(/-/g, "");
    const ext = getExt(mimeType);
    const localPath = path.join(this.mediaDir, `${id}${ext}`);

    let data: Buffer;

    if (Buffer.isBuffer(source)) {
      data = source;
    } else if (typeof source === "string") {
      if (isUrl(source)) {
        const resp = await fetch(source);
        if (!resp.ok) throw new Error(`Failed to download: ${source} (${resp.status})`);
        const arrayBuf = await resp.arrayBuffer();
        data = Buffer.from(arrayBuf);
      } else if (source.startsWith("file://")) {
        const filePath = source.slice(7);
        data = await readFile(filePath);
      } else if (isFilePath(source)) {
        data = await readFile(source);
      } else if (isBase64(source)) {
        // data URI or raw base64
        const b64 = source.startsWith("data:") ? source.split(",")[1] : source;
        data = Buffer.from(b64, "base64");
      } else {
        throw new Error(`Unrecognized source format: ${source.slice(0, 50)}`);
      }
    } else {
      throw new Error("source must be Buffer or string");
    }

    await writeFile(localPath, data);

    const media: Media = {
      id,
      mimeType,
      localPath,
      size: data.length,
      createdAt: Date.now(),
      refCount: 1,
    };

    // G4: Extract image metadata (width/height)
    if (isImageMime(mimeType)) {
      try {
        const meta = await sharp(data).metadata();
        if (meta.width) media.width = meta.width;
        if (meta.height) media.height = meta.height;
      } catch {
        // Non-fatal: metadata extraction failure shouldn't block registration
      }
    }
    // G4: Audio/video duration — TODO: integrate ffprobe or file header parsing

    // G3: Upload to OSS if configured
    if (this.ossConfig) {
      try {
        const client = await this.getOSSClient();
        const objectKey = `media/${id}${ext}`;
        await client.put(objectKey, data);
        media.ossObjectKey = objectKey;
        media.url = this.ossPublicUrl(objectKey);
      } catch {
        // Non-fatal: OSS upload failure doesn't block local registration
      }
    }

    this.store.set(id, media);
    return id;
  }

  /**
   * 按需获取媒体内容
   * G3: 如果启用 OSS 且 format="url"，返回 OSS 公开 URL
   */
  async get(id: string, format: "buffer" | "base64" | "url" = "buffer"): Promise<Buffer | string> {
    const media = this.store.get(id);
    if (!media) throw new Error(`Media not found: ${id}`);

    switch (format) {
      case "url":
        // G3: Prefer OSS URL if available
        if (media.url) return media.url;
        if (!media.localPath) throw new Error(`Media has no local file or URL: ${id}`);
        return media.localPath;
      case "buffer": {
        if (!media.localPath) throw new Error(`Media has no local file: ${id}`);
        return readFile(media.localPath);
      }
      case "base64": {
        if (!media.localPath) throw new Error(`Media has no local file: ${id}`);
        const buf = await readFile(media.localPath);
        return `data:${media.mimeType};base64,${buf.toString("base64")}`;
      }
    }
  }

  /**
   * 图片裁剪
   * - 如果启用 OSS 且图片已有 OSS URL，使用 OSS URL 参数裁剪（无需本地处理）
   * - 否则使用 sharp 本地裁剪并注册为新 media 对象
   *
   * The crop is the versioned fixed-point `image_rect_v1` handled through the
   * one shared materializer (`materializeCropBounds`): left/top floor, right/
   * bottom ceil, clamped to the inspected upright display dimensions. Returns
   * a new mediaId for the cropped image.
   */
  async crop(id: string, rect: Rect): Promise<string> {
    const media = this.store.get(id);
    if (!media) throw new Error(`Media not found: ${id}`);
    if (!isImageMime(media.mimeType)) throw new Error(`Cannot crop non-image media: ${id}`);

    // Strategy 1: OSS URL parameter crop (no local processing needed)
    if (this.ossConfig && media.ossObjectKey && media.width && media.height) {
      const bounds = materializeCropBounds(rect, media.width, media.height);
      if (bounds === null) {
        throw new Error(`Invalid media caveat: fixed-point crop does not select a pixel on ${media.width}x${media.height}`);
      }
      const px = bounds.left;
      const py = bounds.top;
      const pw = bounds.right - bounds.left;
      const ph = bounds.bottom - bounds.top;
      const ossCropUrl = `${this.ossPublicUrl(media.ossObjectKey)}?x-oss-process=image/crop,x_${px},y_${py},w_${pw},h_${ph}`;

      // Register as new media with the OSS crop URL
      const newId = randomUUID().replace(/-/g, "");
      const newMedia: Media = {
        id: newId,
        mimeType: media.mimeType,
        url: ossCropUrl,
        ossObjectKey: `${media.ossObjectKey}?crop=${px}_${py}_${pw}_${ph}`,
        width: pw,
        height: ph,
        size: 0, // Unknown until accessed
        createdAt: Date.now(),
        refCount: 1,
      };
      this.store.set(newId, newMedia);
      return newId;
    }

    // Strategy 2: Local sharp crop
    if (!media.localPath) throw new Error(`Media has no local file for cropping: ${id}`);
    const inputData = await readFile(media.localPath);
    const meta = await sharp(inputData).metadata();
    const width = meta.width ?? 0;
    const height = meta.height ?? 0;
    if (width === 0 || height === 0) throw new Error(`Cannot determine image dimensions: ${id}`);

    const bounds = materializeCropBounds(rect, width, height);
    if (bounds === null) {
      throw new Error(`Invalid media caveat: fixed-point crop does not select a pixel on ${width}x${height}`);
    }
    const px = bounds.left;
    const py = bounds.top;
    const pw = bounds.right - bounds.left;
    const ph = bounds.bottom - bounds.top;

    const croppedBuf = await sharp(inputData)
      .extract({ left: px, top: py, width: pw, height: ph })
      .toBuffer();

    // Register cropped image as new media
    const newId = await this.register(croppedBuf, media.mimeType);
    return newId;
  }

  /**
   * 减少引用计数
   */
  release(id: string): void {
    const media = this.store.get(id);
    if (!media) return;
    media.refCount = Math.max(0, media.refCount - 1);
  }

  /**
   * 增加引用计数
   */
  acquire(id: string): void {
    const media = this.store.get(id);
    if (!media) return;
    media.refCount += 1;
  }

  /**
   * 删除本地文件 + G3: 删除 OSS 对象
   */
  async destroy(id: string): Promise<void> {
    const media = this.store.get(id);
    if (!media) return;

    if (media.localPath && existsSync(media.localPath)) {
      await unlink(media.localPath);
    }

    // G3: Delete OSS object if exists
    if (this.ossConfig && media.ossObjectKey) {
      try {
        const client = await this.getOSSClient();
        await client.delete(media.ossObjectKey);
      } catch {
        // Non-fatal: log but don't throw
      }
    }

    this.store.delete(id);
  }

  /**
   * 获取 Media 元信息
   */
  getMeta(id: string): Media | null {
    return this.store.get(id) ?? null;
  }

  /**
   * 启动后台清理：定期移除 refCount === 0 的 media
   */
  startCleanup(intervalMs = 60_000): void {
    if (this.cleanupTimer) return;
    this.cleanupTimer = setInterval(async () => {
      for (const [id, media] of this.store) {
        if (media.refCount === 0) {
          await this.destroy(id);
        }
      }
    }, intervalMs);
    // 允许 Node 进程在只剩此 timer 时退出
    this.cleanupTimer.unref?.();
  }

  /**
   * 停止后台清理
   */
  stop(): void {
    if (this.cleanupTimer) {
      clearInterval(this.cleanupTimer);
      this.cleanupTimer = null;
    }
  }
}
