import { BlobError, BlobNotFoundError, get, head } from "@vercel/blob";
import type { IncomingMessage, ServerResponse } from "node:http";
import { Readable } from "node:stream";

const INSTALLER_PATHNAME_ENV = "SIDESTREAM_INSTALLER_BLOB_PATHNAME";
const DEFAULT_CONTENT_TYPE = "application/octet-stream";

type DownloadRequest = IncomingMessage & {
  method?: string;
};

export default async function handler(
  request: DownloadRequest,
  response: ServerResponse,
) {
  const method = (request.method || "GET").toUpperCase();

  if (method !== "GET" && method !== "HEAD") {
    response.setHeader("Allow", "GET, HEAD");
    return sendText(response, 405, "Method not allowed");
  }

  const pathname = process.env[INSTALLER_PATHNAME_ENV]?.trim();
  if (!pathname) {
    return sendJson(response, 500, {
      error: `Missing ${INSTALLER_PATHNAME_ENV}`,
    });
  }

  try {
    if (method === "HEAD") {
      const metadata = await head(pathname);
      setDownloadHeaders(response, {
        contentType: metadata.contentType,
        etag: metadata.etag,
        filename: filenameFromPathname(pathname),
        size: metadata.size,
      });
      response.statusCode = 200;
      response.end();
      return;
    }

    const blob = await get(pathname, {
      access: "private",
      ifNoneMatch: headerValue(request.headers["if-none-match"]),
    });

    if (!blob) {
      return sendText(response, 404, "Installer not found");
    }

    if (blob.statusCode === 304) {
      response.statusCode = 304;
      response.end();
      return;
    }

    setDownloadHeaders(response, {
      contentType: blob.blob.contentType,
      etag: blob.blob.etag,
      filename: filenameFromPathname(pathname),
      size: blob.blob.size,
    });

    await pipeBlobStream(blob.stream, response);
  } catch (error) {
    if (error instanceof BlobNotFoundError) {
      return sendText(response, 404, "Installer not found");
    }

    if (error instanceof BlobError) {
      const payload = {
        error: "Blob download is not configured correctly",
      };

      if (process.env.VERCEL_ENV === "development") {
        Object.assign(payload, { message: error.message });
      }

      return sendJson(response, 500, payload);
    }

    throw error;
  }
}

function setDownloadHeaders(
  response: ServerResponse,
  options: {
    contentType?: string | null;
    etag?: string;
    filename: string;
    size?: number | null;
  },
) {
  response.setHeader("Cache-Control", "private, no-cache, max-age=0, must-revalidate");
  response.setHeader("Content-Disposition", `attachment; filename="${options.filename}"`);
  response.setHeader("Content-Type", options.contentType || DEFAULT_CONTENT_TYPE);
  response.setHeader("X-Content-Type-Options", "nosniff");

  if (typeof options.size === "number") {
    response.setHeader("Content-Length", String(options.size));
  }

  if (options.etag) {
    response.setHeader("ETag", options.etag);
  }
}

function filenameFromPathname(pathname: string) {
  const filename = pathname.split("/").filter(Boolean).pop() || "Sidestream-Installer.dmg";
  return filename.replace(/["\\\r\n]/g, "_");
}

function headerValue(value: string | string[] | undefined) {
  return Array.isArray(value) ? value[0] : value;
}

function sendJson(
  response: ServerResponse,
  statusCode: number,
  payload: Record<string, string>,
) {
  response.statusCode = statusCode;
  response.setHeader("Content-Type", "application/json; charset=utf-8");
  response.setHeader("Cache-Control", "no-store");
  response.end(JSON.stringify(payload));
}

function sendText(response: ServerResponse, statusCode: number, message: string) {
  response.statusCode = statusCode;
  response.setHeader("Content-Type", "text/plain; charset=utf-8");
  response.setHeader("Cache-Control", "no-store");
  response.end(message);
}

async function pipeBlobStream(
  stream: ReadableStream<Uint8Array>,
  response: ServerResponse,
) {
  const nodeStream = Readable.fromWeb(stream);

  await new Promise<void>((resolve, reject) => {
    nodeStream.once("error", reject);
    response.once("finish", resolve);
    nodeStream.pipe(response);
  });
}
