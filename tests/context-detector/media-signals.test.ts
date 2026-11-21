// Integration tests: POST /api/context-detector/media-signals (ADR-001, ADR-002).
// Real route handler, real multipart parsing, real image fixtures.
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, it, mock } from "node:test";
import { NextRequest } from "next/server";
import { POST } from "@/app/api/(client)/context-detector/media-signals/route";
import { MAX_IMAGE_BYTES } from "@/lib/context-detector/media";
import type { MediaSignalsResponse } from "@/lib/context-detector/types";
import {
    BASE_URL,
    fixture,
    imageBlob,
    multipartRequest,
    readJson,
    resetEnv,
    type FormField,
} from "../helpers";

type ErrorBody = { message: string; code: string };

const send = async (fields: FormField[]) =>
    readJson<MediaSignalsResponse & Partial<ErrorBody>>(await POST(multipartRequest(fields)));

const signalCodes = (body: MediaSignalsResponse): string[] => body.signals.map((signal) => signal.code);

beforeEach(() => {
    resetEnv();
    mock.method(console, "error", () => undefined);
});

afterEach(() => mock.restoreAll());

describe("Valid images", () => {
    it("reads format, dimensions and EXIF of a JPEG, and never returns GPS coordinates", async () => {
        const { status, body } = await send([["file", imageBlob("camera-gps.jpg", "image/jpeg"), "photo.jpg"]]);

        assert.equal(status, 200);
        assert.equal(body.mime_type_detected, "image/jpeg");
        assert.equal(body.width, 1024);
        assert.equal(body.height, 768);
        assert.equal(body.exif?.make, "Nikon");
        assert.equal(body.exif?.date_time_original, "2021:03:14 09:26:53");
        assert.equal(body.exif?.gps_present, true);
        assert.deepEqual(Object.keys(body.exif ?? {}).filter((key) => /lat|lon|coord/i.test(key)), []);
        assert.ok(signalCodes(body).includes("gps_present"));
    });

    it("flags image-generator text fields in a PNG as a clue only", async () => {
        const { status, body } = await send([["file", imageBlob("generated.png", "image/png"), "image.png"]]);

        assert.equal(status, 200);
        assert.equal(body.mime_type_detected, "image/png");
        assert.deepEqual(body.provenance_markers, ["generation_parameters"]);
        assert.ok(signalCodes(body).includes("generation_parameters"));
    });

    it("reads a lossless WebP", async () => {
        const { status, body } = await send([["file", imageBlob("lossless.webp", "image/webp"), "a.webp"]]);
        assert.equal(status, 200);
        assert.equal(body.mime_type_detected, "image/webp");
        assert.equal(body.width, 640);
        assert.equal(body.height, 360);
    });

    it("always includes the disclaimer that signals do not prove authenticity (PRODUCT_SCOPE §7)", async () => {
        const { body } = await send([["file", imageBlob("plain.jpg", "image/jpeg"), "a.jpg"]]);
        assert.match(body.disclaimer, /ne prouvent pas l'authenticité/);
        assert.match(body.disclaimer, /deepfakes/);
        assert.equal("ocr" in body, false, "no OCR unless requested");
    });

    it("detects the real format when the name and declared type lie", async () => {
        const png = new Blob([fixture("generated.png")], { type: "image/jpeg" });
        const { status, body } = await send([["file", png, "photo.jpg"]]);

        assert.equal(status, 200);
        assert.equal(body.mime_type_declared, "image/jpeg");
        assert.equal(body.mime_type_detected, "image/png");
        assert.ok(signalCodes(body).includes("mime_mismatch"));
        assert.ok(signalCodes(body).includes("extension_mismatch"));
    });
});

describe("Invalid requests", () => {
    const cases: [name: string, fields: FormField[], status: number, code: string][] = [
        ["no file field", [["image", imageBlob("plain.jpg", "image/jpeg"), "a.jpg"]], 400, "FILE_REQUIRED"],
        ["file sent as text", [["file", "not a file"]], 400, "FILE_REQUIRED"],
        [
            "two files",
            [
                ["file", imageBlob("plain.jpg", "image/jpeg"), "a.jpg"],
                ["file", imageBlob("plain.jpg", "image/jpeg"), "b.jpg"],
            ],
            400,
            "TOO_MANY_FILES",
        ],
        ["empty file", [["file", new Blob([]), "empty.jpg"]], 400, "EMPTY_FILE"],
        ["GIF", [["file", imageBlob("anim.gif", "image/gif"), "a.gif"]], 415, "UNSUPPORTED_MEDIA_TYPE"],
        [
            "GIF renamed to .png",
            [["file", imageBlob("anim.gif", "image/png"), "a.png"]],
            415,
            "UNSUPPORTED_MEDIA_TYPE",
        ],
        ["truncated PNG", [["file", imageBlob("truncated.png", "image/png"), "t.png"]], 422, "UNREADABLE_IMAGE"],
        [
            "invalid ocr flag",
            [
                ["file", imageBlob("plain.jpg", "image/jpeg"), "a.jpg"],
                ["ocr", "maybe"],
            ],
            400,
            "INVALID_OCR_FLAG",
        ],
    ];

    for (const [name, fields, status, code] of cases) {
        it(`returns ${status} ${code} for ${name}`, async () => {
            const response = await send(fields);
            assert.equal(response.status, status);
            assert.equal(response.body.code, code);
            assert.equal(typeof response.body.message, "string");
        });
    }

    it("returns 415 MULTIPART_REQUIRED for a JSON body", async () => {
        const request = new NextRequest(`${BASE_URL}/api/context-detector/media-signals`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ file: "data:image/png;base64,AAAA" }),
        });
        const { status, body } = await readJson<ErrorBody>(await POST(request));
        assert.equal(status, 415);
        assert.equal(body.code, "MULTIPART_REQUIRED");
    });

    it("returns 400 INVALID_MULTIPART for a broken multipart body", async () => {
        const request = new NextRequest(`${BASE_URL}/api/context-detector/media-signals`, {
            method: "POST",
            headers: { "content-type": "multipart/form-data; boundary=xyz" },
            body: "--xyz\r\ngarbage",
        });
        const { status, body } = await readJson<ErrorBody>(await POST(request));
        assert.equal(status, 400);
        assert.equal(body.code, "INVALID_MULTIPART");
    });
});

describe("Oversized images", () => {
    // A valid PNG padded with zeros after its last chunk: still a readable image.
    const paddedPng = (size: number): Blob => {
        const bytes = new Uint8Array(size);
        bytes.set(fixture("generated.png"));
        return new Blob([bytes], { type: "image/png" });
    };

    it("accepts an image of exactly 4 MB", async () => {
        const { status, body } = await send([["file", paddedPng(MAX_IMAGE_BYTES), "max.png"]]);
        assert.equal(status, 200);
        assert.equal(body.size_bytes, MAX_IMAGE_BYTES);
    });

    it("rejects an image of 4 MB + 1 byte with 413", async () => {
        const { status, body } = await send([["file", paddedPng(MAX_IMAGE_BYTES + 1), "big.png"]]);
        assert.equal(status, 413);
        assert.equal(body.code, "FILE_TOO_LARGE");
    });

    it("rejects a 10 MB upload with 413", async () => {
        const { status, body } = await send([["file", paddedPng(10 * 1024 * 1024), "huge.png"]]);
        assert.equal(status, 413);
        assert.equal(body.code, "FILE_TOO_LARGE");
    });

    it("rejects from the Content-Length header before reading the body", async () => {
        const request = new NextRequest(`${BASE_URL}/api/context-detector/media-signals`, {
            method: "POST",
            headers: {
                "content-type": "multipart/form-data; boundary=x",
                "content-length": String(50 * 1024 * 1024),
            },
            body: "x",
        });
        const { status, body } = await readJson<ErrorBody>(await POST(request));

        assert.equal(status, 413);
        assert.equal(body.code, "FILE_TOO_LARGE");
        assert.equal(request.bodyUsed, false, "the body must not be read");
    });
});

describe("Local OCR (ocr=true, ADR-002)", () => {
    const fakeTesseract = () =>
        (globalThis as { __fakeTesseract?: Record<string, unknown> }).__fakeTesseract;

    it("returns the image text marked as local and indicative", async () => {
        // Language data already in the configured folder: nothing is read from node_modules.
        const langDir = mkdtempSync(path.join(os.tmpdir(), "micheck-ocr-"));
        for (const lang of ["fra", "eng"]) {
            writeFileSync(path.join(langDir, `${lang}.traineddata.gz`), "fake");
        }
        resetEnv({ CONTEXT_DETECTOR_OCR_LANG_DIR: langDir });
        (globalThis as { __fakeTesseract?: Record<string, unknown> }).__fakeTesseract = {
            text: "  URGENT :  nouvelle loi\r\n\n\n\nsur les espèces  ",
            confidence: 72,
            workers: 0,
        };

        try {
            const { status, body } = await send([
                ["file", imageBlob("plain.jpg", "image/jpeg"), "capture.jpg"],
                ["ocr", "true"],
            ]);

            assert.equal(status, 200);
            assert.equal(body.ocr?.status, "ok");
            assert.equal(body.ocr?.text, "URGENT : nouvelle loi\n\nsur les espèces");
            assert.equal(body.ocr?.quality, "medium");
            assert.equal(body.ocr?.provider.kind, "local");
            assert.equal(body.ocr?.provider.indicative, true);
            assert.deepEqual(fakeTesseract()?.langs, ["fra", "eng"]);
            assert.ok(signalCodes(body).length > 0, "signals are still returned");
            assert.equal((fakeTesseract()?.options as { langPath: string }).langPath, langDir);
        } finally {
            resetEnv();
        }
    });
});
