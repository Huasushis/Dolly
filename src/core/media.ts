import { randomUUID } from "crypto";
import { existsSync, mkdirSync } from "fs";
import { readFile, writeFile, unlink } from "fs/promises";
import path from "path";
import type { Media, Rect } from "./types.js";

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

export class MediaManager {
  private mediaDir: string;
  private store = new Map<string, Media>();
  private cleanupTimer: ReturnType<typeof setInterval> | null = null;

  constructor(mediaDir: string) {
    this.mediaDir = mediaDir;
    if (!existsSync(this.mediaDir)) {
      mkdirSync(this.mediaDir, { recursive: true });
    }
  }

  /**
   * 注册媒体资源，支持 Buffer / base64 / URL / file://
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

    this.store.set(id, media);
    return id;
  }

  /**
   * 按需获取媒体内容
   */
  async get(id: string, format: "buffer" | "base64" | "url" = "buffer"): Promise<Buffer | string> {
    const media = this.store.get(id);
    if (!media) throw new Error(`Media not found: ${id}`);
    if (!media.localPath) throw new Error(`Media has no local file: ${id}`);

    const buf = await readFile(media.localPath);

    switch (format) {
      case "buffer":
        return buf;
      case "base64":
        return `data:${media.mimeType};base64,${buf.toString("base64")}`;
      case "url":
        return media.url ?? media.localPath;
    }
  }

  /**
   * 图片裁剪 — 占位实现，后续引入 sharp
   */
  async crop(_id: string, _rect: Rect): Promise<string> {
    throw new Error("crop not implemented: sharp integration pending");
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
   * 删除本地文件 + 标记 OSS 待删除
   */
  async destroy(id: string): Promise<void> {
    const media = this.store.get(id);
    if (!media) return;

    if (media.localPath && existsSync(media.localPath)) {
      await unlink(media.localPath);
    }

    // TODO: 如果有 ossObjectKey，标记需要删除 OSS 对象（暂未实现）

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
